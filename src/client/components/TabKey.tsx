/**
 * TabKey - Tab key with long-press popup for Shift+Tab
 * Short tap sends Tab; long press opens a popup; releasing on the cell sends Shift+Tab
 */

import { useState, useRef, useCallback, useEffect, type TouchEvent } from 'react'

interface TabKeyProps {
  onSendKey: (key: string) => void
  disabled?: boolean
  onRefocus?: () => void
  isKeyboardVisible?: () => boolean
}

const LONG_PRESS_DELAY = 150
const TAB = '\t'
const SHIFT_TAB = '\x1b[Z'

const CELL_WIDTH = 120
const CELL_HEIGHT = 56
const PADDING = 8
const GAP = 6
const INDICATOR_HEIGHT = 20 + GAP + 2
const PAD_WIDTH = CELL_WIDTH + 2 * PADDING
const PAD_HEIGHT = CELL_HEIGHT + 2 * PADDING + INDICATOR_HEIGHT

function triggerHaptic(intensity: number = 10) {
  if ('vibrate' in navigator) {
    navigator.vibrate(intensity)
  }
}

function isPointInsideCell(
  clientX: number,
  clientY: number,
  padPosition: { x: number; y: number }
): boolean {
  const padLeft = padPosition.x - PAD_WIDTH / 2
  const padTop = padPosition.y - PAD_HEIGHT / 2
  const relX = clientX - padLeft - PADDING
  const relY = clientY - padTop - PADDING
  return relX >= 0 && relX <= CELL_WIDTH && relY >= 0 && relY <= CELL_HEIGHT
}

export default function TabKey({
  onSendKey,
  disabled = false,
  onRefocus,
  isKeyboardVisible,
}: TabKeyProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [isCellActive, setIsCellActive] = useState(false)
  const [padPosition, setPadPosition] = useState({ x: 0, y: 0 })

  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasKeyboardVisibleRef = useRef(false)
  const hasOpenedRef = useRef(false)
  const hasSentKeyRef = useRef(false)

  const closePad = useCallback(() => {
    setIsOpen(false)
    setIsCellActive(false)
    hasOpenedRef.current = false
    hasSentKeyRef.current = false

    if (wasKeyboardVisibleRef.current) {
      onRefocus?.()
    }
  }, [onRefocus])

  const handleTriggerTouchStart = useCallback((e: TouchEvent) => {
    if (disabled) return
    e.preventDefault()
    e.stopPropagation()

    const touch = e.touches[0]
    wasKeyboardVisibleRef.current = isKeyboardVisible?.() ?? false
    hasOpenedRef.current = false
    hasSentKeyRef.current = false

    longPressTimerRef.current = setTimeout(() => {
      triggerHaptic(15)
      const margin = 10

      let x = touch.clientX
      let y = touch.clientY - 90

      x = Math.max(margin + PAD_WIDTH / 2, Math.min(window.innerWidth - margin - PAD_WIDTH / 2, x))
      y = Math.max(margin + PAD_HEIGHT / 2, y)

      setPadPosition({ x, y })
      setIsOpen(true)
      hasOpenedRef.current = true
    }, LONG_PRESS_DELAY)
  }, [disabled, isKeyboardVisible])

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isOpen) return
    e.preventDefault()
    e.stopPropagation()

    const touch = e.touches[0]
    const inside = isPointInsideCell(touch.clientX, touch.clientY, padPosition)
    if (inside !== isCellActive) {
      setIsCellActive(inside)
      if (inside) {
        triggerHaptic(5)
      }
    }
  }, [isOpen, isCellActive, padPosition])

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }

    if (!hasOpenedRef.current && !hasSentKeyRef.current) {
      // Short tap → send Tab
      triggerHaptic(10)
      onSendKey(TAB)
      hasSentKeyRef.current = true
      if (wasKeyboardVisibleRef.current) {
        onRefocus?.()
      }
      return
    }

    if (isOpen && isCellActive && !hasSentKeyRef.current) {
      triggerHaptic(10)
      onSendKey(SHIFT_TAB)
      hasSentKeyRef.current = true
    }

    closePad()
  }, [isOpen, isCellActive, onSendKey, onRefocus, closePad])

  const handleTouchCancel = useCallback((e: TouchEvent) => {
    e.preventDefault()
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    closePad()
  }, [closePad])

  // Click fallback for non-touch devices (desktop). Sends plain Tab only.
  const handleClick = useCallback(() => {
    if (disabled) return
    // If a touch interaction just fired, suppress the synthetic click
    if (hasSentKeyRef.current) {
      hasSentKeyRef.current = false
      return
    }
    triggerHaptic(10)
    onSendKey(TAB)
  }, [disabled, onSendKey])

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current)
      }
    }
  }, [])

  return (
    <>
      <button
        type="button"
        className={`
          terminal-key
          flex items-center justify-center
          h-11 min-w-[2.75rem] px-2.5
          text-sm font-medium
          bg-surface border border-border rounded-md
          active:bg-hover active:scale-95
          transition-transform duration-75
          select-none
          text-secondary
          ${disabled ? 'opacity-50' : ''}
          ${isOpen ? 'bg-hover scale-95' : ''}
        `}
        style={{ touchAction: 'none', WebkitTouchCallout: 'none', WebkitUserSelect: 'none' }}
        onTouchStart={handleTriggerTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        onClick={handleClick}
        disabled={disabled}
      >
        tab
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50 select-none"
          style={{
            touchAction: 'none',
            WebkitTouchCallout: 'none',
            WebkitUserSelect: 'none',
            userSelect: 'none',
          }}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchCancel}
        >
          <div className="absolute inset-0 bg-black/20" />

          <div
            className="absolute select-none"
            style={{
              left: padPosition.x,
              top: padPosition.y,
              transform: 'translate(-50%, -50%)',
              WebkitUserSelect: 'none',
              userSelect: 'none',
            }}
          >
            <div
              className="rounded-2xl bg-black/40 backdrop-blur-md border-2 border-white/20 select-none"
              style={{ padding: PADDING }}
            >
              <div
                className={`
                  flex items-center justify-center
                  rounded-lg text-base font-bold
                  select-none
                  transition-all duration-75
                  ${isCellActive
                    ? 'bg-accent text-white scale-110'
                    : 'bg-white/90 text-gray-800'}
                `}
                style={{
                  width: CELL_WIDTH,
                  height: CELL_HEIGHT,
                  WebkitUserSelect: 'none',
                  userSelect: 'none',
                }}
              >
                Shift+Tab
              </div>

              <div
                className="text-center text-white text-sm font-medium select-none h-5"
                style={{ marginTop: GAP + 2 }}
              >
                {isCellActive ? 'Release to send' : ' '}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
