#!/usr/bin/env node
// Container health check: exits 0 when GET <prefix>/api/health answers 200 (the server is up and
// reaches PostgreSQL). Installed in the image as `memento-healthcheck`.
const port = process.env.PORT || "3000";
const prefix = (process.env.MEMENTO_API_PREFIX || "/memento").replace(/\/+$/, "");
try {
  const response = await fetch(`http://127.0.0.1:${port}${prefix}/api/health`, {
    signal: AbortSignal.timeout(4000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
