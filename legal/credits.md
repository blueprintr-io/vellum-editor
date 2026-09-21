# Library credits and attributions

The source distribution and desktop build contain no bundled vendor icon packs.
Search uses the locally available icon manifest. The Iconify search client is
dormant in the current UI. Users can import SVG, ZIP and VSSX libraries through
**+ Load**. Local builds may include additional packs when explicitly configured;
inspect their assets and licenses before distribution.

## Document attribution

The document attributions panel lists recorded holders, source links and licenses
for artwork in the document, including rack equipment. It also retains notices
for hidden equipment. It cannot infer missing provenance from an imported file.
The panel is not automatically included as an image or PDF footer. Include any
required notices when sharing an export and check the artwork's own terms.

## Imported libraries and trademarks

Imported libraries are stored locally. Users must check their rights to use and
redistribute imported content. Product names, logos and brands belong to their
respective owners. Their appearance does not imply endorsement.

## Software dependencies

Vellum uses React, Zustand, Radix UI, Tailwind CSS, YAML, Zod, DOMPurify and other
packages, plus fonts and native desktop dependencies. Each retains its own license.
`package.json` and the lockfiles identify dependencies and versions; they do not
contain the full license texts. Installed package LICENSE, COPYING, NOTICE and font
OFL files are the source for distribution notices. The public build writes `dist/THIRD-PARTY-NOTICES.txt` and
`dist/DEPENDENCY-LICENSES.json` from the installed dependency inventory. Desktop
builds include native dependencies too. Review these generated files before
distribution; they apply to that build, not an arbitrary installation.

Vellum's own terms are in [LICENSE](../LICENSE). This credits page does not extend
those terms or the permissions for third-party assets.
