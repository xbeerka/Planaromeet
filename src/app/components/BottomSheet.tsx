import { useEffect, useRef } from 'react';

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  maxHeight?: string;
}

export function BottomSheet({ open, onClose, children, maxHeight = '82vh' }: BottomSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Entry animation
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    if (open) {
      sheet.style.transform = 'translateY(100%)';
      sheet.style.transition = 'none';
      const r1 = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!sheetRef.current) return;
          sheet.style.transition = 'transform 320ms cubic-bezier(0.4,0,0.2,1)';
          sheet.style.transform = 'translateY(0)';
        });
      });
      return () => cancelAnimationFrame(r1);
    }
  }, [open]);

  // Touch gesture — close by drag-handle or boundary-swipe
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet || !open) return;

    let startY = 0;
    let currentY = 0;
    let dragging = false;
    let fromHandle = false;
    let scrollable: HTMLElement | null = null;
    let startScrollTop = 0;

    /** Walk up the DOM to find the nearest scrollable ancestor */
    const findScrollable = (el: HTMLElement): HTMLElement | null => {
      let cur: HTMLElement | null = el;
      while (cur && cur !== sheet) {
        const ov = window.getComputedStyle(cur).overflowY;
        if ((ov === 'auto' || ov === 'scroll') && cur.scrollHeight > cur.clientHeight + 2) {
          return cur;
        }
        cur = cur.parentElement;
      }
      return null;
    };

    const onStart = (e: TouchEvent) => {
      startY = e.touches[0].clientY;
      currentY = startY;
      dragging = false;
      fromHandle = !!(e.target as HTMLElement).closest('[data-drag-handle]');
      scrollable = fromHandle ? null : findScrollable(e.target as HTMLElement);
      startScrollTop = scrollable?.scrollTop ?? 0;
    };

    const onMove = (e: TouchEvent) => {
      currentY = e.touches[0].clientY;
      const dy = currentY - startY;
      if (dy <= 0) return; // Upward swipes never close the sheet

      const isAtTop = !scrollable || startScrollTop <= 0;
      const isAtBottom = !scrollable
        || (scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 5);

      if (fromHandle || isAtTop || isAtBottom) {
        e.preventDefault();
        dragging = true;
        sheet.style.transition = 'none';
        // Add resistance as the sheet drags further
        const resistance = Math.pow(dy, 0.85);
        sheet.style.transform = `translateY(${resistance}px)`;
      }
    };

    const onEnd = () => {
      const dy = currentY - startY;
      if (dragging && dy > 80) {
        sheet.style.transition = 'transform 250ms cubic-bezier(0.4,0,1,1)';
        sheet.style.transform = 'translateY(100%)';
        const id = setTimeout(() => onCloseRef.current(), 240);
        return () => clearTimeout(id);
      } else {
        sheet.style.transition = 'transform 320ms cubic-bezier(0.4,0,0.2,1)';
        sheet.style.transform = 'translateY(0)';
      }
      dragging = false;
    };

    sheet.addEventListener('touchstart', onStart, { passive: true });
    sheet.addEventListener('touchmove', onMove, { passive: false });
    sheet.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      sheet.removeEventListener('touchstart', onStart);
      sheet.removeEventListener('touchmove', onMove);
      sheet.removeEventListener('touchend', onEnd);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1200 }}>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'absolute', inset: 0,
          background: 'rgba(0,0,0,0.55)',
          backdropFilter: 'blur(3px)',
        }}
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          bottom: 0, left: 0, right: 0,
          height: maxHeight,
          maxHeight,
          backgroundColor: '#28292c',
          borderRadius: '16px 16px 0 0',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 -8px 40px rgba(0,0,0,0.6)',
          willChange: 'transform',
          transform: 'translateY(100%)',
        }}
      >
        {/* Drag handle */}
        <div
          data-drag-handle="true"
          style={{
            padding: '14px 0 8px',
            cursor: 'grab',
            touchAction: 'none',
            userSelect: 'none',
            flexShrink: 0,
          }}
        >
          <div style={{
            width: 40, height: 4, borderRadius: 2,
            backgroundColor: '#5f6368',
            margin: '0 auto',
          }} />
        </div>

        {/* Content */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {children}
        </div>
      </div>
    </div>
  );
}