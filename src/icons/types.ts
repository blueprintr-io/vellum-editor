// TRADEMARK-COMPLIANCE: ManifestEntry now carries optional `b` (isBrandedIcon)
// + `bh` (brand holder display name) so the picker can render the two-line
// "SVG: <license> · Brand: <vendor>®" badge instead of the single license
// label. Detection is in src/lib/branded-icon-namespaces.ts; the manifest
// loader stamps each entry on first read.

/* Icon catalog types - separate from the diagram shape types.
 *
 * Vendor icons live in /public/icons/manifest.json (lightweight index) and
 * /public/icons/packs/<vendor>.json (full data, lazy-loaded). The manifest
 * is empty in the offline desktop build - vellum-shell layers a non-empty
 * manifest on top via its own deployment.
 *
 * Re IconAttribution: the canonical home is src/store/types.ts (it's part of
 * the diagram file format). We re-import it here so callers don't reach across
 * the store boundary just to talk about an icon's license. */

import type { IconAttribution, IconConstraints } from '@/store/types';

export type { IconAttribution, IconConstraints };

/* Manifest entry: one row per icon in the master index
 *
 *
 * Field names are kept terse on purpose - at 5,000+ entries the manifest is
 * the largest JSON the client downloads at boot, and these short keys add up.
 * Don't expand them without compressing the manifest first. */
export type ManifestEntry = {
  /** "<vendor>/<slug>" - globally unique within the vendor namespace. */
  id: string;
  /** Vendor key - joins back to `Manifest.vendors[v]`. */
  v: string;
  /** Display name shown in result cards. */
  n: string;
  /** Category ("compute", "storage"...) - not yet exposed in the UI but
   *  reserved for category facets (future). */
  c: string;
  /** Search keywords - exact-match boost terms ("ec2", "vm", "instance"). */
  k: string[];
  /** True if this icon depicts a vendor brand / trademark (AWS service icon,
   *  Kubernetes wheel, etc.) and the picker should render the two-line
   *  "SVG: <license> · Brand: <holder>®" badge. Filled in by the manifest
   *  loader from the namespace detector - manifests can also set it
   *  explicitly to override. */
  b?: boolean;
  /** Display holder name for the "Brand: <holder>®" line. Filled in by the
   *  manifest loader if missing. */
  bh?: string;
  /** True if the icon's paint is effectively monochrome (single non-grey
   *  color, or all greyscale) and the build script has rewritten its
   *  fills/strokes to `currentColor`. Picker tiles and the canvas use this
   *  to opt into the ink-driven recolour without having to re-run the
   *  detector on the raw SVG. Computed at build time by build-icon-manifest;
   *  callers should treat its absence as "unknown / not monochrome." */
  m?: boolean;
  /** Original chromatic colour the build script replaced with
   *  `currentColor`. Set when the source icon had one distinct non-grey
   *  hue (AWS Architecture group icons, single-colour brand logos…). The
   *  canvas uses this as the "Auto" tint when the user hasn't picked one,
   *  so the default render matches the icon's brand colour instead of
   *  falling all the way back to `var(--ink)`. Strict-grey icons
   *  (Red Hat, lucide) omit this and inherit the ink colour as before. */
  mt?: string;
};

/** A vendor pack as registered in the manifest. SVG bytes live in `packUrl`,
 *  fetched lazily on first use. */
export type ManifestVendor = {
  /** Display name ("Amazon Web Services"). */
  name: string;
  /** Icon-set version surfaced in the UI ("v2.18"). Lets users tell at a
   *  glance whether a refresh has happened. */
  version: string;
  /** URL of the per-vendor pack JSON, served from /public/icons/packs/. */
  packUrl: string;
  /** Trademark / usage notice - displayed in AttributionsPanel and stamped
   *  onto each shape's IconAttribution at drop time. */
  trademark: {
    holder: string;
    notice: string;
    guidelinesUrl: string;
  };
  /** Pack-level capability flags written by the iconpacks build script. The
   *  inspector keys off these to decide which controls to expose for an
   *  icon shape - e.g. parametric packs (lucide) get a stroke-width slider
   *  on top of the existing tint swatch, vendor packs (AWS, Cisco) don't.
   *  Optional: missing means "no special capabilities" (the default for
   *  trademark-locked vendor art). */
  capabilities?: ManifestVendorCapabilities;
};

/** Pack-level feature flags. New flags added here must also be emitted by
 *  the build script (vellum-iconpacks/scripts/build-icon-manifest.ts) and
 *  declared in its `VendorMeta.capabilities` type. Keep the shapes in sync. */
export type ManifestVendorCapabilities = {
  /** Single-stroke, monochrome icons whose stroke-width and tint are
   *  user-adjustable at render time. The canvas applies the user's
   *  `shape.strokeWidth` (or the lucide default of 2) as a CSS style on
   *  the outer wrapper `<svg>` so it cascades into the icon's children.
   *  Currently only set on the lucide pack. */
  parametric?: boolean;
};

export type Manifest = {
  /** Build version - bump this in the build script so clients can invalidate
   *  the cache when the catalog changes. */
  version: string;
  vendors: Record<string, ManifestVendor>;
  icons: ManifestEntry[];
};

/* Per-vendor pack: full data, fetched on first use
 *
 *
 * Bytes are inlined as SVG strings. We do this at build time (sanitized) so
 * the runtime never has to parse arbitrary user SVGs. */
export type VendorIcon = {
  id: string;
  vendor: string;
  name: string;
  category: string;
  keywords: string[];
  /** Sanitized `<svg>...</svg>` markup, ready to embed in the canvas. */
  svg: string;
  /** Optional theme variants - light/dark backgrounds. The renderer picks one
   *  based on the canvas paper colour at drop time. */
  variants?: { light?: string; dark?: string };
};

export type VendorPack = {
  vendor: string;
  version: string;
  icons: VendorIcon[];
};

/* Combined search row used by the UI - vendor only in the offline core. */
export type SearchRow = { source: 'vendor'; entry: ManifestEntry; vendor: ManifestVendor };

/** Drop-time payload - minimal so it fits in the dataTransfer. The canvas
 *  drop handler resolves the actual SVG bytes via `resolveIcon`. */
export type IconDragPayload = { source: 'vendor'; iconId: string; vendor: string };

/** Resolved icon ready to construct an IconShape from. */
export type ResolvedIcon = {
  svg: string;
  attribution: IconAttribution;
  constraints: IconConstraints;
  /** Default w/h for the dropped shape. */
  defaultSize: { w: number; h: number };
};
