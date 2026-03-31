import * as pty from "node-pty";
import { resolve, join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
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

/**
 * Write function exposed after PTY child is ready.
 * Used by claudeLocalLauncher to inject mobile messages into the terminal.
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
    /** URL for HTTP-based thinking state (PTY mode, replaces fd 3) */
    thinkingUrl?: string,
    /** Called when the PTY child is ready, providing a write function for message injection */
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
        // Offline mode
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

    // Build args
    const args: string[] = [];

    if (!opts.hookSettingsPath) {
        const hasResumeInArgs = opts.claudeArgs?.includes('--resume') || opts.claudeArgs?.includes('-r');
        if (startFrom) {
            args.push('--resume', startFrom);
        } else if (!hasResumeInArgs && newSessionId) {
            args.push('--session-id', newSessionId);
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
        args.push(...opts.claudeArgs);
    }

    if (opts.hookSettingsPath) {
        args.push('--settings', opts.hookSettingsPath);
        logger.debug(`[ClaudeLocal] Using hook settings: ${opts.hookSettingsPath}`);
    }

    if (!claudeCliPath || !existsSync(claudeCliPath)) {
        throw new Error('Claude local launcher not found. Please ensure HAPPY_PROJECT_ROOT is set correctly for development.');
    }

    // Prepare environment
    const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        ...opts.claudeEnvVars,
    };

    // Set thinking URL for PTY mode (replaces fd 3)
    if (opts.thinkingUrl) {
        env.HAPPY_THINKING_URL = opts.thinkingUrl;
    }

    logger.debug(`[ClaudeLocal] Spawning PTY launcher: ${claudeCliPath}`);
    logger.debug(`[ClaudeLocal] Args: ${JSON.stringify(args)}`);

    // Spawn via PTY - provides real TTY to Claude Code, enables stdin injection
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    // TODO: sandbox support with PTY (currently sandbox wraps the command as a shell string)
    if (opts.sandboxConfig?.enabled && process.platform !== 'win32') {
        logger.warn('[ClaudeLocal] Sandbox with PTY mode is not yet supported; continuing without sandbox.');
    }

    const ptyProcess = pty.spawn('node', [claudeCliPath, ...args], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: opts.path,
        env,
    });

    // Forward PTY output to local terminal
    ptyProcess.onData((data: string) => {
        process.stdout.write(data);
    });

    // Forward local stdin to PTY
    const stdinHandler = (data: Buffer) => {
        ptyProcess.write(data.toString());
    };

    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on('data', stdinHandler);

    // Handle terminal resize
    const resizeHandler = () => {
        ptyProcess.resize(
            process.stdout.columns || 80,
            process.stdout.rows || 24
        );
    };
    process.stdout.on('resize', resizeHandler);

    // Expose write function for mobile message injection
    if (opts.onChildReady) {
        opts.onChildReady((data: string) => {
            ptyProcess.write(data);
        });
    }

    // Handle abort signal
    const abortHandler = () => {
        ptyProcess.kill();
    };
    if (opts.abort.aborted) {
        ptyProcess.kill();
    } else {
        opts.abort.addEventListener('abort', abortHandler, { once: true });
    }

    // Wait for PTY process to exit
    try {
        await new Promise<void>((resolve, reject) => {
            ptyProcess.onExit(({ exitCode, signal }) => {
                if (signal && opts.abort.aborted) {
                    // Normal termination due to abort
                    resolve();
                } else if (exitCode !== 0 && exitCode !== null) {
                    reject(new ExitCodeError(exitCode));
                } else {
                    resolve();
                }
            });
        });
    } finally {
        // Cleanup
        opts.abort.removeEventListener('abort', abortHandler);
        process.stdin.off('data', stdinHandler);
        process.stdout.off('resize', resizeHandler);
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
    }

    return effectiveSessionId;
}
