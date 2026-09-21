// TRADEMARK-COMPLIANCE: badge now renders a two-line label for branded
// icons ("SVG: <license> · Brand: <holder>®") plus an ⓘ tooltip explaining
// that the SVG copyright license does NOT cover the depicted trademark.
// Generic (non-branded) icons keep the original single-license chip.

/* Tiny chip rendered on icon result cards.
 *
 * Three variants:
 *   - tone="iconify" + branded=false   → SPDX-only pill (CC0-1.0, MIT, …).
 *                                        Click opens the license URL.
 *   - tone="iconify" + branded=true    → two-line:
 *                                          SVG: <license>
 *                                          Brand: <holder>® ⓘ
 *                                        ⓘ tooltip explains the
 *                                        copyright-vs-trademark distinction.
 *   - tone="vendor"                    → bundled vendor icon with a known
 *                                        trademark holder. Always treated as
 *                                        branded - same two-line layout.
 *   - tone="user"                      → user-imported library. No license
 *                                        chip; renders "User-supplied" so the
 *                                        responsibility falls to the user.
 *
 * Why visible by default (not just on hover): some Iconify collections use
 * licenses (CC-BY-NC, CC-BY-SA, OFL) that materially affect commercial use.
 * Forcing a hover before a license is visible invites users to drag without
 * checking. The chip is small enough that always-on doesn't dominate the card.
 *
 * Implementation note: this component is presentational only - the parent
 * card stops the drag-start from propagating when the user clicks the badge,
 * so clicks open the license URL without triggering a phantom drag. */

import { useEffect, useRef, useState } from 'react';

type VendorTone = {
  tone: 'vendor';
  /** "AWS", "Google Cloud" - short label rendered after the ®. */
  short: string;
  guidelinesUrl: string;
  /** SPDX of the SVG itself (vendor packs declare an SVG license too - most
   *  AWS/GCP service icon decks ship CC0/CC-BY-4.0 for the drawing). */
  svgLicense?: string;
  svgLicenseUrl?: string;
};

type IconifyTone = {
  tone: 'iconify';
  spdx: string;
  url: string;
  /** Set true for icons depicting a vendor brand (AWS service mark,
   *  Kubernetes wheel, etc.). Renders the two-line SVG/Brand badge. */
  branded?: boolean;
  /** Display holder name for "Brand: <holder>®" - required when branded. */
  brandHolder?: string;
};

type UserTone = {
  tone: 'user';
};

type Props = (VendorTone | IconifyTone | UserTone) & {
  /** Optional larger / smaller variant. Default sm. */
  size?: 'sm' | 'xs';
};

/** Tooltip text for the ⓘ icon next to the brand line. Authored exactly
 *  per the compliance spec - do not paraphrase without legal review. */
const BRAND_TOOLTIP =
  "The SVG drawing is licensed for reuse, but the underlying brand/trademark belongs to its owner. Use these icons only to accurately reference the vendor's products in diagrams. Don't use them to imply endorsement or as your own branding.";

export function IconLicenseBadge(props: Props) {
  const { size = 'sm' } = props;

  const px = size === 'xs' ? 'px-[3px] py-0' : 'px-[5px] py-[1px]';
  const text = size === 'xs' ? 'text-[8px]' : 'text-[9px]';

  if (props.tone === 'user') {
    return (
      <span
        className={`inline-flex items-center ${px} ${text} rounded-[3px] bg-bg-emphasis text-fg-muted font-mono leading-none`}
        title="User-imported library - you are responsible for ensuring you have rights to use these assets."
      >
        User-supplied
      </span>
    );
  }

  if (props.tone === 'vendor') {
    // Vendor packs are inherently branded - render the two-line badge with
    // the SVG license on top and the trademark holder below.
    return (
      <TwoLineBadge
        size={size}
        svgLicense={props.svgLicense ?? 'CC0-1.0'}
        svgLicenseUrl={
          props.svgLicenseUrl ??
          `https://spdx.org/licenses/${props.svgLicense ?? 'CC0-1.0'}.html`
        }
        brandHolder={props.short}
        brandUrl={props.guidelinesUrl}
      />
    );
  }

  // Iconify branch.
  if (props.branded && props.brandHolder) {
    return (
      <TwoLineBadge
        size={size}
        svgLicense={props.spdx}
        svgLicenseUrl={props.url || `https://spdx.org/licenses/${props.spdx}.html`}
        brandHolder={props.brandHolder}
      />
    );
  }

  // Generic, non-branded iconify - single SPDX chip with a license-summary
  // hover tooltip (unchanged from the pre-compliance behaviour).
  return <SingleLicenseChip spdx={props.spdx} url={props.url} px={px} text={text} />;
}

/* Two-line branded badge */

function TwoLineBadge({
  size,
  svgLicense,
  svgLicenseUrl,
  brandHolder,
  brandUrl,
}: {
  size: 'sm' | 'xs';
  svgLicense: string;
  svgLicenseUrl: string;
  brandHolder: string;
  brandUrl?: string;
}) {
  const text = size === 'xs' ? 'text-[8px]' : 'text-[9px]';
  const px = size === 'xs' ? 'px-[3px] py-0' : 'px-[4px] py-[1px]';

  return (
    <span
      className={`inline-flex flex-col items-center gap-[1px] ${px} ${text} rounded-[3px] bg-bg-emphasis text-fg-muted font-mono leading-none`}
    >
      <span className="flex items-center gap-[2px]">
        <span className="text-fg-muted">SVG:</span>
        <a
          href={svgLicenseUrl}
          target="_blank"
          rel="noreferrer noopener"
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          className="text-fg-muted hover:text-fg no-underline"
          title={`Open ${svgLicense} license`}
        >
          {svgLicense}
        </a>
      </span>
      <span className="flex items-center gap-[2px]">
        <span className="text-fg-muted">Brand:</span>
        {brandUrl ? (
          <a
            href={brandUrl}
            target="_blank"
            rel="noreferrer noopener"
            onMouseDown={(e) => e.stopPropagation()}
            onDragStart={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            className="text-fg-muted hover:text-fg no-underline"
            title={`${brandHolder} - usage guidelines`}
          >
            {brandHolder}®
          </a>
        ) : (
          <span>{brandHolder}®</span>
        )}
        <BrandInfoTooltip />
      </span>
    </span>
  );
}

/** ⓘ pop-up rendered next to the Brand line.
 *
 *  Implemented locally (not via Radix Tooltip) to keep the tile lightweight -
 * the rest of the card already uses click-stopping handlers, so the same
 *  pattern works here. Hover OR focus opens it; Escape and outside-click
 *  close it. */
function BrandInfoTooltip() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDoc);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [open]);

  return (
    <span ref={ref} className="relative inline-flex items-center">
      <button
        type="button"
        aria-label="Why this matters"
        title={BRAND_TOOLTIP}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onDragStart={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        className="bg-transparent border-none p-0 m-0 text-fg-muted hover:text-fg cursor-help inline-flex items-center"
      >
        <InfoCircleGlyph />
      </button>
      {open && (
        <span
          role="tooltip"
          className="float absolute z-[40] left-1/2 -translate-x-1/2 top-full mt-1 w-[220px] px-2 py-[6px] text-[10px] leading-snug text-fg whitespace-normal pointer-events-none normal-case"
          style={{ fontFamily: 'var(--font-body)', textAlign: 'left' }}
        >
          {BRAND_TOOLTIP}
        </span>
      )}
    </span>
  );
}

function InfoCircleGlyph() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M8 7v4"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <circle cx="8" cy="4.75" r="0.75" fill="currentColor" />
    </svg>
  );
}

/* Single-license chip (non-branded iconify) */

function SingleLicenseChip({
  spdx,
  url,
  px,
  text,
}: {
  spdx: string;
  url: string;
  px: string;
  text: string;
}) {
  const [tipOpen, setTipOpen] = useState(false);
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!tipOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTipOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tipOpen]);

  return (
    <span className="relative inline-block">
      <a
        href={url || `https://spdx.org/licenses/${spdx}.html`}
        target="_blank"
        rel="noreferrer noopener"
        onMouseDown={(e) => e.stopPropagation()}
        onMouseEnter={() => setTipOpen(true)}
        onMouseLeave={() => setTipOpen(false)}
        onDragStart={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        className={`inline-flex items-center ${px} ${text} rounded-[3px] bg-bg-emphasis text-fg-muted hover:text-fg font-mono leading-none no-underline`}
        title={`Open ${spdx} license`}
      >
        {spdx}
      </a>
      {tipOpen && (
        <div
          ref={tipRef}
          className="float absolute z-[20] left-1/2 -translate-x-1/2 top-full mt-1 px-2 py-1 text-[10px] text-fg whitespace-nowrap pointer-events-none"
        >
          {licenseSummary(spdx)}
        </div>
      )}
    </span>
  );
}

/** One-line summary surfaced in the tooltip. Not legal advice - just a hint
 *  so users don't have to click through for the common cases. */
function licenseSummary(spdx: string): string {
  switch (spdx) {
    case 'MIT':
    case 'Apache-2.0':
    case 'BSD-3-Clause':
    case 'BSD-2-Clause':
    case 'ISC':
    case 'Unlicense':
    case 'CC0-1.0':
      return `${spdx} - review license conditions`;
    case 'CC-BY-4.0':
    case 'CC-BY-3.0':
      return `${spdx} - attribution required`;
    case 'CC-BY-SA-4.0':
    case 'CC-BY-SA-3.0':
      return `${spdx} - attribution + share-alike`;
    case 'CC-BY-NC-4.0':
    case 'CC-BY-NC-3.0':
      return `${spdx} - non-commercial only`;
    case 'OFL-1.1':
      return `${spdx} - font license; review use and distribution terms`;
    case 'GPL-3.0':
    case 'GPL-2.0':
      return `${spdx} - copyleft; review distribution obligations`;
    default:
      return `${spdx} - click to view license`;
  }
}
