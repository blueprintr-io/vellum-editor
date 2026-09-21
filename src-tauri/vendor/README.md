# glib compatibility backport

The `glib/` directory contains the published glib 0.18.5 crate, with the two-line
upstream fix for `VariantStrIter::impl_get`. Its output pointer is now mutable
and passed as `&mut p` to `g_variant_get_child`. This retains the API version
required by Tauri's GTK3 dependencies.

Source: [glib 0.18.5 on crates.io](https://crates.io/crates/glib/0.18.5).
The original crate archive SHA-256 is
`233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`.
Its recorded source commit is `42b9caf98e03ded086362d9653ca58fe94dc8658`.
The backported change is upstream commit
[`b5a4071e439bef2b5eea76c3aa25e5ae84839e34`](https://github.com/gtk-rs/gtk-rs-core/commit/b5a4071e439bef2b5eea76c3aa25e5ae84839e34),
documented in [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html).
Cargo's extraction marker and original checksum file are omitted; all other
packaged files, including the upstream MIT license, are preserved. Third-party
source and license wording are excluded from Vellum's prose style changes.

`glib.sha256.json` records every backported source file. Run
`node scripts/check-glib-backport.mjs` before `cargo audit`. The check verifies
the file set and hashes, the Cargo override, and the absence of an unpatched
registry glib in the application lockfile. Cargo audit does not inspect this
local path dependency; there is no advisory ignore rule.

Run `cargo test --release --locked --manifest-path src-tauri/security-tests/Cargo.toml`
on Linux with `libglib2.0-dev` and `pkg-config` installed. These tests exercise
forward/reverse iteration, skipped ranges and `last()` with optimization enabled,
which is where the original invalid reference caused failures. Both CI and
release preflight run this check. Replace this backport when the desktop toolkit
supports a compatible upstream release containing the fix.
