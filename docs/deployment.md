# Deployment

Signal Lab is a pnpm monorepo. Use Node.js 22 and pnpm 10.32.1 (pinned in
`package.json`); install with `pnpm install --frozen-lockfile`. Run `pnpm build`
from the repository root to typecheck and build all projects. The mockup and
Signal Lab builds default to `/` when `BASE_PATH` is not set; set it explicitly
when hosting under a subpath.

## Vercel projects

Connect each Vercel project to the appropriate **Root Directory**, and enable
**Include source files outside of the Root Directory in the Build Step** so pnpm
can read the workspace, lockfile, shared packages, and DBot engine:

| Project | Root Directory | Preset / output |
| --- | --- | --- |
| Signal Lab | `artifacts/deriv-signal-lab` | Vite / `dist` |
| API | `artifacts/api-server` | Express (the default entrypoint or `dist`) |
| Mockup sandbox | `artifacts/mockup-sandbox` | Vite / `dist` |

The versioned Vercel configurations opt in to Corepack so builds use the pinned
pnpm version rather than selecting pnpm 9 from the shared lockfile. Vercel
projects using the repository root instead of a project directory must either
be reconfigured to the appropriate root above, or explicitly select a build
command and output for the intended application. The root build produces
separate outputs; it does not create a single root `public` directory.

The API is mounted under `/api`; verify a deployment with `GET /api/healthz`.
Front-end deployments must route `/api/*` to the intended API deployment at
the same origin (or otherwise configure their hosting routing); a successful
static build alone does not verify the API. Do not place server secrets in
`VITE_*` variables. `pnpm --filter @workspace/api-server test:deployment`
exercises both API entrypoints locally.
