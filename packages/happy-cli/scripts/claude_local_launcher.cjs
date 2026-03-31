const fs = require('fs');
const http = require('http');

// Disable autoupdater (never works really)
process.env.DISABLE_AUTOUPDATER = '1';

// Thinking state URL for PTY mode (where fd 3 is not available)
const thinkingUrl = process.env.HAPPY_THINKING_URL;

// Helper to write JSON messages to fd 3 or HTTP endpoint
function writeMessage(message) {
    const payload = JSON.stringify(message) + '\n';

    if (thinkingUrl) {
        // PTY mode: send via HTTP (fire-and-forget)
        try {
            const url = new URL(thinkingUrl);
            const req = http.request({
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            }, () => { /* ignore response */ });
            req.on('error', () => { /* ignore errors */ });
            req.end(payload);
        } catch (err) {
            // ignore
        }
    } else {
        // Standard mode: write to fd 3
        try {
            fs.writeSync(3, payload);
        } catch (err) {
            // fd 3 not available, ignore
        }
    }
}

// Intercept fetch to track thinking state
const originalFetch = global.fetch;
let fetchCounter = 0;

global.fetch = function(...args) {
    const id = ++fetchCounter;
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const method = args[1]?.method || 'GET';
    
    // Parse URL for privacy
    let hostname = '';
    let path = '';
    try {
        const urlObj = new URL(url, 'http://localhost');
        hostname = urlObj.hostname;
        path = urlObj.pathname;
    } catch (e) {
        // If URL parsing fails, use defaults
        hostname = 'unknown';
        path = url;
    }
    
    // Send fetch start event
    writeMessage({
        type: 'fetch-start',
        id,
        hostname,
        path,
        method,
        timestamp: Date.now()
    });

    // Execute the original fetch immediately
    const fetchPromise = originalFetch(...args);
    
    // Attach handlers to send fetch end event
    const sendEnd = () => {
        writeMessage({
            type: 'fetch-end',
            id,
            timestamp: Date.now()
        });
    };
    
    // Send end event on both success and failure
    fetchPromise.then(sendEnd, sendEnd);
    
    // Return the original promise unchanged
    return fetchPromise;
};

// Preserve fetch properties
Object.defineProperty(global.fetch, 'name', { value: 'fetch' });
Object.defineProperty(global.fetch, 'length', { value: originalFetch.length });

// Import global Claude Code CLI
const { getClaudeCliPath, runClaudeCli } = require('./claude_version_utils.cjs');

runClaudeCli(getClaudeCliPath());