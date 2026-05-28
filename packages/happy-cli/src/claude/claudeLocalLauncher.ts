import { logger } from "@/ui/logger";
import { claudeLocal, ExitCodeError, ChildWriter } from "./claudeLocal";
import { Session } from "./session";
import { Future } from "@/utils/future";
import { createSessionScanner } from "./utils/sessionScanner";

export type LauncherResult = { type: 'switch' } | { type: 'exit', code: number };

interface PendingQuestion {
    header: string;
    options: string[];
}

/**
 * Convert a mobile AskUserQuestion response into PTY key sequences.
 * Claude Code's TUI selector uses arrow keys + Enter, not text input.
 * Returns null if the message doesn't match any pending question.
 */
function toAskUserQuestionKeySequence(message: string, questions: PendingQuestion[]): string | null {
    const trimmed = message.trim();
    const ARROW_DOWN = '\x1b[B';

    // Match "header: label" format from AskUserQuestionView
    for (const question of questions) {
        for (let i = 0; i < question.options.length; i++) {
            if (trimmed === `${question.header}: ${question.options[i]}`) {
                return ARROW_DOWN.repeat(i) + '\r';
            }
        }
    }

    // Match numeric selection (e.g. "1", "2")
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && trimmed === String(num) && questions.length > 0) {
        const firstQuestion = questions[0];
        if (num >= 1 && num <= firstQuestion.options.length) {
            return ARROW_DOWN.repeat(num - 1) + '\r';
        }
    }

    return null;
}

export async function claudeLocalLauncher(session: Session): Promise<LauncherResult> {

    // Track pending AskUserQuestion options for PTY key sequence injection
    let pendingAskUserQuestion: PendingQuestion[] | null = null;

    // Create scanner
    const scanner = await createSessionScanner({
        sessionId: session.sessionId,
        workingDirectory: session.path,
        onMessage: (message) => {
            // Block SDK summary messages - we generate our own
            if (message.type !== 'summary') {
                session.client.sendClaudeSessionMessage(message)
            }

            // Detect AskUserQuestion tool calls for PTY key sequence conversion
            if (message.type === 'assistant') {
                const msg = message as any;
                const content = msg.message?.content;
                if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block.type === 'tool_use' && block.name === 'AskUserQuestion' && block.input?.questions) {
                            pendingAskUserQuestion = (block.input.questions as any[]).map((q) => ({
                                header: q.header || '',
                                options: (q.options || []).map((o: any) => o.label || '')
                            }));
                            logger.debug(`[local]: Detected AskUserQuestion with ${pendingAskUserQuestion.length} questions, ${pendingAskUserQuestion[0]?.options.length} options`);
                        }
                    }
                }
            }
        }
    });

    // Register callback to notify scanner when session ID is found via hook
    const scannerSessionCallback = (sessionId: string) => {
        scanner.onNewSession(sessionId);
    };
    session.addSessionFoundCallback(scannerSessionCallback);

    // Handle abort
    let exitReason: LauncherResult | null = null;
    const processAbortController = new AbortController();
    let exutFuture = new Future<void>();

    // PTY child writer for message injection (set when child is ready)
    let childWriter: ChildWriter | null = null;

    try {
        async function abort() {
            if (!processAbortController.signal.aborted) {
                processAbortController.abort();
            }
            await exutFuture.promise;
        }

        async function doAbort() {
            logger.debug('[local]: doAbort');
            if (!exitReason) {
                exitReason = { type: 'switch' };
            }
            session.client.closeClaudeSessionTurn('cancelled');
            session.queue.reset();
            await abort();
        }

        async function doSwitch() {
            logger.debug('[local]: doSwitch');
            if (!exitReason) {
                exitReason = { type: 'switch' };
            }
            session.client.closeClaudeSessionTurn('cancelled');
            await abort();
        }

        // When to abort
        session.client.rpcHandlerManager.registerHandler('abort', doAbort);
        session.client.rpcHandlerManager.registerHandler('switch', doSwitch);

        // Handle permission responses from mobile (e.g. AskUserQuestion approval)
        // In local mode, Claude Code handles permissions via PTY interaction.
        // We just acknowledge the RPC so mobile's sessionAllow() doesn't timeout,
        // and update agentState for UI consistency.
        session.client.rpcHandlerManager.registerHandler<{ id: string; approved: boolean; [key: string]: unknown }, void>('permission', async (message) => {
            logger.debug(`[local]: Permission response received: ${JSON.stringify(message)}`);
            session.client.updateAgentState((currentState) => {
                const request = currentState.requests?.[message.id];
                if (!request) return currentState;
                const { [message.id]: _, ...remainingRequests } = currentState.requests ?? {};
                return {
                    ...currentState,
                    requests: remainingRequests,
                    completedRequests: {
                        ...currentState.completedRequests,
                        [message.id]: {
                            ...request,
                            completedAt: Date.now(),
                            status: message.approved ? 'approved' : 'denied',
                        }
                    }
                };
            });
        });

        // Inject mobile messages directly into the PTY for bidirectional control
        session.queue.setOnMessage((message: string, mode) => {
            if (!childWriter) {
                logger.debug('[local]: Mobile message received but PTY not ready, queuing for later');
                return;
            }

            // Convert AskUserQuestion responses to PTY key sequences
            if (pendingAskUserQuestion) {
                const keySequence = toAskUserQuestionKeySequence(message, pendingAskUserQuestion);
                if (keySequence) {
                    logger.debug(`[local]: Converting AskUserQuestion response to key sequence: "${message}"`);
                    childWriter(keySequence);
                    pendingAskUserQuestion = null;
                    return;
                }
            }

            logger.debug(`[local]: Injecting mobile message into PTY (${message.length} chars)`);
            childWriter(message + '\r');
        });

        // Handle session start
        const handleSessionStart = (sessionId: string) => {
            session.onSessionFound(sessionId);
            scanner.onNewSession(sessionId);
        }

        // Run local mode
        while (true) {
            if (exitReason) {
                return exitReason;
            }

            logger.debug('[local]: launch');
            try {
                await claudeLocal({
                    path: session.path,
                    sessionId: session.sessionId,
                    onSessionFound: handleSessionStart,
                    onThinkingChange: session.onThinkingChange,
                    abort: processAbortController.signal,
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    mcpServers: session.mcpServers,
                    allowedTools: session.allowedTools,
                    hookSettingsPath: session.hookSettingsPath,
                    sandboxConfig: session.sandboxConfig,
                    thinkingUrl: session.thinkingUrl,
                    onChildReady: (write) => {
                        childWriter = write;
                        logger.debug('[local]: Child ready, message injection enabled');
                    },
                });

                session.consumeOneTimeFlags();

                if (!exitReason) {
                    session.client.closeClaudeSessionTurn('completed');
                    exitReason = { type: 'exit', code: 0 };
                    break;
                }
            } catch (e) {
                logger.debug('[local]: launch error', e);
                if (e instanceof ExitCodeError) {
                    if (exitReason) {
                        break; // preserve existing exit reason (e.g. switch intent) — SIGTERM is expected
                    }
                    session.client.closeClaudeSessionTurn('failed');
                    exitReason = { type: 'exit', code: e.exitCode };
                    break;
                }
                if (!exitReason) {
                    session.client.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                    continue;
                } else {
                    break;
                }
            }
            logger.debug('[local]: launch done');
        }
    } finally {
        childWriter = null;
        exutFuture.resolve(undefined);
        session.client.rpcHandlerManager.registerHandler('abort', async () => { });
        session.client.rpcHandlerManager.registerHandler('switch', async () => { });
        session.client.rpcHandlerManager.registerHandler('permission', async () => { });
        session.queue.setOnMessage(null);
        session.removeSessionFoundCallback(scannerSessionCallback);
        await scanner.cleanup();
    }

    return exitReason || { type: 'exit', code: 0 };
}
