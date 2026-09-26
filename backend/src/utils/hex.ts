export function toHex(buffer: Buffer): string { return buffer.toString('hex'); }
export function toBase64(buffer: Buffer): string { return buffer.toString('base64'); }
export function printableAscii(buffer: Buffer): string {
  return [...buffer].map((byte) => byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.').join('');
}
export function redactPrintableSecrets(text: string): string {
  return text.replace(/(authorization|password|passwd|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>');
}
