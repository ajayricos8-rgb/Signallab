---
name: Artifact build environment
description: Environment variables needed when building Vite artifacts outside their managed workflows.
---

When running a workspace-wide Vite build directly, provide both `PORT` and `BASE_PATH`; artifact-managed workflows normally inject these values, but a plain build shell does not.

**Why:** Vite configuration validates the artifact routing environment during build setup, so an unset variable can fail the build before application code is checked.

**How to apply:** For manual workspace builds, set `PORT` and a valid `BASE_PATH` in the command environment. Do not change the artifact manifest just to address a local build invocation failure.