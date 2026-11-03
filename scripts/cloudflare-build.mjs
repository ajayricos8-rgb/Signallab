// Reproducible Cloudflare build entrypoint.
//
// Workers Builds may run with NODE_ENV=production. Vite, TypeScript and the
// Vite React plugin are development dependencies, so a plain `npm install`
// can omit exactly the tools needed to produce the static bundle. Always
// restore the committed dependency graph and explicitly include dev tools.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(npm, args, {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`npm ${args.join(' ')} ${signal ? `was terminated by ${signal}` : `failed with exit code ${code}`}`));
    });
  });
}

await run(['ci', '--include=dev', '--no-audit', '--no-fund']);
await run(['run', 'build']);
