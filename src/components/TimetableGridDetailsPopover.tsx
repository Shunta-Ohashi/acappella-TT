import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { getAnchoredOverlayPosition } from '../ui/timetableGridDetailsPresentation'
import { useRetainedAppActivity } from '../ui/nativeDialogActivity'

interface TimetableGridDetailsPopoverProps {
  anchor: HTMLElement
  title: string
  children: ReactNode
  onClose: (restoreFocus: boolean) => void
}

interface OverlayPosition {
  top: number
  left: number
  maxHeight: number
  ready: boolean
}

const initialPosition: OverlayPosition = {
  top: 0,
  left: 0,
  maxHeight: 320,
  ready: false,
}

interface CurrentViewportBounds {
  left: number
  top: number
  width: number
  height: number
}

const getCurrentViewportBounds = (): CurrentViewportBounds => {
  const visualViewport = window.visualViewport
  return visualViewport
    ? {
        left: visualViewport.offsetLeft,
        top: visualViewport.offsetTop,
        width: visualViewport.width,
        height: visualViewport.height,
      }
    : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
}

const isOutsideViewport = (
  rect: DOMRect,
  viewport: CurrentViewportBounds,
): boolean =>
  rect.bottom < viewport.top ||
  rect.right < viewport.left ||
  rect.top > viewport.top + viewport.height ||
  rect.left > viewport.left + viewport.width

const getCurrentOverlayPosition = (
  anchorRect: DOMRect,
  overlayRect: DOMRect,
  options: { gap?: number; horizontalAlignment?: 'start' | 'end' } = {},
) => {
  const viewport = getCurrentViewportBounds()
  return {
    viewport,
    position: getAnchoredOverlayPosition({
      anchor: anchorRect,
      overlayWidth: overlayRect.width,
      overlayHeight: overlayRect.height,
      viewportLeft: viewport.left,
      viewportTop: viewport.top,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      ...options,
    }),
  }
}

const observeViewportChanges = (updatePosition: () => void): (() => void) => {
  const visualViewport = window.visualViewport
  window.addEventListener('resize', updatePosition)
  window.addEventListener('scroll', updatePosition, true)
  visualViewport?.addEventListener('resize', updatePosition)
  visualViewport?.addEventListener('scroll', updatePosition)
  return () => {
    window.removeEventListener('resize', updatePosition)
    window.removeEventListener('scroll', updatePosition, true)
    visualViewport?.removeEventListener('resize', updatePosition)
    visualViewport?.removeEventListener('scroll', updatePosition)
  }
}

export function TimetableGridDetailsPopover({
  anchor,
  title,
  children,
  onClose,
}: TimetableGridDetailsPopoverProps) {
  const active = useRetainedAppActivity()
  const titleId = useId()
  const popoverRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState(initialPosition)

  useLayoutEffect(() => {
    if (!active) return
    const updatePosition = () => {
      const popover = popoverRef.current
      if (!popover || !anchor.isConnected) {
        onClose(false)
        return
      }
      const anchorRect = anchor.getBoundingClientRect()
      const overlayRect = popover.getBoundingClientRect()
      const { viewport, position: next } = getCurrentOverlayPosition(
        anchorRect,
        overlayRect,
      )
      if (isOutsideViewport(anchorRect, viewport)) {
        onClose(false)
        return
      }
      setPosition({ ...next, ready: true })
    }

    updatePosition()
    return observeViewportChanges(updatePosition)
  }, [active, anchor, children, onClose])

  useEffect(() => {
    if (!active) return
    closeButtonRef.current?.focus()
  }, [active])

  useEffect(() => {
    if (!active) return
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (popoverRef.current?.contains(target) || anchor.contains(target)) return
      onClose(false)
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose(true)
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [active, anchor, onClose])

  if (!active) return null

  return createPortal(
    <div
      ref={popoverRef}
      className="timetable-grid-details-popover"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      style={{
        top: position.top,
        left: position.left,
        maxHeight: position.maxHeight,
        visibility: position.ready ? 'visible' : 'hidden',
      }}
    >
      <header className="timetable-grid-details-popover__header">
        <h4 id={titleId}>{title}</h4>
        <button
          ref={closeButtonRef}
          type="button"
          aria-label={`${title}を閉じる`}
          onClick={() => onClose(true)}
        >
          閉じる
        </button>
      </header>
      <div className="timetable-grid-details-popover__body">
        {children}
      </div>
    </div>,
    document.body,
  )
}

interface TimetableGridRowActionsMenuProps {
  anchor: HTMLElement
  accessibleLabel: string
  children: ReactNode
  onClose: (restoreFocus: boolean) => void
}

export function TimetableGridRowActionsMenu({
  anchor,
  accessibleLabel,
  children,
  onClose,
}: TimetableGridRowActionsMenuProps) {
  const active = useRetainedAppActivity()
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(initialPosition)

  useLayoutEffect(() => {
    if (!active) return
    const updatePosition = () => {
      const menu = menuRef.current
      if (!menu || !anchor.isConnected) {
        onClose(false)
        return
      }
      const anchorRect = anchor.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      const { viewport, position: next } = getCurrentOverlayPosition(
        anchorRect,
        menuRect,
        { horizontalAlignment: 'end', gap: 3 },
      )
      if (isOutsideViewport(anchorRect, viewport)) {
        onClose(false)
        return
      }
      setPosition({ ...next, ready: true })
    }

    updatePosition()
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(updatePosition)
    if (menuRef.current) resizeObserver?.observe(menuRef.current)
    const stopObservingViewport = observeViewportChanges(updatePosition)
    return () => {
      resizeObserver?.disconnect()
      stopObservingViewport()
    }
  }, [active, anchor, children, onClose])

  useEffect(() => {
    if (!active) return
    const menu = menuRef.current
    const firstControl = menu?.querySelector<HTMLElement>(
      'button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )
    const focusTarget = firstControl ?? menu
    focusTarget?.focus()
  }, [active])

  useEffect(() => {
    if (!active) return
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (menuRef.current?.contains(target) || anchor.contains(target)) return
      onClose(false)
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose(true)
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [active, anchor, onClose])

  if (!active) return null

  return createPortal(
    <div
      ref={menuRef}
      className="timetable-grid__row-actions-menu"
      role="dialog"
      aria-modal="false"
      aria-label={accessibleLabel}
      tabIndex={-1}
      style={{
        top: position.top,
        left: position.left,
        maxHeight: position.maxHeight,
        visibility: position.ready ? 'visible' : 'hidden',
      }}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  )
}

interface TimetableGridTooltipProps {
  id: string
  anchor: HTMLElement
  text: string
  onDismiss: () => void
}

export function TimetableGridTooltip({
  id,
  anchor,
  text,
  onDismiss,
}: TimetableGridTooltipProps) {
  const active = useRetainedAppActivity()
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(initialPosition)

  useLayoutEffect(() => {
    if (!active) return
    const updatePosition = () => {
      const tooltip = tooltipRef.current
      if (!tooltip) return
      if (!anchor.isConnected) {
        onDismiss()
        return
      }
      const anchorRect = anchor.getBoundingClientRect()
      const rect = tooltip.getBoundingClientRect()
      const { viewport, position: next } = getCurrentOverlayPosition(
        anchorRect,
        rect,
        { gap: 4 },
      )
      if (isOutsideViewport(anchorRect, viewport)) {
        onDismiss()
        return
      }
      setPosition({ ...next, ready: true })
    }

    updatePosition()
    return observeViewportChanges(updatePosition)
  }, [active, anchor, onDismiss, text])

  if (!active) return null

  return createPortal(
    <div
      ref={tooltipRef}
      id={id}
      className="timetable-grid-details-tooltip"
      role="tooltip"
      style={{
        top: position.top,
        left: position.left,
        maxHeight: position.maxHeight,
        visibility: position.ready ? 'visible' : 'hidden',
      }}
    >
      {text}
    </div>,
    document.body,
  )
}
