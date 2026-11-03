// Compatibility helper for deployments whose configured root directory still
// points at artifacts/deriv-signal-lab. The app now builds to the repository
// root's dist/, so copy that exact output into the legacy project's publish
// directory; never rebuild a second, potentially different bundle.
import { cp, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'dist');
const target = path.resolve(process.cwd(), process.argv[2] ?? './dist');

const sourceInfo = await stat(source);
if (!sourceInfo.isDirectory()) {
  throw new Error(`${source} is not a build directory; run npm run build first`);
}

await cp(source, target, { recursive: true, force: true });
console.log(`Copied ${path.relative(root, source)} to ${path.relative(root, target)}`);
