// A small, dependency-free guard for the settings Cloudflare Workers Builds
// relies on. It deliberately validates every historical build root because the
// production service may still be configured with one of them in the dashboard.
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');

const packageJson = JSON.parse(await read('package.json'));
const packageLock = JSON.parse(await read('package-lock.json'));
assert.equal(
  packageJson.devDependencies?.wrangler,
  '4.156.2',
  'pin Wrangler so Workers Builds cannot drift to an untested release',
);
assert.equal(packageLock.lockfileVersion, 3, 'commit the npm lockfile used by the Cloudflare build');
assert.equal(packageLock.packages?.['']?.name, packageJson.name, 'package-lock.json must describe this app');
for (const script of ['build', 'build:cloudflare']) {
  assert.equal(
    packageJson.scripts?.[script],
    'node scripts/cloudflare-build.mjs',
    `${script} must restore the locked dependency graph before running Vite`,
  );
}
await access(path.join(root, 'scripts/cloudflare-build.mjs'));

// The vendored DBot app imports a legacy icon shim from `src/utils/tmp/dummy`,
// a directory name the generic `tmp` ignore rule would otherwise swallow.
// Workers Builds checks out the repository before running the custom build, so
// an ignored shim makes every production build fail with unresolved imports.
const dummyIcon = 'vendor/deriv-bot/src/utils/tmp/dummy.tsx';
await access(path.join(root, dummyIcon));
assert.match(
  await read(dummyIcon),
  /export const Icon/,
  'the vendored DBot icon shim must export Icon for the /dbot/ bundle to build',
);
assert.match(
  await read('.gitignore'),
  /!vendor\/deriv-bot\/src\/utils\/tmp\//,
  'un-ignore the vendored DBot source shim so Workers Builds checks it out',
);
assert.match(
  await read('scripts/build-dbot.mjs'),
  /['"]ci['"],\s*['"]--include=dev['"]/,
  'the vendored /dbot/ build must install dev tools under NODE_ENV=production',
);

for (const legacyRoot of ['deriv-signal-lab', 'api-server', 'mockup-sandbox']) {
  assert.match(
    packageJson.scripts?.['build:app'] ?? '',
    new RegExp(`artifacts/${legacyRoot}/dist`),
    `the root application build must also publish to the legacy ${legacyRoot} path`,
  );
}

const legacyRoots = ['deriv-signal-lab', 'api-server', 'mockup-sandbox'];
const configPaths = [
  'wrangler.jsonc',
  ...legacyRoots.map((directory) => `artifacts/${directory}/wrangler.jsonc`),
];

for (const directory of legacyRoots) {
  const legacyPackage = JSON.parse(await read(`artifacts/${directory}/package.json`));
  assert.equal(
    legacyPackage.scripts?.build,
    'node ../../scripts/cloudflare-build.mjs',
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
  const usesReproducibleBuild = configPath === 'wrangler.jsonc'
    ? config.build.command === 'npm run build:cloudflare'
    : /cloudflare-build\.mjs/.test(config.build.command);
  assert.ok(
    usesReproducibleBuild,
    `${configPath}: the custom build must restore the locked dependency graph`,
  );
  assert.deepEqual(
    config.previews,
    {},
    `${configPath}: an empty previews block keeps npx wrangler preview working`,
  );
  assert.equal(config.observability?.enabled, true, `${configPath}: keep observability on`);
  assert.equal(config.env?.production?.name, 'signallab', `${configPath}: production must deploy the connected Worker`);
  assert.deepEqual(
    config.env?.production?.assets,
    config.assets,
    `${configPath}: production must explicitly include the static asset directory`,
  );
  assert.deepEqual(
    config.env?.production?.build,
    config.build,
    `${configPath}: production must run the same reproducible build`,
  );
}

const headers = await read('public/_headers');
assert.match(
  headers,
  /\/\*[\s\S]*Cache-Control:\s*no-store[^\n]*no-cache/,
  'HTML and every non-fingerprinted public file must not be cached',
);
assert.match(headers, /\/assets\/\*[\s\S]*immutable/, 'fingerprinted assets should stay immutable');

console.log('Cloudflare deploy configuration is valid.');
