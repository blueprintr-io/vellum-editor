// TRADEMARK-COMPLIANCE: this file is the single source of truth for the
// branded-icon detector. Edit BRANDED_NAMESPACES / BRANDED_KEYWORDS to
// extend the list - every UI surface that decides whether to show the
// "SVG: <license> · Brand: <vendor>®" two-line badge reads from here.

/* What this is for ----------------------------------------------------------
 *
 * Vellum surfaces icons from two domains the law treats very differently:
 *
 *   1. Generic icons (a database, a server, a user, a cloud, a lock).
 *      Their copyright license (CC0-1.0, MIT, CC-BY-4.0, etc.) is the only
 *      rights regime in play - the SVG license fully describes what a user
 *      can do with the asset.
 *
 *   2. Vendor / brand icons (an AWS service icon, a Kubernetes wheel, a
 *      Cisco router silhouette). The SVG copyright license is one regime;
 *      the trademark in the depicted brand is a *separate* regime that no
 *      open-source copyright license touches. Showing only "CC0-1.0" next
 *      to a vendor mark is misleading - it implies the asset is free to use
 *      as branding when it isn't.
 *
 * Detection is deliberately namespace-based ("starts-with") rather than a
 * curated allowlist of icons:
 *   - new icons in the same namespace get the right treatment by default
 *   - we don't have to play whack-a-mole with vendor renames
 *   - the rule is auditable in one file
 *
 * Detection is intentionally over-inclusive: when we're unsure, we show the
 * two-line badge. Mis-flagging a generic icon as branded only adds an extra
 * "Brand: …" line; mis-flagging a vendor icon as generic risks misleading
 * the user into a trademark mistake.
 */

/** Namespace prefixes that mark an icon as vendor/brand-bearing.
 *
 *  Each entry maps a prefix the icon id / name / tag might carry to the
 *  human-readable holder used in the "Brand: <holder>®" badge. Match is
 *  case-insensitive and applied with `startsWith` against the icon's id /
 *  name / tag set; if any field matches, the icon is considered branded.
 *
 *  Add new vendors here as the catalog grows. Order doesn't matter - the
 *  first matching prefix wins on the holder-name lookup. */
export const BRANDED_NAMESPACES: Array<{ prefix: string; holder: string }> = [
  // Hyperscalers
  { prefix: 'aws-', holder: 'AWS' },
  { prefix: 'aws/', holder: 'AWS' },
  { prefix: 'amazon-', holder: 'AWS' },
  { prefix: 'azure-', holder: 'Microsoft Azure' },
  { prefix: 'azure/', holder: 'Microsoft Azure' },
  { prefix: 'ms-', holder: 'Microsoft' },
  { prefix: 'microsoft-', holder: 'Microsoft' },
  { prefix: 'gcp-', holder: 'Google Cloud' },
  { prefix: 'gcp/', holder: 'Google Cloud' },
  { prefix: 'google-cloud-', holder: 'Google Cloud' },
  { prefix: 'google-', holder: 'Google' },

  // Cloud-native ecosystem
  { prefix: 'kubernetes', holder: 'Kubernetes' },
  { prefix: 'k8s-', holder: 'Kubernetes' },
  { prefix: 'docker', holder: 'Docker' },
  { prefix: 'helm', holder: 'Helm' },
  { prefix: 'istio', holder: 'Istio' },
  { prefix: 'envoy', holder: 'Envoy' },
  { prefix: 'prometheus', holder: 'Prometheus' },
  { prefix: 'grafana', holder: 'Grafana' },
  { prefix: 'terraform', holder: 'HashiCorp Terraform' },
  { prefix: 'vault', holder: 'HashiCorp Vault' },
  { prefix: 'consul', holder: 'HashiCorp Consul' },
  { prefix: 'hashicorp-', holder: 'HashiCorp' },

  // Networking / security vendors
  { prefix: 'cisco-', holder: 'Cisco' },
  { prefix: 'juniper-', holder: 'Juniper Networks' },
  { prefix: 'fortinet-', holder: 'Fortinet' },
  { prefix: 'forti', holder: 'Fortinet' },
  { prefix: 'paloalto-', holder: 'Palo Alto Networks' },
  { prefix: 'pan-', holder: 'Palo Alto Networks' },
  { prefix: 'checkpoint-', holder: 'Check Point' },
  { prefix: 'f5-', holder: 'F5' },
  { prefix: 'crowdstrike-', holder: 'CrowdStrike' },
  { prefix: 'okta-', holder: 'Okta' },

  // Data / databases (the marks, not the generic 'database' icon)
  { prefix: 'oracle-', holder: 'Oracle' },
  { prefix: 'mongodb', holder: 'MongoDB' },
  { prefix: 'redis', holder: 'Redis' },
  { prefix: 'postgresql', holder: 'PostgreSQL' },
  { prefix: 'mysql', holder: 'MySQL' },
  { prefix: 'snowflake', holder: 'Snowflake' },
  { prefix: 'databricks', holder: 'Databricks' },
  { prefix: 'elastic', holder: 'Elastic' },

  // Virtualization / infra
  { prefix: 'vmware-', holder: 'VMware' },
  { prefix: 'redhat-', holder: 'Red Hat' },
  { prefix: 'rhel-', holder: 'Red Hat' },
  { prefix: 'ubuntu-', holder: 'Canonical Ubuntu' },
  { prefix: 'nvidia-', holder: 'NVIDIA' },
  { prefix: 'intel-', holder: 'Intel' },
  { prefix: 'amd-', holder: 'AMD' },

  // Devtools / SaaS marks (commonly diagrammed)
  { prefix: 'github', holder: 'GitHub' },
  { prefix: 'gitlab', holder: 'GitLab' },
  { prefix: 'bitbucket', holder: 'Atlassian Bitbucket' },
  { prefix: 'atlassian-', holder: 'Atlassian' },
  { prefix: 'jira', holder: 'Atlassian Jira' },
  { prefix: 'slack', holder: 'Slack' },
  { prefix: 'datadog', holder: 'Datadog' },
  { prefix: 'pagerduty', holder: 'PagerDuty' },
  { prefix: 'auth0', holder: 'Auth0' },
  { prefix: 'stripe', holder: 'Stripe' },
  { prefix: 'twilio', holder: 'Twilio' },
  { prefix: 'cloudflare', holder: 'Cloudflare' },
  { prefix: 'netlify', holder: 'Netlify' },
  { prefix: 'vercel', holder: 'Vercel' },
  { prefix: 'heroku', holder: 'Heroku' },
];

/** Iconify collection prefixes that ARE vendor/brand collections wholesale.
 *  These flip the "branded" verdict for every icon in the collection
 *  regardless of icon-name. */
export const BRANDED_ICONIFY_PREFIXES = new Set<string>([
  'logos', // Iconify's wholesale-brand-logos pack
  'simple-icons', // Brand-mark collection
  'skill-icons', // Mostly branded tech logos
  'devicon', // Tool / vendor logos
  'devicon-plain',
  'cib', // CoreUI brand icons
  'fontisto-brand',
]);

/** Free-form keywords (not prefixes) that, when present in an icon's tags
 *  or name, signal it depicts a vendor/brand. Used as a secondary check
 *  after BRANDED_NAMESPACES so we don't miss icons whose ids are opaque
 *  ("brand-mark-aws"). Keep this short - it's a fallback. */
export const BRANDED_KEYWORDS = new Set<string>([
  'aws',
  'azure',
  'gcp',
  'kubernetes',
  'docker',
  'cisco',
  'juniper',
  'fortinet',
  'vmware',
  'redhat',
  'oracle',
  'salesforce',
  'snowflake',
]);

export type BrandedVerdict = {
  /** Whether the icon is considered to depict a vendor / brand. */
  branded: boolean;
  /** Display name for the "Brand: <holder>®" line. Undefined when branded=false. */
  holder?: string;
};

/** Decides whether an icon is branded based on (id, name, tags) and an
 *  optional iconify collection prefix.
 *
 *  The check is layered:
 *    1. iconify collection prefix is one of the wholesale-brand collections
 *    2. id / name / any tag startsWith one of BRANDED_NAMESPACES (case-insensitive)
 *    3. id / name / any tag contains one of BRANDED_KEYWORDS as a token
 *
 *  Returns a BrandedVerdict so callers can use the same call to render the
 *  badge. */
export function detectBranded(input: {
  id?: string;
  name?: string;
  tags?: string[];
  iconifyPrefix?: string;
}): BrandedVerdict {
  const { id = '', name = '', tags = [], iconifyPrefix } = input;

  // 1. Wholesale-brand iconify collections.
  if (iconifyPrefix && BRANDED_ICONIFY_PREFIXES.has(iconifyPrefix)) {
    return { branded: true, holder: guessHolder(id, name, tags) };
  }

  // 2. Namespace-prefix match.
  const haystacks = [id, name, ...tags].map((s) => s.toLowerCase()).filter(Boolean);
  for (const { prefix, holder } of BRANDED_NAMESPACES) {
    const p = prefix.toLowerCase();
    if (haystacks.some((h) => h.startsWith(p) || h.includes(`/${p}`))) {
      return { branded: true, holder };
    }
  }

  // 3. Keyword fallback - tokenize each haystack and check whole-word hits.
  for (const h of haystacks) {
    for (const tok of h.split(/[\s_/\-:.]+/)) {
      if (BRANDED_KEYWORDS.has(tok)) {
        return { branded: true, holder: guessHolder(id, name, tags) };
      }
    }
  }

  return { branded: false };
}

/** Best-effort holder name for fallback paths. Walks BRANDED_NAMESPACES
 *  again on the haystacks; returns the first prefix-derived holder if any
 *  match, otherwise an empty string (caller can fall back to "Vendor"). */
function guessHolder(id: string, name: string, tags: string[]): string {
  const haystacks = [id, name, ...tags].map((s) => s.toLowerCase());
  for (const { prefix, holder } of BRANDED_NAMESPACES) {
    const p = prefix.toLowerCase();
    if (haystacks.some((h) => h.startsWith(p) || h.includes(p))) {
      return holder;
    }
  }
  return 'Vendor';
}

/** List of icon ids that should NEVER ship in the bundled default catalog
 *  even if they survive a build pass. These are standalone brand
 *  wordmarks / logo lockups (the "smile arrow", the corporate type
 *  treatment) - always higher legal risk than service-specific icons.
 *  Service icons (e.g. aws/ec2, aws/s3) are nominative-use friendly and
 *  stay; wordmarks come out and live behind the user-import (Tier 2) flow.
 *
 *  The icon manifest loader filters this set out at runtime as a safety
 *  net even if a future build script drops them back in. */
export const BUNDLED_BRAND_DENYLIST = new Set<string>([
  // AWS
  'aws/brand-aws',
  'aws/aws-dark',
  'aws/aws-light',
  'aws/wordmark',
  'aws/logo',

  // Microsoft Azure
  'azure/azure-logo',
  'azure/microsoft-logo',
  'azure/wordmark',

  // GCP / Google
  'gcp/google-cloud-logo',
  'gcp/google-logo',
  'gcp/wordmark',

  // Catch-all patterns the manifest loader also matches against.
  // Anything ending with these slugs is rejected.
]);

/** Suffix patterns the manifest loader rejects in addition to the explicit
 *  set above. Anything whose slug part (after the vendor/) ends with one
 *  of these is treated as a standalone brand wordmark and dropped. */
export const BUNDLED_BRAND_DENY_SUFFIXES: string[] = [
  '-wordmark',
  '-logo-mark',
  '-corporate',
  'brand-',
];

/** Returns true if an icon id should be filtered out of the bundled catalog. */
export function isDeniedBundledBrand(id: string): boolean {
  if (BUNDLED_BRAND_DENYLIST.has(id)) return true;
  const slug = id.split('/').slice(-1)[0]?.toLowerCase() ?? '';
  for (const suf of BUNDLED_BRAND_DENY_SUFFIXES) {
    if (suf.startsWith('-')) {
      if (slug.endsWith(suf)) return true;
    } else if (slug.startsWith(suf)) {
      return true;
    }
  }
  return false;
}
