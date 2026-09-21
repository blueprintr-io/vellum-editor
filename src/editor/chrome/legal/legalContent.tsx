// User-facing legal information. Deployment-specific terms require operator approval.

import type { ReactNode } from 'react';

function H1({ children }: { children: ReactNode }) {
  return (
    <h1 className="text-[15px] font-semibold text-fg mb-1 leading-tight">
      {children}
    </h1>
  );
}

function H2({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[10px] font-mono text-fg-muted tracking-[0.04em] uppercase mt-5 mb-2">
      {children}
    </h2>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-fg leading-relaxed">{children}</p>;
}

function Lead({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 text-fg-muted text-[11px] italic leading-relaxed">
      {children}
    </p>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="font-mono text-[11px] bg-bg-emphasis px-1 py-[1px] rounded">
      {children}
    </code>
  );
}

/* IP COMPLAINTS */

export function IpComplaintsContent() {
  return <div>
    <H1>Intellectual property complaints</H1>
    <P>For concerns about material distributed with this Vellum project, contact{' '}
      <a href="mailto:josh@blueprintr.io" className="underline">Josh Morris</a>.
      Identify the material, where it appears, the rights you believe are affected,
      and a way to contact you.</P>
    <P>For material provided through a separately hosted instance, contact its operator.
      This distribution does not designate a statutory agent or set a deployment-specific
      takedown or counter-notice procedure.</P>
  </div>;
}

/* CREDITS */

export function CreditsContent() {
  return (
    <div>
      <H1>Library credits &amp; attributions</H1>

      <Lead>
        Vellum's default install ships with no bundled vendor icon packs.
        Vendor and community icons enter via the <Code>+ Load</Code> import
        flow. Import in your own SVGs, .zip, or .vssx stencils from disk.
        Recorded license information is shown on icon tiles when available.
      </Lead>

      <H2>How attribution works</H2>
      <P>
        When a diagram contains icons whose licenses require attribution
        (e.g., CC BY 4.0), the document attributions panel lists the relevant icon sets, authors, and licenses.
        This includes rack equipment. Image and PDF exports do not automatically
        include the panel; include required notices when sharing an export.
      </P>

      <H2>Trademark</H2>
      <P>
        Product names, logos, and brands depicted in any imported icon
        library are the property of their respective owners. Vellum's own
        use of such names is for identification only and does not imply
        endorsement. Users importing branded packs are responsible for
        complying with each vendor's published brand guidelines.
      </P>

      <H2>Vellum's own license</H2>
      <P>
        Vellum is released under the PolyForm Noncommercial License
        1.0.0. Use, modification and redistribution are subject to its terms.
        This page grants no additional permissions. See <Code>LICENSE</Code> in the repository.
      </P>

      <H2>Open-source libraries</H2>
      <P>
        Vellum is built on React, Zustand, Radix UI primitives, Tailwind
        CSS, the <Code>yaml</Code> parser, <Code>zod</Code>, and DOMPurify,
        each under its own license. Package metadata identifies dependencies;
        their LICENSE, NOTICE and font OFL files contain the applicable terms.
      </P>
    </div>
  );
}

/* TERMS */

export function TermsContent() {
  return <div>
    <H1>Terms of use</H1>
    <P>Vellum is source-available under the PolyForm Noncommercial License 1.0.0.
      That license governs the software. This page grants no additional permissions
      and makes no service-availability commitments.</P>
    <P>A hosted instance may have separate terms from its operator. No deployment-specific
      terms are supplied in this distribution. Contact the operator for the terms
      that apply to its service.</P>
    <P>Imported artwork and other third-party content retain their own licenses.
      Check those terms before using or redistributing that content.</P>
  </div>;
}
