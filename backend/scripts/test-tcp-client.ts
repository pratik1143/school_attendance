import { createConnection } from 'node:net';

const host = process.env.TCP_TEST_HOST || '127.0.0.1';
const port = Number(process.env.TCP_PORT || 8001);
const client = createConnection({ host, port }, () => {
  console.log(`[TEST] Connected to ${host}:${port}`);
  client.write(Buffer.from('TEST_PACKET_PHASE2', 'utf8'));
  console.log('[TEST] Sent TEST_PACKET_PHASE2 (unknown test bytes; never attendance)');
  setTimeout(() => client.end(), 100);
});
client.on('error', (error) => { console.error(`[TEST] TCP client error: ${error.message}`); process.exitCode = 1; });
client.on('close', () => console.log('[TEST] Connection closed'));
