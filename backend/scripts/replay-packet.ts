import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseProtocol } from '../src/tcp/protocolParser.ts';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node --experimental-strip-types backend/scripts/replay-packet.ts <capture.json>');
  process.exit(2);
}

const absolutePath = resolve(inputPath);
const { size } = statSync(absolutePath);
if (size > 2 * 1024 * 1024) throw new Error('Capture file exceeds the 2 MiB replay limit.');
const value: unknown = JSON.parse(readFileSync(absolutePath, 'utf8'));
const captures = Array.isArray(value) ? value : [value];
for (const [index, capture] of captures.entries()) {
  if (!capture || typeof capture !== 'object' || !('rawBase64' in capture) || typeof capture.rawBase64 !== 'string') {
    throw new Error(`Capture ${index + 1} must be a JSON object with a rawBase64 string.`);
  }
  const bytes = Buffer.from(capture.rawBase64, 'base64');
  const result = parseProtocol(bytes);
  console.log(JSON.stringify({ file: basename(absolutePath), index, bytes: bytes.length, parser: result }));
}
