import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('logger', () => {
  const ORIGINAL_LOG_LEVEL = process.env.LOG_LEVEL
  const ORIGINAL_LOG_FILE = process.env.LOG_FILE
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV

  // Track imported modules for cleanup
  let closeLogger: (() => void) | null = null

  afterEach(() => {
    // Close logger to release resources
    if (closeLogger) {
      closeLogger()
      closeLogger = null
    }

    // Restore env vars
    if (ORIGINAL_LOG_LEVEL === undefined) {
      delete process.env.LOG_LEVEL
    } else {
      process.env.LOG_LEVEL = ORIGINAL_LOG_LEVEL
    }
    if (ORIGINAL_LOG_FILE === undefined) {
      delete process.env.LOG_FILE
    } else {
      process.env.LOG_FILE = ORIGINAL_LOG_FILE
    }
    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV
    }
  })

  test('logger exports expected interface', async () => {
    const mod = await import(`../logger?iface-${Date.now()}`)
    closeLogger = mod.closeLogger

    expect(typeof mod.logger.debug).toBe('function')
    expect(typeof mod.logger.info).toBe('function')
    expect(typeof mod.logger.warn).toBe('function')
    expect(typeof mod.logger.error).toBe('function')
    expect(typeof mod.flushLogger).toBe('function')
    expect(typeof mod.closeLogger).toBe('function')
  })

  test('writes to log file when LOG_FILE is set', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'))
    const logFile = path.join(tmpDir, 'test.log')

    process.env.LOG_FILE = logFile
    process.env.LOG_LEVEL = 'info'
    process.env.NODE_ENV = 'production'

    const mod = await import(`../logger?file-${Date.now()}`)
    closeLogger = mod.closeLogger

    mod.logger.info('test_event', { foo: 'bar' })
    mod.flushLogger()

    const content = fs.readFileSync(logFile, 'utf-8')
    expect(content).toContain('test_event')
    expect(content).toContain('foo')

    mod.closeLogger()
    closeLogger = null
    fs.rmSync(tmpDir, { recursive: true })
  })

  test('logger respects log level from env', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'))
    const logFile = path.join(tmpDir, 'test.log')

    process.env.LOG_FILE = logFile
    process.env.LOG_LEVEL = 'warn'
    process.env.NODE_ENV = 'production'

    const mod = await import(`../logger?level-${Date.now()}`)
    closeLogger = mod.closeLogger

    mod.logger.debug('debug_event')
    mod.logger.info('info_event')
    mod.logger.warn('warn_event')
    mod.flushLogger()

    const content = fs.readFileSync(logFile, 'utf-8')
    expect(content).not.toContain('debug_event')
    expect(content).not.toContain('info_event')
    expect(content).toContain('warn_event')

    mod.closeLogger()
    closeLogger = null
    fs.rmSync(tmpDir, { recursive: true })
  })

  test('defaults to info level when LOG_LEVEL not set', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'))
    const logFile = path.join(tmpDir, 'test.log')

    delete process.env.LOG_LEVEL
    process.env.LOG_FILE = logFile
    process.env.NODE_ENV = 'production'

    const mod = await import(`../logger?default-${Date.now()}`)
    closeLogger = mod.closeLogger

    mod.logger.debug('debug_event')
    mod.logger.info('info_event')
    mod.flushLogger()

    const content = fs.readFileSync(logFile, 'utf-8')
    expect(content).not.toContain('debug_event')
    expect(content).toContain('info_event')

    mod.closeLogger()
    closeLogger = null
    fs.rmSync(tmpDir, { recursive: true })
  })

  test('handles invalid LOG_LEVEL gracefully', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'))
    const logFile = path.join(tmpDir, 'test.log')

    process.env.LOG_LEVEL = 'invalid'
    process.env.LOG_FILE = logFile
    process.env.NODE_ENV = 'production'

    const mod = await import(`../logger?invalid-${Date.now()}`)
    closeLogger = mod.closeLogger

    mod.logger.debug('debug_event')
    mod.logger.info('info_event')
    mod.flushLogger()

    const content = fs.readFileSync(logFile, 'utf-8')
    // Should default to info level
    expect(content).not.toContain('debug_event')
    expect(content).toContain('info_event')

    mod.closeLogger()
    closeLogger = null
    fs.rmSync(tmpDir, { recursive: true })
  })

  test('log entries include event name in output', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'))
    const logFile = path.join(tmpDir, 'test.log')

    process.env.LOG_FILE = logFile
    process.env.LOG_LEVEL = 'info'
    process.env.NODE_ENV = 'production'

    const mod = await import(`../logger?event-${Date.now()}`)
    closeLogger = mod.closeLogger

    mod.logger.info('my_custom_event', { key: 'value' })
    mod.flushLogger()

    const content = fs.readFileSync(logFile, 'utf-8')
    const lines = content.trim().split('\n')
    const entry = JSON.parse(lines[0])

    expect(entry.event).toBe('my_custom_event')
    expect(entry.key).toBe('value')
    expect(entry.level).toBe(30) // pino info level number

    mod.closeLogger()
    closeLogger = null
    fs.rmSync(tmpDir, { recursive: true })
  })

  test('logs written before an event-loop freeze survive a SIGKILL', async () => {
    // Regression test for the 2026-07-07 startup hang: with a worker-thread
    // transport (pino.transport), logs queued before the event loop froze were
    // never flushed — the process died with a 0-byte log and no evidence.
    // Writes must be synchronous on the main thread.
    const script = [
      "import { logger } from './src/server/logger'",
      "logger.info('before_freeze_marker')",
      "Bun.spawnSync(['sleep', '30'])",
    ].join('\n')

    const proc = Bun.spawn(['bun', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'production', LOG_FILE: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    // Give the child time to init the logger, write the line, and enter the
    // freeze — then kill it hard, exactly like the real hang ended
    await new Promise((resolve) => setTimeout(resolve, 2500))
    proc.kill(9)
    await proc.exited

    const stdout = await new Response(proc.stdout).text()
    expect(stdout).toContain('before_freeze_marker')
  }, 10000)

  test('event field is not overwritten by data', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'))
    const logFile = path.join(tmpDir, 'test.log')

    process.env.LOG_FILE = logFile
    process.env.LOG_LEVEL = 'info'
    process.env.NODE_ENV = 'production'

    const mod = await import(`../logger?override-${Date.now()}`)
    closeLogger = mod.closeLogger

    // Pass data that tries to override event field
    mod.logger.info('correct_event', { event: 'wrong_event', other: 'data' })
    mod.flushLogger()

    const content = fs.readFileSync(logFile, 'utf-8')
    const entry = JSON.parse(content.trim())

    expect(entry.event).toBe('correct_event')
    expect(entry.other).toBe('data')

    mod.closeLogger()
    closeLogger = null
    fs.rmSync(tmpDir, { recursive: true })
  })
})
