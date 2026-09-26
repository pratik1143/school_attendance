import { createServer } from 'node:http';

const port = Number(process.env.TEST_WEBHOOK_PORT || 8787);
const statusCode = Number(process.env.TEST_WEBHOOK_STATUS || 200);
const delayMs = Number(process.env.TEST_WEBHOOK_DELAY_MS || 0);
const maxBytes = Number(process.env.TEST_WEBHOOK_MAX_BYTES || 65_536);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TEST_WEBHOOK_PORT must be between 1 and 65535.');
if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) throw new Error('TEST_WEBHOOK_STATUS must be a valid HTTP status.');

const server = createServer((req, res) => {
  let size = 0; const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= maxBytes) chunks.push(chunk); else req.destroy(); });
  req.on('end', () => {
    const headers = { ...req.headers, 'x-webhook-signature': req.headers['x-webhook-signature'] ? '[REDACTED: signed value]' : undefined };
    console.info(JSON.stringify({ method: req.method, path: req.url, headers, body: Buffer.concat(chunks).toString('utf8').slice(0, maxBytes) }, null, 2));
    setTimeout(() => { res.writeHead(statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ received: true, testServer: true })); }, delayMs);
  });
});
server.listen(port, '127.0.0.1', () => console.info(`Development webhook receiver listening on http://127.0.0.1:${port}`));
process.on('SIGINT', () => server.close(() => process.exit(0)));
