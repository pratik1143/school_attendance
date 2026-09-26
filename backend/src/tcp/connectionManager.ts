import type { Socket } from 'node:net';

export type ConnectionState = {
  connectionId: string;
  remoteIp: string;
  startedAt: string;
  lastPacketAt: string | null;
  bytesReceived: number;
  bytesSent: number;
  nextSequence: number;
};
type Managed = { socket: Socket; state: ConnectionState };

export class ConnectionManager {
  private connections = new Map<string, Managed>();
  add(socket: Socket, state: ConnectionState): void { this.connections.set(state.connectionId, { socket, state }); }
  get(connectionId: string): ConnectionState | undefined { return this.connections.get(connectionId)?.state; }
  active(): ConnectionState[] { return [...this.connections.values()].map(({ state }) => ({ ...state })); }
  count(): number { return this.connections.size; }
  hasConnections(): boolean { return this.connections.size > 0; }
  updatePacket(connectionId: string, bytes: number, receivedAt: Date, sequence: number): void {
    const managed = this.connections.get(connectionId);
    if (!managed) return;
    managed.state.bytesReceived += bytes;
    managed.state.lastPacketAt = receivedAt.toISOString();
    managed.state.nextSequence = sequence + 1;
  }
  addBytesSent(connectionId: string, bytes: number): void {
    const managed = this.connections.get(connectionId);
    if (managed) managed.state.bytesSent += bytes;
  }
  remove(connectionId: string): Managed | undefined { const value = this.connections.get(connectionId); this.connections.delete(connectionId); return value; }
  closeAll(): void { for (const { socket } of this.connections.values()) socket.end(); }
  destroyAll(): void { for (const { socket } of this.connections.values()) socket.destroy(); }
}
