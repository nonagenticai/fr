# Security Advisories

## Known Unpatched (dev-only, not exploitable at runtime)

### GHSA-67mh-4wv8-2f99 — esbuild dev server moderate

- **Severity:** Moderate
- **Affected dep chain:** `drizzle-kit` → `@esbuild-kit/core-utils` → `esbuild@<=0.24.2`
- **Advisory:** esbuild's built-in HTTP development server allows cross-origin requests
- **Why unpatched:** `@esbuild-kit/core-utils` and `@esbuild-kit/esm-loader` are deprecated
  packages with no newer releases. They are transitive deps of `drizzle-kit` and used
  solely as a bundler/transpiler — the esbuild dev server feature is never invoked.
  This is a dev-only tool; it is not part of the production runtime image.
- **Tracking:** Upgrade `drizzle-kit` when it drops the `@esbuild-kit` dependency.
  As of drizzle-kit 0.31.10 (2026-04-22), the dep remains.
