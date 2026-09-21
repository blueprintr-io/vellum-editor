#!/usr/bin/env node
// Copy license and notice text only. Dependency source and private workspace
// files are not inputs to this generated distribution inventory.
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const noticeName = /^(?:licen[cs]e|copying|notice|ofl)(?:[.-].*)?$/i;

async function supplementalNotice(notice) {
  if (notice.file !== notice.file.split(/[\\/]/).at(-1) || notice.file.includes('..')) {
    throw new Error(`Supplemental notice requires a plain filename: ${notice.file}`);
  }
  return { file: notice.file, source: notice.url,
    text: await readFile(join(root, 'legal/dependency-notices', notice.file), 'utf8') };
}

async function licenseTexts(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && noticeName.test(entry.name)) {
      result.push({ file: entry.name, text: await readFile(join(directory, entry.name), 'utf8') });
    }
  }
  return result;
}

export async function generateNotices(destination, { desktop = false } = {}) {
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const supplemental = JSON.parse(await readFile(join(root, 'legal/dependency-notices/sources.json'), 'utf8'));
  const dependencies = [];
  for (const [path, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
    if (!path || entry.dev || entry.devOptional) continue;
    const directory = join(root, path);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (manifest.version !== entry.version) throw new Error(`Installed version differs from lockfile: ${path}`);
    const notices = await licenseTexts(directory);
    const source = supplemental[`${manifest.name}@${manifest.version}`];
    if (!notices.length && source) {
      for (const notice of [source].flat()) {
        notices.push(await supplementalNotice(notice));
      }
    }
    dependencies.push({
      ecosystem: 'npm', name: manifest.name, version: manifest.version,
      license: manifest.license ?? entry.license ?? 'Not declared',
      source: entry.resolved, notices,
    });
  }
  if (desktop) {
    const metadata = JSON.parse(execFileSync('cargo',
      ['metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--format-version', '1'],
      { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
    for (const pkg of metadata.packages.filter((pkg) => pkg.source || pkg.name === 'glib').sort((a, b) => a.id.localeCompare(b.id))) {
      const directory = dirname(pkg.manifest_path);
      const notices = await licenseTexts(directory);
      if (pkg.license_file && !notices.some((notice) => notice.file === pkg.license_file)) {
        // Cargo paths are relative to this dependency's unpacked crate.
        const path = resolve(directory, pkg.license_file);
        if (!path.startsWith(`${directory}/`)) throw new Error(`License path escapes crate: ${pkg.name}`);
        notices.push({ file: pkg.license_file, text: await readFile(path, 'utf8') });
      }
      const source = supplemental[`crates.io:${pkg.name}@${pkg.version}`];
      if (!notices.length && source) {
        for (const notice of [source].flat()) {
          notices.push(await supplementalNotice(notice));
        }
      }
      dependencies.push({ ecosystem: 'crates.io', name: pkg.name, version: pkg.version,
        license: pkg.license ?? 'Not declared', source: pkg.source ?? 'src-tauri/vendor/glib (reviewed upstream backport; see src-tauri/vendor/README.md)', notices });
    }
  }
  const inventory = dependencies.map(({ notices, ...entry }) => ({ ...entry, noticeFiles: notices.map((notice) => notice.file) }));
  const header = 'Third-party dependency notices\n\nGenerated from the locked dependency versions and installed license files.\nLicense declarations are reproduced from package metadata; this inventory does not grant additional rights.\n';
  const text = header + dependencies.map((entry) =>
    `\n${entry.ecosystem}: ${entry.name}@${entry.version}\nDeclared license: ${typeof entry.license === 'string' ? entry.license : JSON.stringify(entry.license)}\nSource: ${entry.source}\n` +
    (entry.notices.length ? entry.notices.map((notice) => `\n${notice.file}\n${notice.source ? `Upstream: ${notice.source}\n` : ''}${notice.text}\n`).join('') : '\nNo license text was included at the package root; consult the declared upstream source.\n'),
  ).join('\n');
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'THIRD-PARTY-NOTICES.txt'), text);
  await writeFile(join(destination, 'DEPENDENCY-LICENSES.json'), JSON.stringify(inventory, null, 2) + '\n');
  const missing = inventory.filter((entry) => !entry.noticeFiles.length);
  console.log(`Generated notices for ${dependencies.length} dependencies (${missing.length} missing license ${missing.length === 1 ? 'notice' : 'notices'}).`);
  return { dependencies: dependencies.length, missing };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateNotices(resolve(process.argv[2] ?? 'dist'), { desktop: process.argv.includes('--desktop') });
}
