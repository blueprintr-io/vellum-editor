import { create } from 'zustand';
import { arrangeTargets, planArrange } from '@/store/arrange';
import type { Connector, LayerMode, Shape } from '@/store/types';

export type ArrangePreviewRequest = {
  command: 'layout-row' | 'layout-column';
  gap: number;
  selectedIds: string[];
};

type ArrangePreviewState = {
  preview: ArrangePreviewRequest | null;
  setPreview: (preview: ArrangePreviewRequest | null) => void;
};

/** Transient chrome state: never persisted, never part of diagram history.
 * Copy the selection so a preview remains tied to the gesture that opened it. */
export const useArrangePreview = create<ArrangePreviewState>((set) => ({
  preview: null,
  setPreview: (preview) => set({
    preview: preview ? { ...preview, selectedIds: [...preview.selectedIds] } : null,
  }),
}));

export function arrangePreviewMatchesSelection(
  preview: ArrangePreviewRequest,
  selectedIds: readonly string[],
): boolean {
  return preview.selectedIds.length === selectedIds.length &&
    preview.selectedIds.every((id, index) => id === selectedIds[index]);
}

/** Uses the exact same plan as Apply. Only independent roots get ghost
 * outlines; a group's children move with it and should not add visual noise. */
export function arrangePreviewDestinations(
  preview: ArrangePreviewRequest,
  shapes: readonly Shape[],
  connectors: readonly Connector[],
  layerMode: LayerMode,
): { before: Shape; after: Shape }[] {
  if (!Number.isFinite(preview.gap)) return [];
  const targets = arrangeTargets(shapes, preview.selectedIds, layerMode);
  if (targets.length < 2) return [];
  const plan = planArrange(shapes, connectors, preview.selectedIds, preview.command, layerMode, { gap: preview.gap });
  const patches = new Map(plan.patches.map(({ id, patch }) => [id, patch]));
  return targets.map((before) => ({ before, after: { ...before, ...patches.get(before.id) } }));
}
