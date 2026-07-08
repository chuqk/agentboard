// Regression test for the 2026-07-07 startup hang: with hostname=127.0.0.1
// (the default), startup calls getTailscaleIp() synchronously between the
// first bind and accept. Without a spawnSync timeout, an unresponsive
// tailscaled froze the event loop forever — port bound, never accepting —
// and Cloudflare returned 502 for ~19h.
//
// This test replaces `tailscale` with an unresponsive dummy (sleep) via PATH
// and asserts the server still becomes healthy on 127.0.0.1 within the
// spawnSync timeout + startup slack. On regression (timeout removed) the
// dummy blocks startup far past the health deadline and the test fails.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { canBindLocalhost, isTmuxAvailable } from './testEnvironment'

const tmuxAvailable = isTmuxAvailable()
const localhostBindable = canBindLocalhost()
const testHost = '127.0.0.1'

if (!tmuxAvailable || !localhostBindable) {
  const reasons: string[] = []
  if (!tmuxAvailable) reasons.push('tmux not available')
  if (!localhostBindable) reasons.push('localhost sockets unavailable')
  test.skip(
    `${reasons.join(' and ')} - skipping tailscale hang integration test`,
    () => {}
  )
} else {
  describe('startup with unresponsive tailscale', () => {
    const suffix = `${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`
    const sessionName = `agentboard-tshang-${suffix}`
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-tshang-'))
    const dbPath = path.join(tmpDir, 'test.db')
    const markerFile = path.join(tmpDir, 'tailscale-called')
    let serverProcess: ReturnType<typeof Bun.spawn> | null = null
    let port = 0

    beforeAll(async () => {
      // Unresponsive tailscale dummy: records it was invoked, then blocks well
      // past the health deadline (but short enough to self-clean on regression,
      // where the missing spawnSync timeout means it is never killed).
      const dummyPath = path.join(tmpDir, 'tailscale')
      fs.writeFileSync(
        dummyPath,
        `#!/bin/sh\necho called >> "${markerFile}"\nsleep 60\n`,
        { mode: 0o755 }
      )

      port = await getFreePort()

      serverProcess = Bun.spawn(['bun', 'src/server/index.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${tmpDir}:${process.env.PATH ?? ''}`,
          // The hang only occurs on the localhost bind path (the default);
          // set explicitly in case the test environment exports HOSTNAME
          HOSTNAME: testHost,
          PORT: String(port),
          TMUX_SESSION: sessionName,
          DISCOVER_PREFIXES: '',
          AGENTBOARD_LOG_POLL_MS: '0',
          AGENTBOARD_DB_PATH: dbPath,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      drainStream(serverProcess.stdout)
      drainStream(serverProcess.stderr)

      // getTailscaleIp tries 2 paths x 3s timeout, plus normal startup slack
      await waitForHealth(port, 15000)
    }, 20000)

    afterAll(async () => {
      if (serverProcess) {
        try {
          serverProcess.kill()
          await serverProcess.exited
        } catch {
          // ignore shutdown errors
        }
      }

      try {
        Bun.spawnSync(['tmux', 'kill-session', '-t', sessionName], {
          stdout: 'ignore',
          stderr: 'ignore',
        })
      } catch {
        // ignore cleanup errors
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    })

    test('unresponsive tailscale dummy was actually invoked', () => {
      expect(fs.existsSync(markerFile)).toBe(true)
    })

    test('server accepts on 127.0.0.1 despite the hang', async () => {
      const response = await fetch(`http://${testHost}:${port}/api/health`)
      expect(response.ok).toBe(true)
      const payload = (await response.json()) as { ok: boolean }
      expect(payload.ok).toBe(true)
    })
  })
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ port: 0, host: testHost }, () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const { port } = address
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('Unable to allocate port')))
      }
    })
  })
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://${testHost}:${port}/api/health`)
      if (response.ok) {
        return
      }
    } catch {
      // retry
    }
    await delay(150)
  }
  throw new Error('Server did not become healthy in time')
}

function drainStream(
  stream: ReadableStream<Uint8Array> | number | null | undefined
) {
  if (!stream || typeof stream === 'number') {
    return
  }

  const reader = stream.getReader()
  const pump = async () => {
    while (true) {
      const { done } = await reader.read()
      if (done) {
        break
      }
    }
  }
  void pump()
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
