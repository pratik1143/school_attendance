import { createServer, type Server as TcpServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.ts';
import { markConnected, markDisconnected, markPacketSeen } from '../services/deviceHeartbeat.ts';
import { captureChunk, rawFields } from './packetLogger.ts';
import { ConnectionManager } from './connectionManager.ts';
import { TcpStreamBuffer } from './tcpStreamBuffer.ts';
import { looksLikeFkRequest, parseFkRequest } from './fkWebProtocol.ts';
import { handleFkRequest } from '../services/fkRequestHandler.ts';
import { logger } from '../utils/logger.ts';

export type ListenerState = { running: boolean; activeConnections: ReturnType<ConnectionManager['active']>; lastPacketAt: string | null };

export function createT800Server(manager = new ConnectionManager()) {
  const packetTimes = new WeakMap<Socket, Array<{ time: number; bytes: number }>>();
  let lastPacketAt: string | null = null;
  const tcpServer: TcpServer = createServer((socket) => {
    if (manager.count() >= env.maxConnections) {
      logger.warn('TCP connection limit reached; closing new connection.', { remoteIp: socket.remoteAddress });
      socket.destroy();
      return;
    }
    const connectionId = randomUUID();
    const remoteIp = socket.remoteAddress || 'unknown';
    const state = { connectionId, remoteIp, startedAt: new Date().toISOString(), lastPacketAt: null, bytesReceived: 0, bytesSent: 0, nextSequence: 1 };
    const stream = new TcpStreamBuffer();
    manager.add(socket, state);
    packetTimes.set(socket, []);
    socket.setNoDelay(true);
    logger.info('TCP device connected', { remoteIp, connectionId });
    const connectionReady = markConnected({ deviceId: env.deviceId, connectionId, remoteIp });

    let writeQueue = Promise.resolve();
    let pending: Buffer = Buffer.alloc(0);
    let pendingRawLogId: string | null = null;
    let rawLogMissing = false;
    socket.on('data', (chunk: Buffer) => {
      // Log receipt immediately, before Firestore work; never put raw biometric
      // or unknown protocol bytes in console logs. The restricted raw log keeps
      // the byte representation for later protocol analysis.
      logger.info('Raw TCP bytes received', {
        source: 'tcp_listener', deviceId: env.deviceId, connectionId, remoteIp,
        direction: 'DEVICE_TO_SERVER', byteLength: chunk.length, receivedAt: new Date().toISOString(),
      });
      socket.pause();
      writeQueue = writeQueue.then(() => connectionReady).then(async () => {
        if (chunk.length > env.maxPacketBytes) {
          logger.warn('TCP chunk exceeds configured size limit; closing connection.', { connectionId, bytes: chunk.length, maxPacketBytes: env.maxPacketBytes });
          socket.destroy();
          return;
        }
        const now = Date.now();
        const recent = (packetTimes.get(socket) || []).filter((sample) => now - sample.time < 1_000);
        if (recent.length >= env.maxPacketsPerSecond) {
          logger.warn('TCP packet rate limit reached; closing connection.', { connectionId, maxPacketsPerSecond: env.maxPacketsPerSecond });
          socket.destroy();
          return;
        }
        const recentBytes = recent.reduce((total, sample) => total + sample.bytes, 0);
        if (recentBytes + chunk.length > env.maxBytesPerSecond) {
          logger.warn('TCP byte rate limit reached; closing connection.', { connectionId, maxBytesPerSecond: env.maxBytesPerSecond });
          socket.destroy();
          return;
        }
        recent.push({ time: now, bytes: chunk.length });
        packetTimes.set(socket, recent);
        const receivedAt = new Date(now);
        const record = stream.push(chunk, 'DEVICE_TO_SERVER', receivedAt);
        const fields = rawFields(record.bytes, record.direction, record.sequence);
        manager.updatePacket(connectionId, record.bytes.length, receivedAt, record.sequence);
        lastPacketAt = receivedAt.toISOString();
        await markPacketSeen({ deviceId: env.deviceId, connectionId, remoteIp });
        let rawLogId: string | null = null;
        try {
          rawLogId = await captureChunk({ ...fields, connectionId, remoteIp, deviceId: env.deviceId, receivedAt: record.receivedAt });
        } catch (error) {
          logger.error('Raw TCP capture could not be persisted.', { connectionId, bytes: chunk.length, error: error instanceof Error ? error.message : String(error) });
        }
        // FK web-push requests (HTTP over this port) may span several chunks.
        pending = Buffer.concat([pending, record.bytes]);
        if (rawLogId) pendingRawLogId = rawLogId; else rawLogMissing = true;
        while (pending.length && looksLikeFkRequest(pending)) {
          const result = parseFkRequest(pending);
          if (!result.complete) break;
          pending = pending.subarray(result.consumed);
          if ('error' in result) {
            logger.warn('Malformed FK request; closing connection.', { connectionId, error: result.error });
            socket.destroy();
            return;
          }
          const reply = await handleFkRequest(result.request, { connectionId, rawLogId: rawLogMissing ? null : pendingRawLogId, receivedAt });
          rawLogMissing = false;
          pendingRawLogId = null;
          if (!socket.destroyed) {
            socket.write(reply);
            state.bytesSent += reply.length;
          }
        }
        if (pending.length > env.maxPacketBytes) {
          logger.warn('Incomplete request exceeds size limit; closing connection.', { connectionId, bytes: pending.length });
          socket.destroy();
        }
      }).catch((error) => logger.error('TCP chunk processing failed.', { connectionId, error: String(error) })).finally(() => {
        if (!socket.destroyed) socket.resume();
      });
    });

    socket.on('error', (error) => logger.warn('TCP connection error', { remoteIp, connectionId, error: error.message }));
    socket.on('close', () => {
      manager.remove(connectionId);
      logger.info('TCP device disconnected', { remoteIp, connectionId, bytesReceived: state.bytesReceived, bytesSent: state.bytesSent });
      if (!manager.hasConnections()) void writeQueue.finally(() => markDisconnected({ deviceId: env.deviceId, connectionId }));
    });
  });

  tcpServer.on('error', (error) => logger.error('TCP server error', { error: error.message }));
  return {
    server: tcpServer,
    manager,
    async listen(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { tcpServer.off('listening', onListening); reject(error); };
        const onListening = () => { tcpServer.off('error', onError); resolve(); };
        tcpServer.once('error', onError);
        tcpServer.once('listening', onListening);
        tcpServer.listen(env.tcpPort, '0.0.0.0');
      });
      logger.info('TCP listener ready', { port: env.tcpPort, deviceId: env.deviceId, maxConnections: env.maxConnections, maxPacketBytes: env.maxPacketBytes });
    },
    close(): Promise<void> { return new Promise((resolve) => tcpServer.close(() => resolve())); },
    state(): ListenerState { return { running: tcpServer.listening, activeConnections: manager.active(), lastPacketAt }; },
  };
}
