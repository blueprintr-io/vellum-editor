import type {
  IconAttribution,
  IconConstraints,
} from '@/store/types';
import type { IconDragPayload, ResolvedIcon } from './types';
import { getManifest, loadVendorPack } from './manifest';
import { sanitizeSvg } from '@/lib/sanitize-svg';

// Vendor icons keep colours and aspect ratio for trademark safety. Rotation
// is a layout choice, not a brand modification, so we leave it open.
// Monochrome icons (manifest entry `m: true`) opt OUT of lockColors because
// the build script has already rewritten their paint to `currentColor` -
// the canvas's ink-tint cascade is the intended UX, not a trademark
// violation.
const VENDOR_CONSTRAINTS_LOCKED: IconConstraints = {
  lockColors: true,
  lockAspect: true,
  lockRotation: false,
};
const VENDOR_CONSTRAINTS_MONO: IconConstraints = {
  lockColors: false,
  lockAspect: true,
  lockRotation: false,
};

const DEFAULT_SIZE = { w: 64, h: 64 };

export async function resolveIcon(payload: IconDragPayload): Promise<ResolvedIcon> {
  return resolveVendor(payload.iconId, payload.vendor);
}

async function resolveVendor(iconId: string, vendorKey: string): Promise<ResolvedIcon> {
  const pack = await loadVendorPack(vendorKey);
  const icon = pack.icons.find((i) => i.id === iconId);
  if (!icon) throw new Error(`vendor icon not found: ${iconId}`);
  const manifest = getManifest();
  const vendor = manifest?.vendors[vendorKey];
  if (!vendor) throw new Error(`vendor not in manifest: ${vendorKey}`);
  const entry = manifest?.icons.find((e) => e.id === iconId);

  const attribution: IconAttribution = {
    source: 'vendor',
    iconId,
    holder: vendor.trademark.holder,
    license: 'Trademark',
    sourceUrl: vendor.trademark.guidelinesUrl,
    guidelinesUrl: vendor.trademark.guidelinesUrl,
  };

  return {
    svg: sanitizeSvg(icon.svg),
    attribution,
    constraints: entry?.m ? VENDOR_CONSTRAINTS_MONO : VENDOR_CONSTRAINTS_LOCKED,
    defaultSize: DEFAULT_SIZE,
  };
}

export { sanitizeSvg } from '@/lib/sanitize-svg';
