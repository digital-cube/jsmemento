import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig, loadEnv } from "vite";
import { clientsPlugin } from "./vite-plugin-clients.js";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // A server with MEMENTO_ACCOUNTS=true. Same origin for the browser, so the session cookie
  // (HttpOnly, SameSite=Lax, path /) set by /memento/auth/* rides along on every call.
  const target = env.MEMENTO_SERVER || "http://localhost:8000";
  const proxy = { "/memento": { target, changeOrigin: true } };
  return {
    // clientsPlugin: the /clients page (`virtual:clients`) and dist/clients/<lang>.zip.
    plugins: [react(), clientsPlugin()],
    // Use the workspace packages' TypeScript sources: no build step before `pnpm dev`.
    resolve: { conditions: ["@memento/source", ...defaultClientConditions] },
    // Production bundle (served by @memento/server from MEMENTO_UI_DIR): no source maps.
    build: { outDir: "dist", sourcemap: false },
    server: { port: 5174, proxy },
    preview: { proxy },
  };
});
