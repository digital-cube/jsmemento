import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.MEMENTO_SERVER || "http://localhost:8000";
  return {
    plugins: [react()],
    // Use the workspace packages' TypeScript sources: no build step before `pnpm dev`.
    resolve: { conditions: ["@memento/source", ...defaultClientConditions] },
    server: {
      port: 5173,
      // Same origin for the browser: the API and the WebSocket stream go through the proxy.
      proxy: { "/memento": { target, changeOrigin: true, ws: true } },
    },
    preview: {
      proxy: { "/memento": { target, changeOrigin: true, ws: true } },
    },
  };
});
