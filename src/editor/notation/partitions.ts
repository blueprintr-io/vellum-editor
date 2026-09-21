import type { Shape } from '@/store/types';

export type Partitions = { left?: number; right?: number; top?: number };
export type PartitionKey = keyof Partitions;
const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));

/** Widths are world units, like strokes and the callout tail. Scale them
 * down together only when a resized shape no longer has room for its text. */
export function notationPartitions(s: Shape) {
  const p = s.notation?.partitions ?? {};
  const type = s.notation?.type;
  const storage = type === 'flow-internal-storage';
  const process = type === 'flow-predefined-process';
  let left =
    storage || process
      ? Math.max(0, p.left ?? Math.min(14, s.w * 0.15, s.h * 0.2))
      : 0;
  let right = process ? Math.max(0, p.right ?? Math.min(14, s.w * 0.15)) : 0;
  if (left + right > s.w * 0.85) {
    const ratio = (s.w * 0.85) / (left + right);
    left *= ratio;
    right *= ratio;
  }
  const top = storage
    ? clamp(p.top ?? Math.min(14, Math.min(s.w, s.h) * 0.2), s.h * 0.85)
    : 0;
  return { left, right, top };
}

export function partitionHandles(
  s: Shape,
): { key: PartitionKey; x: number; y: number; label: string }[] {
  const p = notationPartitions(s);
  if (s.notation?.type === 'flow-predefined-process')
    return [
      {
        key: 'left',
        x: s.x + p.left,
        y: s.y + s.h / 2,
        label: 'Left compartment width',
      },
      {
        key: 'right',
        x: s.x + s.w - p.right,
        y: s.y + s.h / 2,
        label: 'Right compartment width',
      },
    ];
  if (s.notation?.type === 'flow-internal-storage')
    return [
      {
        key: 'left',
        x: s.x + p.left,
        y: s.y + s.h / 2,
        label: 'Left compartment width',
      },
      {
        key: 'top',
        x: s.x + s.w / 2,
        y: s.y + p.top,
        label: 'Top compartment height',
      },
    ];
  return [];
}

export function dragPartition(
  s: Shape,
  key: PartitionKey,
  x: number,
  y: number,
): Partial<Shape> {
  if (!s.notation || !partitionHandles(s).some((h) => h.key === key)) return {};
  const p = notationPartitions(s);
  const value =
    key === 'left'
      ? clamp(x - s.x, s.w * 0.85 - p.right)
      : key === 'right'
        ? clamp(s.x + s.w - x, s.w * 0.85 - p.left)
        : clamp(y - s.y, s.h * 0.85);
  return { notation: { ...s.notation, partitions: { ...p, [key]: value } } };
}
