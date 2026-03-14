/**
 * ResizablePanel — generic wrapper that makes a sidebar resizable.
 *
 * Renders children inside a flex container with a drag handle on one side.
 * The handle can be placed on the "left" or "right" edge (i.e. the side
 * facing the center content area).
 *
 * Width is stored in local state and clamped to [minWidth, maxWidth].
 * During a drag the `dragging` class is applied to the handle for styling.
 */

import { useRef, useState, useCallback, useEffect } from 'preact/hooks'
import type { ComponentChildren } from 'preact'

export interface ResizablePanelProps {
  /** Which edge the resize handle sits on */
  side: 'left' | 'right'
  /** Initial / default width in px */
  defaultWidth: number
  /** Minimum width in px */
  minWidth?: number
  /** Maximum width in px */
  maxWidth?: number
  /** Extra className applied to the outer wrapper */
  class?: string
  children: ComponentChildren
}

export function ResizablePanel({
  side,
  defaultWidth,
  minWidth = 160,
  maxWidth = 500,
  class: className = '',
  children,
}: ResizablePanelProps) {
  const [width, setWidth] = useState(defaultWidth)
  const widthRef = useRef(width)
  widthRef.current = width

  const dragging = useRef(false)
  const startX = useRef(0)
  const startW = useRef(0)
  const handleRef = useRef<HTMLDivElement>(null)

  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      e.preventDefault()
      dragging.current = true
      startX.current = e.clientX
      startW.current = widthRef.current
      handleRef.current?.classList.add('dragging')
      handleRef.current?.setPointerCapture(e.pointerId)
    },
    [],
  )

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!dragging.current) return
      const delta = e.clientX - startX.current
      // When handle is on the right side of the panel, dragging right = wider
      // When handle is on the left side, dragging left = wider
      const newW = side === 'right' ? startW.current + delta : startW.current - delta
      setWidth(Math.round(Math.min(maxWidth, Math.max(minWidth, newW))))
    },
    [side, minWidth, maxWidth],
  )

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      if (!dragging.current) return
      dragging.current = false
      handleRef.current?.classList.remove('dragging')
      handleRef.current?.releasePointerCapture(e.pointerId)
    },
    [],
  )

  // Attach move/up listeners to the handle (pointer capture keeps them active)
  useEffect(() => {
    const el = handleRef.current
    if (!el) return
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    return () => {
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
    }
  }, [onPointerMove, onPointerUp])

  const handle = (
    <div
      ref={handleRef}
      class="panel-resize-handle"
      onPointerDown={onPointerDown}
    />
  )

  return (
    <div
      class={`resizable-panel resizable-panel--${side} ${className}`}
      style={{ width: `${width}px` }}
    >
      {side === 'left' && handle}
      <div class="resizable-panel__content">{children}</div>
      {side === 'right' && handle}
    </div>
  )
}
