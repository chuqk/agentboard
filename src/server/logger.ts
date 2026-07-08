// Structured logger using pino
// Configure via env vars:
//   LOG_LEVEL: debug | info | warn | error (default: info)
//   LOG_FILE: path to log file (optional, enables file logging)

import path from 'node:path'
import pino from 'pino'
import { config } from './config'

type LogData = Record<string, unknown>
type LogLevel = 'debug' | 'info' | 'warn' | 'error'

// Resolve log level from env or config, with fallback
// Env var takes precedence over config
function getLogLevel(): LogLevel {
  const level = process.env.LOG_LEVEL?.toLowerCase() ?? config?.logLevel
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
    return level
  }
  return 'info'
}

// Resolve log file from env or config, expanding ~ to home dir
// Env var takes precedence over config
function getLogFile(): string {
  const logFile = process.env.LOG_FILE ?? config?.logFile ?? ''
  if (logFile.startsWith('~/')) {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    return path.join(home, logFile.slice(2))
  }
  return logFile
}

// Track file destination for cleanup
let fileDestination: pino.DestinationStream | null = null

const PRETTY_OPTIONS = {
  colorize: true,
  translateTime: 'SYS:standard',
  ignore: 'pid,hostname',
}

function hasPinoPretty(): boolean {
  try {
    require.resolve('pino-pretty')
    return true
  } catch {
    return false
  }
}

// Pretty stdout as a synchronous main-thread stream — deliberately NOT
// pino.transport(): the worker-thread transport buffers logs until the event
// loop services the worker handshake, so a freeze before that point (e.g. the
// 2026-07-07 startup hang on an unresponsive tailscaled) leaves a 0-byte log
// with no evidence. Sync streams also work in compiled Bun binaries, which
// lack the worker_threads support pino.transport() requires.
function createPrettyStdoutStream(): pino.DestinationStream | null {
  if (!hasPinoPretty()) return null
  try {
    const prettyFactory = require('pino-pretty') as (
      opts: Record<string, unknown>
    ) => pino.DestinationStream
    return prettyFactory({ ...PRETTY_OPTIONS, destination: 1, sync: true })
  } catch {
    return null
  }
}

function createLogger(): pino.Logger {
  const logLevel = getLogLevel()
  const logFile = getLogFile()
  const isDev = process.env.NODE_ENV !== 'production'

  const baseOptions: pino.LoggerOptions = {
    level: logLevel,
    base: {},                              // strip pid, hostname
    timestamp: pino.stdTimeFunctions.isoTime, // ISO 8601 instead of epoch ms
  }

  // Pretty stdout when pino-pretty is available (npx installs), otherwise raw
  // JSON (compiled binaries). Either way the write is synchronous.
  const stdoutStream =
    createPrettyStdoutStream() ?? pino.destination({ dest: 1, sync: true })

  // Also log to structured JSON file. In dev, only when LOG_FILE is explicitly
  // set via env var (don't use config default in dev to avoid noisy file logging)
  if (logFile && (!isDev || process.env.LOG_FILE)) {
    fileDestination = pino.destination({ dest: logFile, sync: true, mkdir: true })
    const streams: pino.StreamEntry[] = [
      { level: logLevel, stream: stdoutStream },
      { level: logLevel, stream: fileDestination },
    ]
    return pino(baseOptions, pino.multistream(streams))
  }

  return pino(baseOptions, stdoutStream)
}

const pinoLogger: pino.Logger = createLogger()

/** Resolved log level — exposed so server-config can send it to the client. */
export const logLevel: LogLevel = getLogLevel()

// Flush pending logs
// Call before process.exit() to ensure logs are written
export function flushLogger(): void {
  pinoLogger.flush()
  if (fileDestination && 'flushSync' in fileDestination) {
    ;(fileDestination as pino.DestinationStream & { flushSync: () => void }).flushSync()
  }
}

// Close logger and release resources (for tests)
export function closeLogger(): void {
  flushLogger()
  if (fileDestination && 'end' in fileDestination) {
    ;(fileDestination as pino.DestinationStream & { end: () => void }).end()
  }
  fileDestination = null
}

// Wrapper to maintain existing API: logger.info('event_name', { data })
// Pino's native API is logger.info({ data }, 'message'), so we adapt
// Note: { ...data, event } ensures event field isn't overwritten by data
export const logger = {
  debug: (event: string, data?: LogData) => pinoLogger.debug({ ...data, event }),
  info: (event: string, data?: LogData) => pinoLogger.info({ ...data, event }),
  warn: (event: string, data?: LogData) => pinoLogger.warn({ ...data, event }),
  error: (event: string, data?: LogData) => pinoLogger.error({ ...data, event }),
}
