// Editor-only typing shim so files outside the Vite project can still typecheck
// `import.meta.env.BASE_URL` references used by the site.
//
// This is intentionally minimal (we don't want to pull in full Vite types into
// the Node/tsc build unless we need them).

interface ImportMetaEnv {
  readonly BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
