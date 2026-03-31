import { logger } from "@/ui/logger";
import { claudeLocal, ExitCodeError, ChildWriter } from "./claudeLocal";
import { Session } from "./session";
import { Future } from "@/utils/future";
import { createSessionScanner } from "./utils/sessionScanner";

export type LauncherResult = { type: 'switch' } | { type: 'exit', code: number };

export async function claudeLocalLauncher(session: Session): Promise<LauncherResult> {

    // Create scanner
    const scanner = await createSessionScanner({
        sessionId: session.sessionId,
        workingDirectory: session.path,
        onMessage: (message) => {
            // Block SDK summary messages - we generate our own
            if (message.type !== 'summary') {
                session.client.sendClaudeSessionMessage(message)
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

        // Inject mobile messages directly into the PTY for bidirectional control
        session.queue.setOnMessage((message: string, mode) => {
            if (childWriter) {
                logger.debug(`[local]: Injecting mobile message into PTY (${message.length} chars)`);
                childWriter(message + '\r');
            } else {
                logger.debug('[local]: Mobile message received but PTY not ready, queuing for later');
            }
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
        session.queue.setOnMessage(null);
        session.removeSessionFoundCallback(scannerSessionCallback);
        await scanner.cleanup();
    }

    return exitReason || { type: 'exit', code: 0 };
}
