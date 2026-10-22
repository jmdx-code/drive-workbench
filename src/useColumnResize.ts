import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';

export const TABLE_FIXED_WIDTH = 106;
export const COLUMN_DEFAULTS = {
  name: 280,
  size: 120,
  createdTime: 104,
  modifiedTime: 104,
  owner: 100,
  permissions: 300,
};
export type ColumnKey = keyof typeof COLUMN_DEFAULTS;
type Widths = Record<ColumnKey, number>;
const MINIMUMS: Widths = {
  name: 160,
  size: 100,
  createdTime: 100,
  modifiedTime: 100,
  owner: 80,
  permissions: 160,
};
const STORAGE_KEY = 'workbench.columnWidths';
const clamp = (key: ColumnKey, width: number) =>
  Math.max(MINIMUMS[key], Math.min(1600, Math.round(width)));
const save = (widths: Widths, stretchColumn: 'all' | 'name' | 'permissions') => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...widths, stretchColumn }));
  } catch {
    /* Presentation preferences are optional. */
  }
};

export function useColumnResize(container: RefObject<HTMLDivElement | null>) {
  const [available, setAvailable] = useState(0);
  const [stretchColumn, setStretchColumn] = useState<'all' | 'name' | 'permissions'>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')?.stretchColumn;
      return value === 'name' || value === 'permissions' ? value : 'all';
    } catch {
      return 'all';
    }
  });
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () => setAvailable(element.clientWidth);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [container]);
  const nextStretch = (key: ColumnKey) => (key === 'name' ? 'permissions' : 'name');

  const [widths, setWidths] = useState<Widths | null>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (
        saved &&
        Object.keys(COLUMN_DEFAULTS)
          .filter((key) => key !== 'owner')
          .every((key) => Number.isFinite(saved[key]))
      )
        return Object.fromEntries(
          Object.keys(COLUMN_DEFAULTS).map((key) => [
            key,
            clamp(key as ColumnKey, saved[key] ?? COLUMN_DEFAULTS[key as ColumnKey]),
          ]),
        ) as Widths;
    } catch {
      /* Use the default layout. */
    }
    return null;
  });
  const drag = useRef<{
    key: ColumnKey;
    pointerId: number;
    x: number;
    initial: Widths;
    last: Widths;
  } | null>(null);
  useEffect(() => () => document.body.classList.remove('resizing-columns'), []);
  const actualWidths = (handle: HTMLElement): Widths =>
    Object.fromEntries(
      [...handle.closest('tr')!.querySelectorAll<HTMLElement>('th[data-column]')].map((cell) => [
        cell.dataset.column,
        cell.getBoundingClientRect().width,
      ]),
    ) as Widths;
  const commit = () => {
    if (drag.current) save(drag.current.last, stretchColumn);
    drag.current = null;
    document.body.classList.remove('resizing-columns');
  };
  const bindings = (key: ColumnKey) => ({
    role: 'separator',
    tabIndex: 0,
    'aria-orientation': 'vertical' as const,
    'aria-valuemin': MINIMUMS[key],
    'aria-valuemax': 1600,
    'aria-valuenow': fitted[key],
    onPointerDown(e: PointerEvent<HTMLSpanElement>) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const initial = actualWidths(e.currentTarget);
      drag.current = { key, pointerId: e.pointerId, x: e.clientX, initial, last: initial };
      setStretchColumn(nextStretch(key));
      setWidths(initial);
      document.body.classList.add('resizing-columns');
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove(e: PointerEvent<HTMLSpanElement>) {
      const current = drag.current;
      if (!current || current.key !== key || current.pointerId !== e.pointerId) return;
      const next = {
        ...current.initial,
        [key]: clamp(key, current.initial[key] + e.clientX - current.x),
      };
      current.last = next;
      setWidths(next);
    },
    onPointerUp: commit,
    onPointerCancel: commit,
    onLostPointerCapture: commit,
    onClick(e: React.MouseEvent) {
      e.stopPropagation();
    },
    onDoubleClick(e: React.MouseEvent<HTMLSpanElement>) {
      e.preventDefault();
      e.stopPropagation();
      const next = { ...actualWidths(e.currentTarget), [key]: COLUMN_DEFAULTS[key] };
      setWidths(next);
      setStretchColumn(nextStretch(key));
      save(next, nextStretch(key));
    },
    onKeyDown(e: KeyboardEvent<HTMLSpanElement>) {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const current = actualWidths(e.currentTarget);
      const next = {
        ...current,
        [key]:
          e.key === 'Home'
            ? COLUMN_DEFAULTS[key]
            : clamp(key, current[key] + (e.key === 'ArrowLeft' ? -16 : 16)),
      };
      setWidths(next);
      setStretchColumn(nextStretch(key));
      save(next, nextStretch(key));
    },
  });
  const fitted = { ...(widths || COLUMN_DEFAULTS) };
  const extra = Math.max(
    0,
    available - TABLE_FIXED_WIDTH - Object.values(fitted).reduce((sum, width) => sum + width, 0),
  );
  if (stretchColumn === 'all') {
    fitted.name += extra * 0.5;
    fitted.owner += extra * 0.15;
    fitted.permissions += extra * 0.35;
  } else fitted[stretchColumn] += extra;
  const reset = () => {
    setWidths(null);
    setStretchColumn('all');
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* Preferences are optional. */
    }
  };
  return { widths: fitted, bindings, reset };
}
