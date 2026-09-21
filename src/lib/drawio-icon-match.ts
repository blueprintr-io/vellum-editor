/* draw.io → Vellum icon matcher.
 *
 * Most cloud-architecture diagrams in draw.io use stencil shapes whose
 * style strings carry the icon's identity in a structured form, e.g.
 * `shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lambda;`. This
 * module pulls a hint out of the style and resolves it against Vellum's
 * vendor icon packs so the imported diagram comes in with proper icons
 * (kind:'icon' shapes with iconSvg + attribution) rather than blank rects.
 *
 * The match is scored, not exact - draw.io's stencil naming is close but
 * not identical to our icon ids ("ec2_instance" vs "amazon-ec2") and we
 * accept a fuzzy keyword match when an exact slug match isn't available. */

import type {
  Manifest,
  ManifestEntry,
  ManifestVendor,
  VendorIcon,
  VendorPack,
} from '@/icons/types';
import type { IconAttribution, IconConstraints } from '@/store/types';

/** A normalized hint extracted from a draw.io shape's style string.
 *  Carries the canonical slug and an ordered list of candidate vendor
 *  pack keys (most-specific first) for the matcher to search. */
export type IconHint = {
  /** Lowercased dash-normalized slug (e.g. "amazon-redshift", "lambda",
   *  "virtual-machine"). Drives the exact-id and name-equality match
   *  branches; the keyword-search fallback uses a tokenized form. */
  slug: string;
  /** Ordered candidate vendor pack keys to load + search. The matcher
   *  walks these in order and returns the first hit, so put more
   *  specific / higher-fidelity packs first (e.g. aws-service before
   *  aws-resource). */
  vendorKeys: string[];
};

/** Exhaustive enough for the major architecture stencil libraries. Order
 *  matters within each entry - earlier vendors are tried first. Anything
 *  not listed here falls through to the image-path heuristic. */
const VENDOR_PREFIX_MAP: Record<string, string[]> = {
  // AWS - three vintages of stencils. resourceIcon shapes (with
  // resIcon=...) and the bare aws4.* shapes both land in aws-service
  // first, then aws-resource for the longer-tail icons. Group icons go
  // through the grIcon branch (handled separately).
  aws: ['aws-service', 'aws-resource'],
  aws3: ['aws-service', 'aws-resource'],
  aws4: ['aws-service', 'aws-resource'],
  aws4b: ['aws-service', 'aws-resource'],
  aws4d: ['aws-service', 'aws-resource'],

  azure: ['azure'],
  azure2: ['azure'],
  // "Microsoft Azure Cloud and Enterprise" - older Microsoft stencil set
  // that still ships on draw.io and predates the azure2 pack.
  mscae: ['azure'],

  gcp: ['google-cloud'],
  gcp2: ['google-cloud'],
  google: ['google-cloud'],

  kubernetes: ['kubernetes'],
  k8s: ['kubernetes'],

  cisco: ['cisco'],
  cisco19: ['cisco'],
  cisco_safe: ['cisco'],

  fortinet: ['fortinet'],
  ibm: ['redhat'], // closest match in our packs for IBM/Red Hat shapes
  juniper: ['juniper'],
  oci: ['oci', 'oci-category'],
  oci2: ['oci', 'oci-category'],
  palo_alto: ['palo-alto'],
  paloalto: ['palo-alto'],
  vmware: ['vmware'],
  cncf: ['cncf'],
  apache: ['apache'],
  cumulus: ['cumulus'],
  f5: ['f5'],
};

/** Pull the canonical icon hint out of a parsed style. Returns null when
 *  the style doesn't carry a recognisable stencil reference - those
 *  shapes stay as their original kind (rect/ellipse/etc.).
 *
 *  Container-style shapes (`swimlane`, `mxgraph.aws4.group`, anything
 *  with `container=1`) are intentionally excluded: those are positioned
 *  rectangles meant to hold children, not standalone icons. Replacing
 *  the rectangle with a 64×64 icon obliterates the container's geometry
 *  and orphans the children visually. The corner-icon visual cue
 *  (lock-on-cream-rect for AWS Security Group, etc.) is lost in import
 *  but the structure remains intact. */
export function extractIconHint(
  style: Record<string, string>,
): IconHint | null {
  if (isContainerStyle(style)) return null;

  // 1) AWS4 resourceIcon wrapper: shape=mxgraph.aws4.resourceIcon plus
  //    resIcon=mxgraph.aws4.<slug>. The wrapper is the tinted rounded
  //    square; the resIcon is the actual service glyph. Match on the
  //    resIcon since that's the identity the user intended.
  const resIcon = style.resIcon;
  if (resIcon) {
    const parsed = parseMxgraphRef(resIcon);
    if (parsed) return parsed;
  }
  // Kubernetes wrapper: shape=mxgraph.kubernetes.icon with icon=mxgraph.kubernetes.<slug>
  const k8sIcon = style.icon;
  if (k8sIcon && /kubernetes/i.test(k8sIcon)) {
    const parsed = parseMxgraphRef(k8sIcon);
    if (parsed) return parsed;
  }
  // 2) Direct shape= reference, e.g. shape=mxgraph.aws4.lambda or
  //    shape=mxgraph.azure2.virtual_machine.
  const shape = style.shape || style[''] || '';
  if (shape) {
    const parsed = parseMxgraphRef(shape);
    if (parsed) return parsed;
  }
  // 3) Image-based shapes: shape=image with image=<url-or-path>. We try
  //    to recover an identity from the path - draw.io's stencil image
  //    paths are usually `img/lib/<vendor>/<...>/<name>.svg`.
  if (shape === 'image' || shape.startsWith('image')) {
    const img = style.image || '';
    const parsed = parseImagePath(img);
    if (parsed) return parsed;
  }
  // Image style sometimes is as a bare `image=...` token without an
  // explicit `shape=image` prefix.
  if (style.image) {
    const parsed = parseImagePath(style.image);
    if (parsed) return parsed;
  }
  return null;
}

/** True when the style describes a positioned container (swimlane,
 *  AWS4 group rectangle, anything with `container=1`). The shape's
 *  identity is "rectangle holding children", not "service icon". */
function isContainerStyle(style: Record<string, string>): boolean {
  if (style.container === '1') return true;
  const primitive = style.shape || style[''] || '';
  if (primitive === 'swimlane') return true;
  if (primitive.startsWith('swimlane')) return true;
  // The mxgraph.<vendor>.group / .groupCenter shapes are colored
  // container rectangles; the grIcon is just a small corner badge.
  if (/\.group(Center)?$/i.test(primitive)) return true;
  return false;
}

/** Parse a `mxgraph.<vendor>.<...>.<name>` reference into a hint. Returns
 *  null if the prefix isn't a vendor we know how to map. */
function parseMxgraphRef(ref: string): IconHint | null {
  // Tolerate stray whitespace or trailing punctuation.
  const cleaned = ref.trim().replace(/;+$/, '');
  if (!cleaned) return null;
  // Strip a leading "shape=" if a caller passed the full key=value pair.
  const refStr = cleaned.replace(/^shape=/, '');
  // Allow both `mxgraph.aws4.foo` and bare `aws4.foo` forms.
  const parts = refStr.split('.');
  let prefixIdx = 0;
  if (parts[0] === 'mxgraph') prefixIdx = 1;
  if (parts.length <= prefixIdx + 1) return null;
  const prefix = parts[prefixIdx].toLowerCase();
  const vendorKeys = VENDOR_PREFIX_MAP[prefix];
  if (!vendorKeys) return null;
  // Everything after the prefix is the icon's name path. Some stencils
  // are namespaced ("compute.virtual_machines"), but we only really need
  // the last segment for matching - keep the others as fallback tokens.
  const nameParts = parts.slice(prefixIdx + 1);
  const last = nameParts[nameParts.length - 1] ?? '';
  if (!last) return null;
  return {
    slug: normalizeSlug(last),
    vendorKeys,
  };
}

/** Parse a draw.io stencil image path like `img/lib/mscae/Compute/VM.svg`
 *  into a hint by detecting the vendor folder + filename. */
function parseImagePath(path: string): IconHint | null {
  if (!path) return null;
  // Reject data: and absolute http URLs we can't infer a vendor from.
  // (Custom user images are out of scope - they'd need a fuzzy match
  // against ALL packs, which is much more expensive and error-prone.)
  if (path.startsWith('data:')) return null;
  // Pull the filename (last path segment, no extension).
  const stripped = path.split(/[?#]/)[0];
  const segments = stripped.split('/').filter(Boolean);
  const file = segments[segments.length - 1] ?? '';
  const name = file.replace(/\.[a-z0-9]+$/i, '');
  if (!name) return null;
  // Try to detect the vendor folder. draw.io's bundled stencils live
  // under `img/lib/<vendor>/...`, but custom URLs may not.
  let vendorKeys: string[] = [];
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    const mapped = VENDOR_PREFIX_MAP[lower];
    if (mapped) {
      vendorKeys = mapped;
      break;
    }
    // Recognise some drawio-specific folder names that don't match the
    // mxgraph.<prefix> namespace we already mapped.
    if (lower === 'aws' || lower.startsWith('aws')) {
      vendorKeys = ['aws-service', 'aws-resource'];
      break;
    }
    if (lower === 'gcp' || lower === 'gcp2') {
      vendorKeys = ['google-cloud'];
      break;
    }
    if (lower === 'azure' || lower === 'azure2') {
      vendorKeys = ['azure'];
      break;
    }
  }
  if (vendorKeys.length === 0) return null;
  return { slug: normalizeSlug(name), vendorKeys };
}

/** Lowercase + collapse separator characters to single dashes. Splits
 *  CamelCase first so draw.io's filename-style stencil names
 *  (`NetworkInterfaceCard`, `Virtual_Machine`) reduce to the same
 *  dash-separated tokens our manifest uses. Without the camel split,
 *  `NetworkInterfaceCard` becomes a single 19-character token and
 *  scores zero against any keyword. */
function normalizeSlug(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[\s_.]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Resolve a hint to a concrete vendor icon. The matcher walks
 *  `hint.vendorKeys` in order and returns the first scored hit. Returns
 *  null when no candidate scores high enough - caller falls back to the
 *  shape's original kind. */
export function matchIconHint(
  hint: IconHint,
  manifest: Manifest,
  packs: Map<string, VendorPack>,
): { icon: VendorIcon; vendor: ManifestVendor } | null {
  for (const vendorKey of hint.vendorKeys) {
    const pack = packs.get(vendorKey);
    const vendor = manifest.vendors[vendorKey];
    if (!pack || !vendor) continue;
    const icon = bestMatchInPack(hint.slug, vendorKey, pack, manifest);
    if (icon) return { icon, vendor };
  }
  return null;
}

/** Score every icon in a pack against the hint slug; return the highest
 *  scorer above a confidence floor. */
function bestMatchInPack(
  slug: string,
  vendorKey: string,
  pack: VendorPack,
  manifest: Manifest,
): VendorIcon | null {
  const tokens = slug.split('-').filter(Boolean);
  if (tokens.length === 0) return null;

  // Shortcut: try a handful of common id rewrites before scoring everything.
  const directCandidates = directIdCandidates(slug, vendorKey);
  for (const candidate of directCandidates) {
    const found = pack.icons.find((i) => i.id === candidate);
    if (found) return found;
  }

  // Otherwise score every icon by token overlap. The manifest entry
  // carries pre-tokenized keywords which is a better signal than the
  // pack's `keywords` field alone (the manifest tokens are deduped).
  // Build a quick lookup.
  const manifestById = new Map<string, ManifestEntry>();
  for (const entry of manifest.icons) {
    if (entry.v === vendorKey) manifestById.set(entry.id, entry);
  }

  let bestScore = 0;
  let best: VendorIcon | null = null;
  for (const icon of pack.icons) {
    const entry = manifestById.get(icon.id);
    const score = scoreIcon(slug, tokens, icon, entry);
    if (score > bestScore) {
      bestScore = score;
      best = icon;
    }
  }
  // Confidence floor - below this we'd rather show no icon than the
  // wrong icon. The threshold is set so that "name starts with slug-"
  // (350) is still accepted but raw substring-only hits (80) are not.
  if (bestScore < 200) return null;
  return best;
}

/** Hand-curated aliases for stencil names that don't lexically match our
 *  manifest. Mostly AWS - draw.io's `amazon_s3` shape is "Amazon Simple
 *  Storage Service" in our pack, which the keyword scorer can't reach
 *  without a prompt. Keyed by `<vendor>/<normalized-slug>` to keep the
 *  lookup O(1). Scoped per-vendor so `s3` couldn't accidentally match an
 *  unrelated icon in another pack. */
const KNOWN_ALIASES: Record<string, string> = {
  // AWS - common stencil slugs that don't match an existing id
  'aws-service/amazon-s3': 'aws-service/amazon-simple-storage-service',
  'aws-service/s3': 'aws-service/amazon-simple-storage-service',
  'aws-service/s3-bucket': 'aws-service/amazon-simple-storage-service',
  'aws-resource/s3': 'aws-resource/amazon-simple-storage-service_bucket',
  'aws-resource/s3-bucket': 'aws-resource/amazon-simple-storage-service_bucket',
  'aws-resource/ec2-instance': 'aws-resource/amazon-ec2_instance',
  'aws-resource/instance': 'aws-resource/amazon-ec2_instance',
  // Some GCP stencils drop the brand from compound names
  'google-cloud/gce': 'google-cloud/compute-engine',
  'google-cloud/gke': 'google-cloud/google-kubernetes-engine',
  'google-cloud/gcs': 'google-cloud/cloud-storage',

  // Azure mscae stencil names → modern Azure icon service ids. The
  // mscae set uses singular CamelCase filenames where our manifest has
  // plural "10NNN-icon-service-X" ids; the keyword scorer can't bridge
  // the singular/plural gap on its own.
  'azure/network-interface-card': 'azure/10080-icon-service-network-interfaces',
  'azure/private-endpoint': 'azure/02579-icon-service-private-endpoints',
  'azure/virtual-network': 'azure/10061-icon-service-virtual-networks',
  'azure/load-balancer': 'azure/10062-icon-service-load-balancers',
  'azure/route-table': 'azure/10082-icon-service-route-tables',
  'azure/public-ip': 'azure/10069-icon-service-public-ip-addresses',
  'azure/public-ip-address': 'azure/10069-icon-service-public-ip-addresses',
};

/** Common id rewrites that trade a full pack scan for an O(1) hit. We
 *  only enumerate a handful - this is "happy path", not exhaustive. */
function directIdCandidates(slug: string, vendorKey: string): string[] {
  const out: string[] = [];
  // Aliases first - they're hand-curated and highest-confidence.
  const aliasKey = `${vendorKey}/${slug}`;
  const aliased = KNOWN_ALIASES[aliasKey];
  if (aliased) out.push(aliased);

  out.push(`${vendorKey}/${slug}`);
  if (vendorKey === 'aws-service' || vendorKey === 'aws-resource') {
    // AWS service icons in our manifest carry "aws-" or "amazon-"
    // prefixes that the draw.io stencil names usually omit.
    if (!slug.startsWith('aws-')) out.push(`${vendorKey}/aws-${slug}`);
    if (!slug.startsWith('amazon-')) out.push(`${vendorKey}/amazon-${slug}`);
  }
  if (vendorKey === 'google-cloud' && !slug.startsWith('google-')) {
    out.push(`${vendorKey}/google-${slug}`);
  }
  return out;
}

/** Numeric score for how well an icon matches the hint. The scorer is
 *  tuned so that "all hint tokens appear in keywords" beats "name happens
 *  to start with the slug" - the latter misfires on long-tail icons
 *  (`amazon-s3` would otherwise win on `amazon-s3-on-outposts` over the
 *  S3 service icon, which has the right keywords but a different name).
 *
 *  Rough scale:
 *    1000 - exact id tail match
 *     900 - id tail equals slug after stripping common brand prefix
 *           (handles `lambda` → `aws-lambda`, `ec2` → `amazon-ec2`)
 *     800 - exact name match
 *     700 - every hint token appears in keywords AND token count ≥ 2
 *     500 - every hint token appears in keywords (single-token slugs)
 *     350 - name starts/ends with the slug as a delimited segment
 *     150 - partial keyword overlap (≥ half of tokens hit)
 *      80 - id tail contains slug as a substring (last-resort)
 *  Below 200 the matcher rejects the candidate so we don't paste an
 *  unrelated icon onto the user's diagram. */
function scoreIcon(
  slug: string,
  tokens: string[],
  icon: VendorIcon,
  entry: ManifestEntry | undefined,
): number {
  const idTail = icon.id.split('/').pop() ?? '';
  if (idTail === slug) return 1000;

  // Brand-stripped id-tail equality. Drawio stencils omit "amazon-",
  // "aws-", "google-" prefixes that our manifest carries; matching on
  // both forms picks up `lambda` → `aws-lambda` cleanly.
  const idStripped = stripBrandPrefix(idTail);
  if (idStripped && idStripped === slug) return 900;

  const nameNorm = normalizeSlug(icon.name);
  if (nameNorm === slug) return 800;

  const keywords = (entry?.k ?? icon.keywords ?? []).map((k) => k.toLowerCase());
  const kwSet = new Set(keywords);
  const allMatch = tokens.every((t) => kwSet.has(t));
  if (allMatch && tokens.length >= 2) return 700;
  if (allMatch && tokens.length === 1) return 500;

  // Delimited-segment match - the slug appears as a complete chunk in
  // the name (not a substring of a longer word). Lower-priority than
  // keyword-all-match so "amazon-s3" doesn't lock onto
  // "amazon-s3-on-outposts" when a better-scoring candidate exists.
  if (nameNorm.startsWith(slug + '-') || nameNorm.endsWith('-' + slug)) {
    return 350;
  }

  // Partial token overlap.
  const hits = tokens.filter((t) => kwSet.has(t)).length;
  if (hits === 0) return 0;
  const ratio = hits / tokens.length;
  if (ratio >= 0.5) return Math.round(50 + 200 * ratio);

  if (idTail.includes(slug)) return 80;

  return 0;
}

/** Strip an `amazon-`, `aws-`, or `google-` prefix from an id-tail so we
 *  can compare against slugs that omit the brand prefix. */
function stripBrandPrefix(tail: string): string {
  return tail.replace(/^(amazon|aws|google)-/, '');
}

// Re-export attribution-shape building so callers don't reach into
// resolve.ts (which is async + does fetch). Keeping the constants in
// sync with resolve.ts is a tradeoff for the import path being
// self-contained.

/** Constraints copied from icons/resolve.ts - vendor icons lock colour
 *  + aspect, leave rotation open. Kept inline so this module doesn't
 *  drag the resolve.ts fetch path into the import code path. */
export const DRAWIO_VENDOR_CONSTRAINTS: IconConstraints = {
  lockColors: true,
  lockAspect: true,
  lockRotation: false,
};

export function attributionFor(
  iconId: string,
  vendor: ManifestVendor,
): IconAttribution {
  return {
    source: 'vendor',
    iconId,
    holder: vendor.trademark.holder,
    license: 'Trademark',
    sourceUrl: vendor.trademark.guidelinesUrl,
    guidelinesUrl: vendor.trademark.guidelinesUrl,
  };
}
