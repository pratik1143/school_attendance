import { createServer, type Server } from 'node:http';
import { env } from '../config/env.ts';
import { isFirestoreReady } from '../firestore/admin.ts';
import { logger } from '../utils/logger.ts';
import type { ListenerState } from '../tcp/t800Server.ts';

export function createHealthServer(readTcpState: () => ListenerState) {
  let server: Server | null = null;
  return {
    async listen(): Promise<void> {
      server = createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET' || !['/health', '/status'].includes(req.url || '')) {
          res.writeHead(404).end(JSON.stringify({ success: false, error: 'Not found' }));
          return;
        }
        const tcp = readTcpState();
        if (req.url === '/health') {
          res.writeHead(tcp.running ? 200 : 503).end(JSON.stringify({ success: tcp.running, service: 'school-attendance-backend', tcpPort: env.tcpPort, timestamp: new Date().toISOString() }));
          return;
        }
        res.writeHead(200).end(JSON.stringify({ service: 'school-attendance-backend', backend: 'running', firestore: isFirestoreReady() ? 'initialized' : 'unavailable', tcp, timestamp: new Date().toISOString() }));
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server?.off('listening', onListening); reject(error); };
        const onListening = () => { server?.off('error', onError); resolve(); };
        server?.once('error', onError);
        server?.once('listening', onListening);
        server?.listen(env.healthPort, env.healthHost);
      });
      logger.info('Health server ready', { host: env.healthHost, port: env.healthPort });
    },
    close(): Promise<void> { return new Promise((resolve) => server ? server.close(() => resolve()) : resolve()); },
  };
}
