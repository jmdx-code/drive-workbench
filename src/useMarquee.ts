import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type Dispatch,
  type SetStateAction,
} from 'react';
export function useMarquee(
  selected: Set<string>,
  setSelected: Dispatch<SetStateAction<Set<string>>>,
) {
  const [rect, setRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const dragged = useRef(false);
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => () => cleanup.current(), []);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (
      e.button !== 0 ||
      e.pointerType === 'touch' ||
      (e.target as HTMLElement).closest('button,input,a,select,thead')
    )
      return;
    if (!e.currentTarget.querySelector('tr[data-selectable="true"]')) return;
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    const host = e.currentTarget,
      x = e.clientX,
      y = e.clientY,
      initial = e.ctrlKey || e.metaKey ? new Set(selected) : new Set<string>();
    dragged.current = false;
    const move = (p: globalThis.PointerEvent) => {
      if (!dragged.current && Math.hypot(p.clientX - x, p.clientY - y) < 6) return;
      dragged.current = true;
      p.preventDefault();
      document.body.classList.add('selecting-files');
      window.getSelection()?.removeAllRanges();
      const bounds = host.getBoundingClientRect();
      const headerBottom =
        host.querySelector('thead')?.getBoundingClientRect().bottom || bounds.top;
      const left = Math.max(bounds.left, Math.min(x, p.clientX)),
        top = Math.max(bounds.top, headerBottom, Math.min(y, p.clientY)),
        right = Math.max(left, Math.min(bounds.right, Math.max(x, p.clientX))),
        bottom = Math.max(top, Math.min(bounds.bottom, Math.max(y, p.clientY)));
      setRect({ left, top, width: right - left, height: bottom - top });
      const ids = new Set(initial);
      host
        .querySelectorAll<HTMLTableRowElement>('tr[data-file-id][data-selectable="true"]')
        .forEach((row) => {
          const b = row.getBoundingClientRect();
          if (b.bottom >= top && b.top <= bottom && b.right >= left && b.left <= right)
            ids.add(row.dataset.fileId!);
        });
      setSelected(ids);
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      document.body.classList.remove('selecting-files');
      setRect(null);
      setTimeout(() => {
        dragged.current = false;
      }, 50);
    };
    cleanup.current();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
    window.addEventListener('blur', finish, { once: true });
    cleanup.current = finish;
  };
  return { rect, dragged, onPointerDown };
}
