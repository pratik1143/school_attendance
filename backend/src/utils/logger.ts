type Level = 'info' | 'warn' | 'error';
function write(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const safeFields = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...safeFields });
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}
export const logger = {
  info: (message: string, fields?: Record<string, unknown>) => write('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write('error', message, fields),
};
