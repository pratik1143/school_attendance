import { env } from './config/env.ts';
import { createHealthServer } from './services/healthServer.ts';
import { createApiServer } from './api/apiServer.ts';
import { createT800Server } from './tcp/t800Server.ts';
import { logger } from './utils/logger.ts';

const tcp = createT800Server();
const health = createHealthServer(() => tcp.state());
const api = createApiServer();
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Graceful shutdown started', { signal });
  tcp.manager.closeAll();
  const forceClose = setTimeout(() => tcp.manager.destroyAll(), 5_000);
  forceClose.unref();
  await Promise.all([tcp.close(), health.close(), api.close()]);
  clearTimeout(forceClose);
  tcp.manager.destroyAll();
  logger.info('Backend shutdown complete');
  process.exitCode = 0;
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

try {
  await tcp.listen();
  await health.listen();
  await api.listen();
} catch (error) {
  logger.error('Backend failed to start', { error: error instanceof Error ? error.message : String(error), tcpPort: env.tcpPort, healthPort: env.healthPort });
  await shutdown('STARTUP_ERROR');
  process.exitCode = 1;
}
