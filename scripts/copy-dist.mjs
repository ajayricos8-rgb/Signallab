// Compatibility helper for deployments whose configured root directory still
// points at artifacts/deriv-signal-lab. The app now builds to the repository
// root's dist/, so copy that exact output into the legacy project's publish
// directory; never rebuild a second, potentially different bundle.
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'dist');
const target = path.resolve(process.cwd(), process.argv[2] ?? './dist');

const sourceInfo = await stat(source);
if (!sourceInfo.isDirectory()) {
  throw new Error(`${source} is not a build directory; run npm run build first`);
}
if (source === target) {
  throw new Error('The Cloudflare compatibility publish directory must not be the root dist directory');
}

// Remove stale hashed files before copying. A build may replace an asset hash;
// retaining the old file leaves legacy publish directories out of sync and can
// make a stale deployment look like the current app.
await rm(target, { recursive: true, force: true });
await mkdir(path.dirname(target), { recursive: true });
await cp(source, target, { recursive: true, force: true });
console.log(`Synced ${path.relative(root, source)} to ${path.relative(root, target)}`);
