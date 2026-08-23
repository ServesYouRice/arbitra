import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: {
    "elkjs": fileURLToPath(new URL("./node_modules/elkjs/lib/elk.bundled.js", import.meta.url)),
    "@arbitra/schemas/glyphs": fileURLToPath(new URL("../../packages/schemas/src/glyphs.ts", import.meta.url)),
    "@arbitra/schemas/http-control-plane": fileURLToPath(new URL("../../packages/schemas/src/http-control-plane.ts", import.meta.url)),
  } },
  build: { outDir: "dist", sourcemap: true },
  server: { host: "127.0.0.1", port: 4173 },
});
