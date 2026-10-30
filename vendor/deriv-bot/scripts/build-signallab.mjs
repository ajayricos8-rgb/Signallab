// Build the vendored Deriv workspace as a self-contained part of the Vite app.
import { spawnSync } from 'node:child_process';
import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(root, '../../artifacts/deriv-signal-lab/public/dbot');
const result = spawnSync(path.join(root, 'node_modules/.bin/rsbuild'), ['build'], { cwd: root, env: process.env, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);

// Third-party CSS includes network @imports. A failed font import can cause a
// lazy CSS chunk to fail completely, so use system fonts and ship the Quill
// design tokens locally rather than relying on a CDN.
const prefix = `/${(process.env.BASE_PATH || '/').replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '') + '/dbot/';
const index = path.join(output, 'index.html');
await writeFile(index, (await readFile(index, 'utf8')).replace('__SIGNAL_LAB_DBOT_BASE__', prefix));
await copyFile(path.join(root, 'node_modules/@deriv-com/quill-tokens/dist/quill.css'), path.join(output, 'quill-tokens.css'));
let patchedChartAssetBase = 0;
async function fixAssets(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await fixAssets(file);
    else if (entry.name.endsWith('.css')) {
      const content = await readFile(file, 'utf8');
      const rewritten = content
        .replace(/@import\s+(?:url\()?['"]?https:\/\/fonts\.googleapis\.com\/[^;]+;/g, '')
        .replace(/@import\s+(?:url\()?['"]?https:\/\/cdn\.jsdelivr\.net\/npm\/@deriv-com\/quill-tokens@[^;]+;/g, `@import url("${prefix}quill-tokens.css");`);
      if (rewritten !== content) await writeFile(file, rewritten);
    } else if (entry.name.endsWith('.js')) {
      // The upstream SmartCharts Flutter loader hardcodes `assetBase: \"/\"`.
      // Replace it in the built bundle so manifests and fonts resolve inside
      // this sub-application instead of the host's unrelated /assets folder.
      const content = await readFile(file, 'utf8');
      const rewritten = content.replace(/assetBase:\"\/\"/g, () => {
        patchedChartAssetBase += 1;
        return `assetBase:${JSON.stringify(prefix)}`;
      });
      if (rewritten !== content) await writeFile(file, rewritten);
    }
  }
}
await fixAssets(output);
if (!patchedChartAssetBase) throw new Error('Could not locate the SmartCharts asset base in the build output.');
