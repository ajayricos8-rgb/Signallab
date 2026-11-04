// Build the official Deriv Bot workspace into `public/dbot`.
//
// The workspace is a same-origin sub-application of the Vite app, so it has to
// be a real asset (`public/dbot/index.html`), never an SPA route fallback: a
// fallback hands the iframe a copy of the host shell, which mounts nothing and
// leaves the panel blank.
//
// The source under `vendor/deriv-bot` is the upstream app (deriv-com/bot) with a
// small, documented patch set: sub-application base path, the Signal Lab host
// channel, account adoption, and the boot deadlines. Everything else is stock.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(root, 'vendor/deriv-bot');
const lockPath = path.join(vendorRoot, 'package-lock.json');
const buildOutput = path.join(vendorRoot, 'dist');
const publicTarget = path.join(root, 'public/dbot');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const base = `/${(process.env.BASE_PATH || '/').replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');
const dbotBase = `${base}/dbot/`;

function run(args, cwd) {
  const result = spawnSync(npm, args, { cwd, env: { ...process.env, BASE_PATH: base }, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// ---- dependencies ---------------------------------------------------------
// Workers Builds and CI run with NODE_ENV=production, where npm omits
// devDependencies — but rsbuild, its plugins and Sass live there, so always
// restore the full locked graph explicitly.
const lockHash = createHash('sha256').update(await readFile(lockPath)).digest('hex');
const installedHashPath = path.join(vendorRoot, 'node_modules/.signallab-lock-hash');
let installedHash = '';
try {
  await access(path.join(vendorRoot, 'node_modules/.bin/rsbuild'));
  installedHash = (await readFile(installedHashPath, 'utf8')).trim();
} catch {
  // Install the separate DBot dependency tree below.
}
if (installedHash !== lockHash) {
  run(['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], vendorRoot);
  await access(path.join(vendorRoot, 'node_modules/.bin/rsbuild'));
  await writeFile(installedHashPath, lockHash);
}

// ---- build ----------------------------------------------------------------
run(['run', 'build'], vendorRoot);

await rm(publicTarget, { recursive: true, force: true });
await mkdir(path.dirname(publicTarget), { recursive: true });
await cp(buildOutput, publicTarget, { recursive: true });

// ---- post-process the bundle ---------------------------------------------
// Third-party CSS carries network @imports; a blocked font import can fail a
// whole lazy CSS chunk. Ship the Quill tokens locally and drop the rest.
let patchedAssetBase = 0;
async function rewrite(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await rewrite(file);
      continue;
    }
    if (entry.name.endsWith('.css')) {
      const content = await readFile(file, 'utf8');
      const rewritten = content
        .replace(/@import\s+(?:url\()?['"]?https:\/\/fonts\.googleapis\.com\/[^;]+;/g, '')
        .replace(
          /@import\s+(?:url\()?['"]?https:\/\/cdn\.jsdelivr\.net\/npm\/@deriv-com\/quill-tokens@[^;]+;/g,
          `@import url("${dbotBase}quill-tokens.css");`,
        );
      if (rewritten !== content) await writeFile(file, rewritten);
      continue;
    }
    if (entry.name.endsWith('.js')) {
      // The upstream SmartCharts Flutter loader hardcodes `assetBase: "/"`.
      const content = await readFile(file, 'utf8');
      const rewritten = content.replace(/assetBase:"\/"/g, () => {
        patchedAssetBase += 1;
        return `assetBase:${JSON.stringify(dbotBase)}`;
      });
      if (rewritten !== content) await writeFile(file, rewritten);
    }
  }
}
await rewrite(publicTarget);

const quillSource = path.join(vendorRoot, 'node_modules/@deriv-com/quill-tokens/dist/quill.css');
try {
  await copyFile(quillSource, path.join(publicTarget, 'quill-tokens.css'));
} catch {
  // The tokens are optional: system fonts are used when they are missing.
}

console.log(
  `DBot workspace is ready at public/dbot (base ${dbotBase}${patchedAssetBase ? `, ${patchedAssetBase} chart asset base(s) patched` : ''}).`,
);
