const fs = require('fs');
const http = require('http');
const { PassThrough } = require('stream');

// Disable autoupdater (never works really)
process.env.DISABLE_AUTOUPDATER = '1';

// Thinking state URL (replaces fd 3 when set)
const thinkingUrl = process.env.HAPPY_THINKING_URL;

// Inject server port — enables stdin proxy + HTTP message injection
const injectPort = process.env.HAPPY_INJECT_PORT;

// Helper to write JSON messages to fd 3 or HTTP endpoint
function writeMessage(message) {
    const payload = JSON.stringify(message) + '\n';

    if (thinkingUrl) {
        try {
            const url = new URL(thinkingUrl);
            const req = http.request({
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            }, () => {});
            req.on('error', () => {});
            req.end(payload);
        } catch (err) {
            // ignore
        }
    } else {
        try {
            fs.writeSync(3, payload);
        } catch (err) {
            // fd 3 not available, ignore
        }
    }
}

// Set up stdin proxy for message injection (bidirectional control)
if (injectPort) {
    const fakeStdin = new PassThrough();
    fakeStdin.isTTY = true;
    fakeStdin.isRaw = false;
    fakeStdin.setRawMode = function(mode) { this.isRaw = mode; return this; };

    // Preserve real stdin for forwarding terminal keystrokes
    const realStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true, writable: true });

    // Forward real terminal keystrokes → fake stdin
    if (realStdin.isTTY) {
        realStdin.setRawMode(true);
    }
    realStdin.resume();
    realStdin.on('data', (chunk) => fakeStdin.push(chunk));
    realStdin.on('end', () => fakeStdin.push(null));

    // Start HTTP server for message injection from happy parent process
    const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/inject') {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf-8');
                // Push the message text + carriage return into fake stdin
                fakeStdin.push(body + '\r');
                res.writeHead(200).end('ok');
            });
            return;
        }
        res.writeHead(404).end('not found');
    });

    server.listen(parseInt(injectPort, 10), '127.0.0.1', () => {
        // Server ready — parent can now inject messages
    });

    server.on('error', () => {
        // If port is busy, injection won't work but Claude still runs
    });
}

// Intercept fetch to track thinking state
const originalFetch = global.fetch;
let fetchCounter = 0;

global.fetch = function(...args) {
    const id = ++fetchCounter;
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const method = args[1]?.method || 'GET';

    let hostname = '';
    let path = '';
    try {
        const urlObj = new URL(url, 'http://localhost');
        hostname = urlObj.hostname;
        path = urlObj.pathname;
    } catch (e) {
        hostname = 'unknown';
        path = url;
    }

    writeMessage({
        type: 'fetch-start',
        id,
        hostname,
        path,
        method,
        timestamp: Date.now()
    });

    const fetchPromise = originalFetch(...args);

    const sendEnd = () => {
        writeMessage({
            type: 'fetch-end',
            id,
            timestamp: Date.now()
        });
    };

    fetchPromise.then(sendEnd, sendEnd);

    return fetchPromise;
};

Object.defineProperty(global.fetch, 'name', { value: 'fetch' });
Object.defineProperty(global.fetch, 'length', { value: originalFetch.length });

// Import global Claude Code CLI
const { getClaudeCliPath, runClaudeCli } = require('./claude_version_utils.cjs');

runClaudeCli(getClaudeCliPath());
