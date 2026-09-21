# Supplemental dependency notices

The build copies license and notice files from the exact installed dependencies. This directory supplies notices omitted from package roots. `sources.json` records each package version, notice file and source URL. Where a package ships a license declaration or source comment but omits the full standard terms, the declaration and the license publisher's versioned text are separate records. Copyright holders and dates are not inferred from package author fields.

Some records use additional evidence:

- `r-efi` includes its MIT terms and copyright notice in `AUTHORS`.
- `libappindicator-sys` and `libappindicator` 0.9.0 record the same Git commit; the latter includes that repository's root license files.
- `tao-macros` 0.1.3 matches its pinned release tag's package manifest, source and examples by Git blob hash.
- `selectors` 0.36.1 includes an MPL 2.0 source comment. Its exact recorded source commit omits a root license file, so the inventory also includes Mozilla's official MPL 2.0 text. The unmodified crate source is available in the [selectors 0.36.1 source archive](https://static.crates.io/crates/selectors/selectors-0.36.1.crate).

## Unresolved publication blocker

`react-remove-scroll-bar` 2.3.8 declares `MIT` in its installed package metadata but includes no license file or original copyright notice. The npm record for that exact version identifies Git commit `b3b1287aad81def2e2ae707274b74531b61ddbaf` in `theKashey/react-remove-scroll-bar`. On 2026-09-21, the raw `LICENSE` URL at that commit returned HTTP 404 and GitHub's Git tree API returned HTTP 422. These responses do not establish the contents of the missing notice.

Before publication or distribution, obtain the publisher's copyright and MIT license notice for version 2.3.8, or replace this dependency with a version or implementation whose applicable notice can be verified. Do not substitute a copyright holder or year based on the author field, and do not attribute a current branch's notice to this release without evidence.

Evidence: [npm version metadata](https://registry.npmjs.org/react-remove-scroll-bar/2.3.8), [recorded commit license path](https://raw.githubusercontent.com/theKashey/react-remove-scroll-bar/b3b1287aad81def2e2ae707274b74531b61ddbaf/LICENSE), [recorded commit tree](https://api.github.com/repos/theKashey/react-remove-scroll-bar/git/trees/b3b1287aad81def2e2ae707274b74531b61ddbaf).
