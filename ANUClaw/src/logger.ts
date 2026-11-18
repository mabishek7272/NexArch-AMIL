import * as fs from 'fs';
import * as path from 'path';
import { redactSecrets, safeSerialize } from './security/redact';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const configuredLevel = (process.env.LOG_LEVEL ?? 'info') as LogLevel;
const logFile = process.env.LOG_FILE ?? './logs/anuclaw.log';

function ensureLogDir(): void {
  const dir = path.dirname(logFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function write(level: LogLevel, msg: string, ...args: unknown[]): void {
  if (LEVELS[level] < LEVELS[configuredLevel]) return;
  const timestamp = new Date().toISOString();
  // Every argument passes through redaction: errors are summarised, credential-like
  // keys dropped, token/key patterns masked (plan F04 safe logs).
  const extra = args.length > 0
    ? ' ' + args.map((a) => { try { return JSON.stringify(safeSerialize(a)); } catch { return '"[unserialisable]"'; } }).join(' ')
    : '';
  const line = `[${timestamp}] [${level.toUpperCase()}] ${redactSecrets(String(msg))}${extra}`;
  console[level === 'debug' ? 'log' : level](line);
  try {
    ensureLogDir();
    fs.appendFileSync(logFile, line + '\n');
  } catch {
    // non-fatal
  }
}

export const logger = {
  debug: (msg: string, ...args: unknown[]) => write('debug', msg, ...args),
  info: (msg: string, ...args: unknown[]) => write('info', msg, ...args),
  warn: (msg: string, ...args: unknown[]) => write('warn', msg, ...args),
  error: (msg: string, ...args: unknown[]) => write('error', msg, ...args),
};
