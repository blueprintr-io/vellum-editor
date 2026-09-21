# Security policy

## Reporting a vulnerability

Please do not open a public GitHub issue. Email
[josh@blueprintr.io](mailto:josh@blueprintr.io) instead with
the subject line `[vellum-editor security]`.

Please include:

- A description of the issue and its location in the code.
- Steps to reproduce, ideally with a minimal `.vellum` file or a code
  snippet showing the problematic input.
- Your assessment of impact (what an attacker can do).
- Whether you've shared this with anyone else.

You should expect an acknowledgement within 72 hours and a status
update within 7 days. Coordinated disclosure timing is negotiable;
the default is 90 days from the acknowledgement.

## Scope

Vellum is a client-side React component intended to be embedded in
host applications. The threat model assumes that:

- Diagram files (`.vellum`) may be authored by attackers and opened by
  victims (so file parsing and SVG rendering are trust boundaries).
- Imported icon libraries may contain malicious SVG (so the icon
  ingestion path is a trust boundary).
- Icon search reads the local manifest. The dormant Iconify client is not
  used by the current search UI. Imported artwork still crosses a trust boundary.
- PNG and SVG files can contain editable source. Plain exports omit it by
  default; the explicit editable option discloses its document scope.
- Browser recovery uses IndexedDB. Storage failures must leave editing usable
  and show a recovery notice; file saves must acknowledge only written revisions.

In-scope findings include: XSS via `.vellum` files or imported icons,
SVG sanitizer bypasses, prototype pollution via the file format,
zip-slip in the library importer, and any default that pollutes a host
app's global state (window, document listeners, storage keys).

Deployment-specific server configuration and hosting issues should go to the
operator. Oversized local imports and reachable dependency vulnerabilities are
in scope. Include the affected browser or desktop target when reporting them.

## Supported versions

Security fixes are applied to the current development branch. This project
does not promise backports to earlier releases. Check `package.json` for the
current version and update to a release containing the applicable fix.
