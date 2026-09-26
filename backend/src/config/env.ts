function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function integerFrom(names: string[], fallback: number, min: number, max: number): number {
  for (const name of names) {
    const raw = process.env[name];
    if (raw !== undefined && raw !== '') {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}.`);
      }
      return parsed;
    }
  }
  return fallback;
}

function text(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

export const env = Object.freeze({
  tcpPort: integerFrom(['T800_TCP_PORT', 'TCP_PORT'], 8001, 1, 65535),
  healthPort: integerFrom(['HEALTH_PORT', 'PORT'], 8080, 1, 65535),
  healthHost: text('HEALTH_HOST', '0.0.0.0'),
  apiPort: integer('API_PORT', 8081, 1, 65535),
  apiHost: text('API_HOST', '0.0.0.0'),
  apiBaseUrl: text('API_BASE_URL', ''),
  apiRateLimit: integer('API_RATE_LIMIT', 60, 1, 100_000),
  apiKeyPepper: text('API_KEY_PEPPER', ''),
  corsOrigins: text('CORS_ORIGINS', '').split(',').map((origin) => origin.trim()).filter(Boolean),
  tenantId: text('DEFAULT_TENANT_ID', ''),
  clientId: text('DEFAULT_CLIENT_ID', ''),
  webhookSecretEncryptionKey: text('WEBHOOK_SECRET_ENCRYPTION_KEY', ''),
  webhookTimeoutMs: integer('WEBHOOK_TIMEOUT_MS', 10_000, 100, 120_000),
  webhookMaxPayloadBytes: integer('WEBHOOK_MAX_PAYLOAD_BYTES', 65_536, 1_024, 1_048_576),
  webhookMaxResponseBytes: integer('WEBHOOK_MAX_RESPONSE_BYTES', 8_192, 1, 1_048_576),
  webhookWorkerConcurrency: integer('WEBHOOK_WORKER_CONCURRENCY', 10, 1, 100),
  webhookMaxAttempts: integer('WEBHOOK_MAX_ATTEMPTS', 5, 1, 20),
  webhookRetryDelaysMs: text('WEBHOOK_RETRY_DELAYS_MS', '60000,300000,900000,3600000').split(',').map(Number),
  webhookFailureThreshold: integer('WEBHOOK_FAILURE_THRESHOLD', 10, 1, 1_000),
  webhookMaxPerMinute: integer('WEBHOOK_MAX_PER_MINUTE', 60, 1, 100_000),
  webhookAllowHttp: text('WEBHOOK_ALLOW_HTTP', 'false').toLowerCase() === 'true',
  webhookAllowLocalhost: text('WEBHOOK_ALLOW_LOCALHOST', 'false').toLowerCase() === 'true',
  projectId: text('FIREBASE_PROJECT_ID', ''),
  deviceId: text('T800_DEVICE_ID', 'T800_01'),
  cloudId: text('T800_CLOUD_ID', '02010A964EDF2575'),
  deviceName: text('T800_DEVICE_NAME', 'Main Gate T800'),
  model: text('T800_MODEL', 'T800'),
  connectionType: text('T800_CONNECTION_TYPE', 'wifi'),
  maxConnections: integer('MAX_CONNECTIONS', 16, 1, 512),
  maxPacketBytes: integer('MAX_PACKET_BYTES', 65_536, 256, 262_144),
  maxPacketsPerSecond: integer('MAX_PACKETS_PER_SECOND', 30, 1, 1_000),
  maxBytesPerSecond: integer('MAX_BYTES_PER_SECOND', 262_144, 1_024, 16_777_216),
  logRawPackets: text('LOG_RAW_PACKETS', 'false').toLowerCase() === 'true',
  diagnosticMode: text('DIAGNOSTIC_MODE', 'false').toLowerCase() === 'true',
  firestoreWritesEnabled: text('FIRESTORE_WRITES_ENABLED', 'true').toLowerCase() !== 'false',
});
