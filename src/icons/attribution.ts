/** Collect recorded artwork provenance across all shape kinds, including
 * rack equipment. Vendor notices are grouped by holder; collection notices
 * by prefix. The collector does not infer a license or decide which notices
 * satisfy an artwork provider's terms. */

import type { DiagramState, Shape } from '@/store/types';

export type VendorAttribution = {
  holder: string;
  /** Set of source URLs we found - surfaced as "Brand guidelines" links so
   *  users can verify usage without leaving the app. Most documents will have
   *  exactly one per vendor. */
  guidelinesUrls: string[];
  /** Count of icons from this vendor in the document - useful for the panel
   *  to render "AWS (3 icons)" without re-walking. */
  count: number;
};

export type CollectionAttribution = {
  /** Iconify prefix - `mdi`, `tabler`, etc. */
  prefix: string;
  /** Author / holder name as published by Iconify. */
  holder: string;
  license: string;
  sourceUrl: string;
  count: number;
};

export type CollectedAttributions = {
  vendors: VendorAttribution[];
  collections: CollectionAttribution[];
};

export function collectAttributions(diagram: DiagramState): CollectedAttributions {
  const vendors = new Map<string, VendorAttribution>();
  const collections = new Map<string, CollectionAttribution>();

  for (const shape of diagram.shapes) {
    const att = shape.iconAttribution;
    if (!att) continue;

    if (att.source === 'vendor') {
      const existing = vendors.get(att.holder);
      if (existing) {
        existing.count += 1;
        if (att.guidelinesUrl && !existing.guidelinesUrls.includes(att.guidelinesUrl)) {
          existing.guidelinesUrls.push(att.guidelinesUrl);
        }
      } else {
        vendors.set(att.holder, {
          holder: att.holder,
          guidelinesUrls: att.guidelinesUrl ? [att.guidelinesUrl] : [],
          count: 1,
        });
      }
    } else {
      const prefix = att.iconId.split(':')[0];
      const existing = collections.get(prefix);
      if (existing) {
        existing.count += 1;
      } else {
        collections.set(prefix, {
          prefix,
          holder: att.holder,
          license: att.license,
          sourceUrl: att.sourceUrl,
          count: 1,
        });
      }
    }
  }

  return {
    vendors: [...vendors.values()].sort((a, b) => a.holder.localeCompare(b.holder)),
    collections: [...collections.values()].sort((a, b) => a.prefix.localeCompare(b.prefix)),
  };
}

/** Returns true if the document contains any icons that need attribution.
 *  Used by the panel mount logic to hide the section entirely on icon-free
 *  diagrams. Faster than `collectAttributions` because it short-circuits. */
export function hasAttributableIcons(diagram: DiagramState): boolean {
  for (const shape of diagram.shapes) {
    if (shape.iconAttribution) return true;
  }
  return false;
}

/** Probe a single shape for its attribution - used by the inspector panel
 *  to render the license chip when a single icon is selected. */
export function getShapeAttribution(shape: Shape) {
  return shape.iconAttribution;
}
