import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory = path.resolve(scriptDirectory, '..');
const apiDirectory = path.resolve(frontendDirectory, '../api-server');
const viteEntry = path.join(frontendDirectory, 'node_modules/vite/bin/vite.js');
const apiProxyTarget = process.env.API_PROXY_TARGET || 'http://127.0.0.1:8080';
const apiUrl = new URL(apiProxyTarget);
const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
const localApi = localHosts.has(apiUrl.hostname);
const apiPort = Number(process.env.API_PORT || apiUrl.port || (apiUrl.protocol === 'https:' ? 443 : 80));
const apiHealthUrl = new URL('/api/healthz', apiUrl).toString();
const apiEntry = path.join(apiDirectory, 'dist/index.mjs');
const frontendPort = process.env.PORT || '18781';
const basePath = process.env.BASE_PATH || '/';

let apiProcess = null;
let viteProcess = null;
let stopping = false;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function apiIsReady() {
  try {
    const response = await fetch(apiHealthUrl, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForApi(child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`Authentication API exited before becoming ready (exit ${child.exitCode}).`);
    }
    if (await apiIsReady()) return;
    await delay(250);
  }
  throw new Error(`Authentication API did not become ready at ${apiHealthUrl}.`);
}

function stopChildren(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of [viteProcess, apiProcess]) {
    if (child && child.exitCode === null) child.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const child of [viteProcess, apiProcess]) {
      if (child && child.exitCode === null) child.kill('SIGKILL');
    }
  }, 2_000).unref();
}

async function start() {
  if (!(await apiIsReady())) {
    if (!localApi) {
      throw new Error(`The configured API server is not reachable at ${apiHealthUrl}.`);
    }
    if (!existsSync(path.join(apiDirectory, 'build.mjs'))) {
      throw new Error(`Could not locate the API server package at ${apiDirectory}.`);
    }
    const build = spawnSync(process.execPath, ['build.mjs'], {
      cwd: apiDirectory,
      env: { ...process.env, NODE_ENV: 'development' },
      stdio: 'inherit',
    });
    if (build.status !== 0) {
      throw new Error(`Authentication API build failed${build.status === null ? '' : ` (exit ${build.status})`}.`);
    }
    apiProcess = spawn(process.execPath, [`--env-file-if-exists=${path.join(apiDirectory, '.env')}`, '--enable-source-maps', 'dist/index.mjs'], {
      cwd: apiDirectory,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PORT: String(apiPort),
      },
      stdio: 'inherit',
    });
    apiProcess.on('error', (error) => {
      console.error('Could not start the API server:', error.message);
      stopChildren(1);
    });
    apiProcess.on('exit', (code) => {
      if (!stopping) {
        console.error(`Authentication API exited unexpectedly (exit ${code ?? 'unknown'}).`);
        stopChildren(code || 1);
      }
    });
    await waitForApi(apiProcess);
  }

  viteProcess = spawn(process.execPath, [viteEntry, '--config', 'vite.config.ts', '--host', '0.0.0.0'], {
    cwd: frontendDirectory,
    env: { ...process.env, PORT: frontendPort, BASE_PATH: basePath, API_PROXY_TARGET: apiProxyTarget },
    stdio: 'inherit',
  });
  viteProcess.on('error', (error) => {
    console.error('Could not start the frontend dev server:', error.message);
    stopChildren(1);
  });
  viteProcess.on('exit', (code) => stopChildren(code ?? 0));
}

process.on('SIGINT', () => stopChildren(0));
process.on('SIGTERM', () => stopChildren(0));

start().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Could not start Signal Lab development services.');
  stopChildren(1);
});
