import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { logger } from "@/ui/logger";
import { claudeFindLastSession } from "./utils/claudeFindLastSession";
import { getProjectPath } from "./utils/path";
import { projectPath } from "@/projectPath";
import { systemPrompt } from "./utils/systemPrompt";
import type { SandboxConfig } from "@/persistence";
import { initializeSandbox, wrapCommand } from "@/sandbox/manager";

/**
 * Error thrown when the Claude process exits with a non-zero exit code.
 */
export class ExitCodeError extends Error {
    public readonly exitCode: number;

    constructor(exitCode: number) {
        super(`Process exited with code: ${exitCode}`);
        this.name = 'ExitCodeError';
        this.exitCode = exitCode;
    }
}

// Get Claude CLI path from project root
export const claudeCliPath = resolve(join(projectPath(), 'scripts', 'claude_local_launcher.cjs'))

function quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Write function exposed after child is ready.
 * Sends a message via HTTP to the launcher's inject server,
 * which pushes it into Claude's stdin.
 */
export type ChildWriter = (data: string) => void;

export async function claudeLocal(opts: {
    abort: AbortSignal,
    sessionId: string | null,
    mcpServers?: Record<string, any>,
    path: string,
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[],
    allowedTools?: string[],
    /** Path to temporary settings file with SessionStart hook (optional - for session tracking) */
    hookSettingsPath?: string,
    sandboxConfig?: SandboxConfig,
    /** URL for HTTP-based thinking state (replaces fd 3) */
    thinkingUrl?: string,
    /** Port for the inject server in the launcher (message injection) */
    injectPort?: number,
    /** Called when the child is ready, providing a write function for message injection */
    onChildReady?: (write: ChildWriter) => void,
}) {

    // Ensure project directory exists
    const projectDir = getProjectPath(opts.path);
    mkdirSync(projectDir, { recursive: true });

    // Check if claudeArgs contains --continue or --resume (user passed these flags)
    const hasContinueFlag = opts.claudeArgs?.includes('--continue');
    const hasResumeFlag = opts.claudeArgs?.includes('--resume');
    const hasUserSessionControl = hasContinueFlag || hasResumeFlag;

    // Determine if we have an existing session to resume
    let startFrom = opts.sessionId;

    // Helper to find and extract flag with optional value
    const extractFlag = (flags: string[], withValue: boolean = false): { found: boolean; value?: string } => {
        if (!opts.claudeArgs) return { found: false };

        for (const flag of flags) {
            const index = opts.claudeArgs.indexOf(flag);
            if (index !== -1) {
                if (withValue && index + 1 < opts.claudeArgs.length) {
                    const nextArg = opts.claudeArgs[index + 1];
                    if (!nextArg.startsWith('-')) {
                        const value = nextArg;
                        opts.claudeArgs = opts.claudeArgs.filter((_, i) => i !== index && i !== index + 1);
                        return { found: true, value };
                    }
                }
                if (!withValue) {
                    opts.claudeArgs = opts.claudeArgs.filter((_, i) => i !== index);
                    return { found: true };
                }
                return { found: false };
            }
        }
        return { found: false };
    };

    // 1. Check for --session-id <uuid>
    const sessionIdFlag = extractFlag(['--session-id'], true);
    if (sessionIdFlag.found && sessionIdFlag.value) {
        startFrom = null;
        logger.debug(`[ClaudeLocal] Using explicit --session-id: ${sessionIdFlag.value}`);
    }

    // 2. Check for --resume <id> / -r <id>
    if (!startFrom && !sessionIdFlag.value) {
        const resumeFlag = extractFlag(['--resume', '-r'], true);
        if (resumeFlag.found) {
            if (resumeFlag.value) {
                startFrom = resumeFlag.value;
                logger.debug(`[ClaudeLocal] Using provided session ID from --resume: ${startFrom}`);
            } else {
                const lastSession = claudeFindLastSession(opts.path);
                if (lastSession) {
                    startFrom = lastSession;
                    logger.debug(`[ClaudeLocal] --resume: Found last session: ${lastSession}`);
                }
            }
        }
    }

    // 3. Check for --continue / -c
    if (!startFrom && !sessionIdFlag.value) {
        const continueFlag = extractFlag(['--continue', '-c'], false);
        if (continueFlag.found) {
            const lastSession = claudeFindLastSession(opts.path);
            if (lastSession) {
                startFrom = lastSession;
                logger.debug(`[ClaudeLocal] --continue: Found last session: ${lastSession}`);
            }
        }
    }

    const explicitSessionId = sessionIdFlag.value || null;
    let newSessionId: string | null = null;
    let effectiveSessionId: string | null = startFrom;

    if (!opts.hookSettingsPath) {
        newSessionId = startFrom ? null : (explicitSessionId || randomUUID());
        effectiveSessionId = startFrom || newSessionId!;

        if (startFrom) {
            logger.debug(`[ClaudeLocal] Resuming session: ${startFrom}`);
            opts.onSessionFound(startFrom);
        } else if (explicitSessionId) {
            logger.debug(`[ClaudeLocal] Using explicit session ID: ${explicitSessionId}`);
            opts.onSessionFound(explicitSessionId);
        } else {
            logger.debug(`[ClaudeLocal] Generated new session ID: ${newSessionId}`);
            opts.onSessionFound(newSessionId!);
        }
    } else {
        if (startFrom) {
            logger.debug(`[ClaudeLocal] Will resume existing session: ${startFrom}`);
        } else if (hasUserSessionControl) {
            logger.debug(`[ClaudeLocal] User passed ${hasContinueFlag ? '--continue' : '--resume'} flag, session ID will be determined by hook`);
        } else {
            logger.debug(`[ClaudeLocal] Fresh start, session ID will be provided by hook`);
        }
    }

    // Thinking state
    let thinking = false;
    let stopThinkingTimeout: NodeJS.Timeout | null = null;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[ClaudeLocal] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    // Expose inject writer if injectPort is set
    if (opts.injectPort && opts.onChildReady) {
        const port = opts.injectPort;
        opts.onChildReady((message: string) => {
            const postData = message;
            const req = request({
                hostname: '127.0.0.1',
                port,
                path: '/inject',
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
            }, () => {});
            req.on('error', (err) => {
                logger.debug(`[ClaudeLocal] Inject request failed: ${err.message}`);
            });
            req.end(postData);
        });
    }

    // Spawn the process
    try {
        process.stdin.pause();
        await new Promise<void>((r, reject) => {
            const args: string[] = []

            if (!opts.hookSettingsPath) {
                const hasResumeFlag = opts.claudeArgs?.includes('--resume') || opts.claudeArgs?.includes('-r');
                if (startFrom) {
                    args.push('--resume', startFrom)
                } else if (!hasResumeFlag && newSessionId) {
                    args.push('--session-id', newSessionId)
                }
            } else {
                if (startFrom) {
                    args.push('--resume', startFrom);
                }
            }

            args.push('--append-system-prompt', systemPrompt);

            if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
                args.push('--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }));
            }

            if (opts.allowedTools && opts.allowedTools.length > 0) {
                args.push('--allowedTools', opts.allowedTools.join(','));
            }

            if (opts.claudeArgs) {
                args.push(...opts.claudeArgs)
            }

            if (opts.hookSettingsPath) {
                args.push('--settings', opts.hookSettingsPath);
                logger.debug(`[ClaudeLocal] Using hook settings: ${opts.hookSettingsPath}`);
            }

            if (!claudeCliPath || !existsSync(claudeCliPath)) {
                throw new Error('Claude local launcher not found. Please ensure HAPPY_PROJECT_ROOT is set correctly for development.');
            }

            const env: Record<string, string> = {
                ...process.env as Record<string, string>,
                ...opts.claudeEnvVars
            }

            // Pass inject port and thinking URL to the launcher
            if (opts.injectPort) {
                env.HAPPY_INJECT_PORT = String(opts.injectPort);
            }
            if (opts.thinkingUrl) {
                env.HAPPY_THINKING_URL = opts.thinkingUrl;
            }

            logger.debug(`[ClaudeLocal] Spawning launcher: ${claudeCliPath}`);
            logger.debug(`[ClaudeLocal] Args: ${JSON.stringify(args)}`);

            (async () => {
                let cleanupSandbox: (() => Promise<void>) | null = null;
                let spawnCommand: string | null = null;
                let spawnArgs: string[] = [claudeCliPath, ...args];
                let spawnWithShell = false;

                if (opts.sandboxConfig?.enabled) {
                    if (process.platform === 'win32') {
                        logger.warn('[ClaudeLocal] Sandbox is not supported on Windows; continuing without sandbox.');
                    } else {
                        try {
                            cleanupSandbox = await initializeSandbox(opts.sandboxConfig, opts.path);

                            if (!spawnArgs.includes('--dangerously-skip-permissions')) {
                                spawnArgs = [...spawnArgs, '--dangerously-skip-permissions'];
                            }

                            const fullCommand = [
                                'node',
                                ...spawnArgs.map((arg) => quoteShellArg(arg)),
                            ].join(' ');

                            spawnCommand = await wrapCommand(fullCommand);
                            spawnWithShell = true;

                            logger.info(
                                `[ClaudeLocal] Sandbox enabled: workspace=${opts.sandboxConfig.workspaceRoot ?? opts.path}, network=${opts.sandboxConfig.networkMode}`,
                            );
                        } catch (error) {
                            logger.warn('[ClaudeLocal] Failed to initialize sandbox; continuing without sandbox.', error);
                            cleanupSandbox = null;
                            spawnCommand = null;
                            spawnWithShell = false;
                            spawnArgs = [claudeCliPath, ...args];
                        }
                    }
                }

                // Use 'pipe' for fd 3 (thinking state) unless inject mode uses HTTP for thinking
                const stdio: any[] = ['inherit', 'inherit', 'inherit', opts.thinkingUrl ? 'ignore' : 'pipe'];

                const child = spawn(
                    spawnWithShell && spawnCommand ? spawnCommand : 'node',
                    spawnWithShell ? [] : spawnArgs,
                    {
                        stdio,
                        signal: opts.abort,
                        cwd: opts.path,
                        env,
                        shell: spawnWithShell,
                    },
                );

                // Listen to fd 3 for thinking state (when not using HTTP)
                if (!opts.thinkingUrl && child.stdio[3]) {
                    const rl = createInterface({
                        input: child.stdio[3] as any,
                        crlfDelay: Infinity
                    });

                    const activeFetches = new Map<number, { hostname: string, path: string, startTime: number }>();

                    rl.on('line', (line) => {
                        try {
                            const message = JSON.parse(line);

                            switch (message.type) {
                                case 'fetch-start':
                                    activeFetches.set(message.id, {
                                        hostname: message.hostname,
                                        path: message.path,
                                        startTime: message.timestamp
                                    });

                                    if (stopThinkingTimeout) {
                                        clearTimeout(stopThinkingTimeout);
                                        stopThinkingTimeout = null;
                                    }

                                    updateThinking(true);
                                    break;

                                case 'fetch-end':
                                    activeFetches.delete(message.id);

                                    if (activeFetches.size === 0 && thinking && !stopThinkingTimeout) {
                                        stopThinkingTimeout = setTimeout(() => {
                                            if (activeFetches.size === 0) {
                                                updateThinking(false);
                                            }
                                            stopThinkingTimeout = null;
                                        }, 500);
                                    }
                                    break;

                                default:
                                    logger.debug(`[ClaudeLocal] Unknown message type: ${message.type}`);
                            }
                        } catch (e) {
                            logger.debug(`[ClaudeLocal] Non-JSON line from fd3: ${line}`);
                        }
                    });

                    rl.on('error', (err) => {
                        console.error('Error reading from fd 3:', err);
                    });

                    child.on('exit', () => {
                        if (stopThinkingTimeout) {
                            clearTimeout(stopThinkingTimeout);
                        }
                        updateThinking(false);
                    });
                }
                child.on('error', (error) => {
                    // Ignore
                });
                child.on('exit', async (code, signal) => {
                    if (cleanupSandbox) {
                        try {
                            await cleanupSandbox();
                        } catch (error) {
                            logger.warn('[ClaudeLocal] Failed to reset sandbox after session exit.', error);
                        }
                    }

                    if (signal === 'SIGTERM' && opts.abort.aborted) {
                        r();
                    } else if (signal) {
                        reject(new Error(`Process terminated with signal: ${signal}`));
                    } else if (code !== 0 && code !== null) {
                        reject(new ExitCodeError(code));
                    } else {
                        r();
                    }
                });
            })().catch(reject);
        });
    } finally {
        process.stdin.resume();
        if (stopThinkingTimeout) {
            clearTimeout(stopThinkingTimeout);
            stopThinkingTimeout = null;
        }
        updateThinking(false);
    }

    return effectiveSessionId;
}
