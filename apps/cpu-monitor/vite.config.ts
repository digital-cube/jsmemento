import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.MEMENTO_SERVER || "http://localhost:8000";
  // Same origin for the browser: UDC (POST /memento/udc/*), health and the WebSocket stream.
  const proxy = { "/memento": { target, changeOrigin: true, ws: true } };
  return {
    plugins: [react()],
    // Use the workspace packages' TypeScript sources: no build step before `pnpm dev`.
    resolve: { conditions: ["@memento/source", ...defaultClientConditions] },
    server: { port: 5173, proxy },
    preview: { proxy },
  };
});
