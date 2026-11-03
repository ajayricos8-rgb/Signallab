// Build the vendored Deriv Bot app before Vite starts or produces a deployment.
// Keeping this in public/dbot makes the iframe a real asset, never an SPA route
// fallback (which otherwise shows a blank nested copy of the host app).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(root, 'vendor/deriv-bot');
const lockPath = path.join(vendorRoot, 'package-lock.json');
const output = path.join(root, 'artifacts/deriv-signal-lab/public/dbot');
const publicTarget = path.join(root, 'public/dbot');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const lockHash = createHash('sha256').update(await readFile(lockPath)).digest('hex');
const installedHashPath = path.join(vendorRoot, 'node_modules/.signallab-lock-hash');

function run(args, cwd) {
  const result = spawnSync(npm, args, { cwd, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

let installedHash = '';
try {
  await access(path.join(vendorRoot, 'node_modules/.bin/rsbuild'));
  installedHash = (await readFile(installedHashPath, 'utf8')).trim();
} catch {
  // Install the separate DBot dependency tree below.
}
if (installedHash !== lockHash) {
  run(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], vendorRoot);
  await writeFile(installedHashPath, lockHash);
}

run(['run', 'build'], vendorRoot);
await rm(publicTarget, { recursive: true, force: true });
await mkdir(path.dirname(publicTarget), { recursive: true });
await cp(output, publicTarget, { recursive: true });
console.log('DBot workspace is ready at public/dbot for the host app.');
