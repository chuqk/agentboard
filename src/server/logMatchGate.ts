import type { LogEntrySnapshot } from './logPollData'

export interface SessionSnapshot {
  sessionId: string
  logFilePath: string
  currentWindow: string | null
  lastActivityAt: string
  lastUserMessage?: string | null
  lastKnownLogSize?: number | null
}

/**
 * Check if a path matches a pattern from skipMatchingPatterns.
 * Supports trailing * for prefix matching.
 * Normalizes backslashes to forward slashes for cross-platform compatibility.
 */
function matchesPathPattern(path: string | null, pattern: string): boolean {
  if (!path) return false
  const normalizedPath = path.toLowerCase().replace(/\\/g, '/')
  const normalizedPattern = pattern.toLowerCase().replace(/\\/g, '/')

  if (normalizedPattern.endsWith('*')) {
    const prefix = normalizedPattern.slice(0, -1)
    return normalizedPath.startsWith(prefix)
  }

  return normalizedPath === normalizedPattern
}

/**
 * Check if an entry should skip matching based on configured patterns.
 * This is used to avoid expensive window matching for orphaned sessions
 * (e.g., headless Codex exec, temp directories) that are unlikely to
 * have a tmux window to match against.
 */
export function shouldSkipMatching(
  entry: LogEntrySnapshot,
  patterns: string[]
): boolean {
  for (const pattern of patterns) {
    // Special marker for Codex exec sessions (case-insensitive)
    if (pattern.toLowerCase() === '<codex-exec>' && entry.isCodexExec) {
      return true
    }

    // Path pattern - check projectPath
    if (matchesPathPattern(entry.projectPath, pattern)) {
      return true
    }
  }

  return false
}

export interface GetEntriesNeedingMatchOptions {
  minTokens?: number
  /** Patterns for sessions that should skip matching when orphaned */
  skipMatchingPatterns?: string[]
}

export function getEntriesNeedingMatch(
  entries: LogEntrySnapshot[],
  sessions: SessionSnapshot[],
  { minTokens = 0, skipMatchingPatterns = [] }: GetEntriesNeedingMatchOptions = {}
): LogEntrySnapshot[] {
  if (entries.length === 0) return []
  const sessionsByLogPath = new Map(
    sessions.map((session) => [session.logFilePath, session])
  )
  const sessionsById = new Map(
    sessions.map((session) => [session.sessionId, session])
  )
  const needs: LogEntrySnapshot[] = []

  for (const entry of entries) {
    if (!entry.sessionId) continue
    // Codex exec sessions are headless by definition - never attempt window matching
    if (entry.isCodexExec) continue
    // logTokenCount = -1 means enrichment was skipped (known session, already validated)
    if (minTokens > 0 && entry.logTokenCount >= 0 && entry.logTokenCount < minTokens) continue
    const session =
      sessionsByLogPath.get(entry.logPath) ??
      sessionsById.get(entry.sessionId)
    if (!session) {
      // New session - always attempt matching (give it one chance)
      needs.push(entry)
      continue
    }
    if (!session.currentWindow) {
      // Orphan session - check if it should skip matching
      if (shouldSkipMatching(entry, skipMatchingPatterns)) {
        continue
      }
      // Gate on size change - if size differs, content changed and we should re-match
      if (entry.size !== session.lastKnownLogSize) {
        needs.push(entry)
      }
    }
  }

  return needs
}

export function shouldRunMatching(
  entries: LogEntrySnapshot[],
  sessions: SessionSnapshot[],
  options: GetEntriesNeedingMatchOptions = {}
): boolean {
  return getEntriesNeedingMatch(entries, sessions, options).length > 0
}

/**
 * A window claim goes stale once the owning session's log has been silent for
 * this long. A stale claim may be stolen by a windowless session whose log is
 * newer AND whose content matches the window — the same-window restart case
 * (e.g. a fresh claude after /wrap). Without stealing, that case deadlocks:
 * the old session survives startup verification via the display-name fallback
 * while the new session can never match a claimed window, so the association
 * (and everything derived from it: lastUserMessage, transcript resolution,
 * wake target) stays frozen on the dead log indefinitely.
 *
 * An idle-but-live window still shows its own conversation, so the content
 * match won't hand it to another log; this threshold only keeps very fresh
 * claims out of the steal path entirely.
 */
export const STALE_WINDOW_CLAIM_MS = 10 * 60 * 1000

export function isWindowClaimStale(
  lastActivityAt: string,
  now: number = Date.now()
): boolean {
  const at = Date.parse(lastActivityAt)
  // Unparseable activity = no evidence the claim is live; let the content
  // match decide rather than freezing the window forever.
  return !Number.isFinite(at) || now - at > STALE_WINDOW_CLAIM_MS
}
