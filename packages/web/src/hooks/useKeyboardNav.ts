import { useEffect, useRef } from 'react';

export interface KeyboardNavHandlers {
  prev: () => void;
  next: () => void;
  first: () => void;
  last: () => void;
  flip?: () => void;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** Global ←/→/Home/End navigation (and `f` to flip) that ignores typing in form fields. */
export function useKeyboardNav(handlers: KeyboardNavHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (isEditable(e.target)) return;
      switch (e.key) {
        case 'ArrowLeft':
          ref.current.prev();
          break;
        case 'ArrowRight':
          ref.current.next();
          break;
        case 'Home':
          ref.current.first();
          break;
        case 'End':
          ref.current.last();
          break;
        case 'f':
        case 'F':
          ref.current.flip?.();
          return;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
