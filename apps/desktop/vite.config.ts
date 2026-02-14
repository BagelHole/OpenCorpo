import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  root: "renderer",
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/health": "http://127.0.0.1:3555",
      "/approvals": "http://127.0.0.1:3555",
      "/jobs": "http://127.0.0.1:3555",
      "/audit": "http://127.0.0.1:3555",
      "/plugins": "http://127.0.0.1:3555",
      "/tools": "http://127.0.0.1:3555",
      "/chat": "http://127.0.0.1:3555",
      "/connectors": "http://127.0.0.1:3555",
      "/diagnostics": "http://127.0.0.1:3555",
      "/events": "http://127.0.0.1:3555",
      "/auth": "http://127.0.0.1:3555",
      "/control-plane": "http://127.0.0.1:3555",
      "/code": "http://127.0.0.1:3555",
      "/secrets": "http://127.0.0.1:3555",
      "/oauth": "http://127.0.0.1:3555",
      "/stream": "http://127.0.0.1:3555"
    }
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "renderer/src")
    }
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true
  }
});
