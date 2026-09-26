/**
 * Preserves Node TCP data-event chunks in arrival order. This deliberately does
 * not concatenate chunks or claim they are complete application frames.
 */
export type CapturedStreamChunk = {
  sequence: number;
  receivedAt: Date;
  direction: 'DEVICE_TO_SERVER' | 'SERVER_TO_DEVICE';
  bytes: Buffer;
};

export class TcpStreamBuffer {
  private sequence = 0;
  private totalBytes = 0;

  push(bytes: Buffer, direction: CapturedStreamChunk['direction'], receivedAt = new Date()): CapturedStreamChunk {
    const copy = Buffer.from(bytes);
    this.sequence += 1;
    this.totalBytes += copy.length;
    return { sequence: this.sequence, receivedAt, direction, bytes: copy };
  }

  get chunkCount(): number { return this.sequence; }
  get byteCount(): number { return this.totalBytes; }
}
