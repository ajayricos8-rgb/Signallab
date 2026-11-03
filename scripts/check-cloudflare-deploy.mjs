// A small, dependency-free guard for the settings Workers Builds relies on.
// It runs before a manual deploy and is safe to run in any CI image with Node.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');

const packageJson = JSON.parse(await read('package.json'));
assert.equal(
  packageJson.devDependencies?.wrangler,
  '4.156.2',
  'pin Wrangler so Workers Builds cannot drift to an untested release',
);
for (const legacyRoot of ['deriv-signal-lab', 'api-server', 'mockup-sandbox']) {
  assert.match(
    packageJson.scripts?.build ?? '',
    new RegExp(`artifacts/${legacyRoot}/dist`),
    `the root build must also publish to the legacy ${legacyRoot} path`,
  );
}

const legacyRoots = ['deriv-signal-lab', 'api-server', 'mockup-sandbox'];
const configPaths = [
  'wrangler.jsonc',
  ...legacyRoots.map((directory) => `artifacts/${directory}/wrangler.jsonc`),
];

for (const directory of legacyRoots) {
  const legacyPackage = JSON.parse(await read(`artifacts/${directory}/package.json`));
  assert.match(
    legacyPackage.scripts?.build ?? '',
    /npm --prefix \.\.\/\.\. run build/,
    `artifacts/${directory} must forward its build to the repository root`,
  );
}

assert.match(
  await read('pnpm-workspace.yaml'),
  /artifacts\/deriv-signal-lab/,
  'keep the legacy pnpm build command compatible',
);

for (const configPath of configPaths) {
  // Keep this strict: Workers Builds reads the config before Wrangler starts,
  // and JSONC-only comments have made that step fail on some builds.
  const config = JSON.parse(await read(configPath));
  assert.equal(config.name, 'signallab', `${configPath}: Worker name must match the connected Worker`);
  assert.ok(config.compatibility_date, `${configPath}: compatibility_date is required`);
  assert.ok(config.assets?.directory, `${configPath}: an assets directory is required`);
  assert.ok(config.build?.command, `${configPath}: Wrangler must build dist before upload`);
  assert.ok(
    config.build.command.includes('npm run build'),
    `${configPath}: the custom build must produce the Vite bundle`,
  );
  assert.deepEqual(
    config.previews,
    {},
    `${configPath}: an empty previews block keeps npx wrangler preview working`,
  );
  assert.equal(config.observability?.enabled, true, `${configPath}: keep observability on`);
}

const headers = await read('public/_headers');
assert.match(
  headers,
  /\/index\.html[\s\S]*Cache-Control:\s*no-store[^\n]*no-cache/,
  'index.html must not be cached',
);
assert.match(
  headers,
  /\n\/[\s\S]*Cache-Control:\s*no-store[^\n]*no-cache/,
  'the site root must not be cached',
);
assert.match(headers, /\/assets\/\*[\s\S]*immutable/, 'fingerprinted assets should stay immutable');

console.log('Cloudflare deploy configuration is valid.');
