// Hook for the Screen Wake Lock API.
// Keeps the device awake while the document is visible.
// Re-acquires on visibility change and on any user gesture (some browsers,
// notably iOS Safari, require a user activation for request('screen')).

import { useEffect } from 'react'

export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return

    let sentinel: WakeLockSentinel | null = null
    let cancelled = false

    const acquire = async () => {
      if (cancelled || sentinel || document.visibilityState !== 'visible') return
      try {
        const next = await navigator.wakeLock.request('screen')
        if (cancelled) {
          void next.release().catch(() => {})
          return
        }
        sentinel = next
        next.addEventListener('release', () => {
          if (sentinel === next) sentinel = null
        })
      } catch {
        // NotAllowedError (no user activation), low power mode, etc.
        // Persistent gesture listeners below will retry.
      }
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void acquire()
    }
    const handleGesture = () => {
      void acquire()
    }

    void acquire()
    document.addEventListener('visibilitychange', handleVisibility)
    document.addEventListener('pointerdown', handleGesture)
    document.addEventListener('touchstart', handleGesture, { passive: true })
    document.addEventListener('keydown', handleGesture)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibility)
      document.removeEventListener('pointerdown', handleGesture)
      document.removeEventListener('touchstart', handleGesture)
      document.removeEventListener('keydown', handleGesture)
      if (sentinel && !sentinel.released) {
        void sentinel.release().catch(() => {})
      }
      sentinel = null
    }
  }, [enabled])
}
