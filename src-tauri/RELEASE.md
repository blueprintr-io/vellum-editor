# Vellum Core release flow

Vellum Core 1.6.0 and later checks the signed updater channel at
`https://downloads.blueprintr.io/core/updater.json` on launch and once a day.
Human installers come from the same channel's versioned download metadata.

## Automatic releases

A change to a Core build input on `main` runs `auto-release.yml`. It verifies
all version surfaces with `npm run check:version`, keeps an intentional newer
version or deterministically increments the patch version, then tags that exact
`main` commit without creating a release-only source commit. `release.yml`
injects the tag version into each disposable checkout, then builds all
platforms, signs updater payloads, and publishes the immutable versioned
objects before updating `latest/` and `updater.json` last.

Before any S3 write, CI verifies all three staged updater signatures and a
currently live updater payload with the configured public key. This prevents a
mismatched or silently rotated key from stranding installed clients. The
manifest records the full source SHA plus SHA-256/URL metadata for every
versioned artifact and for the three human installers. Mutable channel objects
are `no-store` and their canonical public responses are checked after publish.

The release preflight requires the tag, full source commit, and current `main`
to agree, requires all source version files to be internally synchronized, and
refuses a tag at or below either prior tags or the live channel. A versioned S3
prefix is append-only: never move or re-cut an existing tag/version; fix the
source and cut the next version.

For a deliberate version, run `node scripts/version-sync.mjs --set X.Y.Z`,
commit the result to `main`, and let the automatic workflow publish it. Use the
manual release workflow only to retry an unpublished plain-semver tag that
still points at current `main`.

## Release gates

Release preflight runs typecheck, unit tests, the Chromium browser suite, a
production build, generated-artifact checks, npm audit, and cargo-audit.
Unsound Rust dependencies fail the advisory gate. The unit suite exercises
native file pickers, cancellation, failed writes, and capability permissions
through the injected desktop script.

In a surrounding npm workspace, audit this repository's lockfile explicitly:
`npm --prefix /path/to/vellum audit --workspaces=false`. An unscoped npm command
can otherwise report the enclosing workspace's different dependency graph.

Each platform builds installers into a draft GitHub release. Linux launches
the binary under tauri-driver; Windows launches it with Edge WebDriver attached.
These checks verify editor startup, file-picker installation, download routing,
and the app version. Screenshots are saved in smoke artifacts. macOS has no
WebDriver backend in this workflow; its script-level checks do not replace a
manual native save/export check before release.

The promotion job depends on preflight and every matrix build. It verifies
signatures and staged files, uploads the versioned download mirror, updates the
mutable aliases and updater manifest, and verifies public bytes. It publishes
the GitHub draft after those checks. Failed build or smoke jobs leave the draft
private. A failed mirror promotion can leave some mirror objects written; it
must be diagnosed before retrying. The append-only version checks protect
already uploaded files from being replaced with different bytes.

`VELLUM_CORE_DISABLE_UPDATER=1` is exported for native smoke runs to avoid a
blocking native update prompt.

## Distribution contents

Use `npm run build:public` for a public web bundle and
`npm run build:desktop-web` for the native frontend. Both build from tracked
public assets and leave optional local icon packs untouched. The normal
`npm run build` command retains the optional icon-pack workflow for installations
that have reviewed those assets separately.

`npm run check:artifacts` reviews the generated dist directory and an actual
npm package archive independently of the Git file list. It rejects private
workspace filenames, vendor icon packs, unexpected distribution files, and the
browser test interface in production output. Inspect any new artifact type
before extending its allowlist. These checks supplement review; they do not
prove a file's legal provenance or detect every possible secret.

Public builds generate `THIRD-PARTY-NOTICES.txt` and `DEPENDENCY-LICENSES.json`
from locked runtime npm dependencies, including fonts. Desktop builds include
Rust dependencies from Cargo metadata as well. The text file copies packaged
license and notice text; the JSON inventory records versions, declared licenses,
and sources. Missing upstream license text is recorded explicitly for review.

For a new repository without history, run
`node scripts/prepare-source-snapshot.mjs /path/outside/repo/vellum-source.tar.gz`
after the final checks and review. This copies the current nonignored source
files, including reviewed new files, without Git objects or local remotes.
It creates a per-file SHA-256 manifest and verifies the archive's file list.
Extract into an empty directory, review `SOURCE-MANIFEST.json`, and initialize
the new repository there when ready. The script does not initialize Git,
create a remote repository, change the current remote, or publish anything.

## Dependency backport

The Tauri Linux GTK3 dependency graph currently resolves glib 0.18.5. Its
`VariantStrIter` implementations are covered by
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html).
The patched glib 0.20 series is incompatible with GTK3's 0.18 dependency.
The application pins the original 0.18.5 source with the upstream two-line
iterator fix. Its source hashes and optimized Linux regression tests run before
the advisory scan, which continues to reject unsound registry dependencies.
See [the backport record](vendor/README.md). Maintenance notices for six legacy
transitive crates remain visible in cargo-audit output.

## Notice publication gate

Release preflight runs
`node scripts/check-license-notices.mjs dist/DEPENDENCY-LICENSES.json` after the
public build. It blocks publication if any dependency lacks verified notice
text. As of 2026-09-21 this gate fails for `react-remove-scroll-bar@2.3.8`: its
npm archive omits the license text and its recorded source commit cannot be
retrieved. Obtain a verifiable notice for that version or update to a dependency
version with traceable notices before publishing. Ordinary builds and tests
remain available while this review is pending.
