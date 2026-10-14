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

const isOutsideViewport = (rect: DOMRect): boolean =>
  rect.bottom < 0 ||
  rect.right < 0 ||
  rect.top > window.innerHeight ||
  rect.left > window.innerWidth

export function TimetableGridDetailsPopover({
  anchor,
  title,
  children,
  onClose,
}: TimetableGridDetailsPopoverProps) {
  const titleId = useId()
  const popoverRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState(initialPosition)

  useLayoutEffect(() => {
    const updatePosition = () => {
      const popover = popoverRef.current
      if (!popover || !anchor.isConnected) {
        onClose(false)
        return
      }
      const anchorRect = anchor.getBoundingClientRect()
      if (isOutsideViewport(anchorRect)) {
        onClose(false)
        return
      }
      const overlayRect = popover.getBoundingClientRect()
      const next = getAnchoredOverlayPosition({
        anchor: anchorRect,
        overlayWidth: overlayRect.width,
        overlayHeight: overlayRect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      })
      setPosition({ ...next, ready: true })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchor, children, onClose])

  useEffect(() => {
    closeButtonRef.current?.focus()
  }, [])

  useEffect(() => {
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
  }, [anchor, onClose])

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

interface TimetableGridTooltipProps {
  id: string
  anchor: HTMLElement
  text: string
}

export function TimetableGridTooltip({
  id,
  anchor,
  text,
}: TimetableGridTooltipProps) {
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(initialPosition)

  useLayoutEffect(() => {
    const updatePosition = () => {
      const tooltip = tooltipRef.current
      if (!tooltip || !anchor.isConnected) return
      const anchorRect = anchor.getBoundingClientRect()
      if (isOutsideViewport(anchorRect)) {
        setPosition(current => current.ready
          ? { ...current, ready: false }
          : current)
        return
      }
      const rect = tooltip.getBoundingClientRect()
      const next = getAnchoredOverlayPosition({
        anchor: anchorRect,
        overlayWidth: rect.width,
        overlayHeight: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        gap: 4,
      })
      setPosition({ ...next, ready: true })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchor, text])

  return createPortal(
    <div
      ref={tooltipRef}
      id={id}
      className="timetable-grid-details-tooltip"
      role="tooltip"
      style={{
        top: position.top,
        left: position.left,
        visibility: position.ready ? 'visible' : 'hidden',
      }}
    >
      {text}
    </div>,
    document.body,
  )
}
