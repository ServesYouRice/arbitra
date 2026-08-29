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
  // The entry chunk is what the size warning is for, and it sits near 300 kB. The only
  // chunk above the 500 kB default is elkjs, a single 1.4 MB vendor module that cannot be
  // split further and is already loaded on demand behind the graph view, so the limit is
  // raised past it rather than left to warn on every build.
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 1500 },
  // The UI addresses the control plane with root-relative paths, so the dev server
  // forwards exactly the control-plane and evaluation route prefixes to it and serves
  // everything else itself. Without this the app fetches its own index.html and reports
  // the API as unavailable.
  server: {
    host: "127.0.0.1",
    port: 4173,
    proxy: Object.fromEntries(["/configurations", "/repositories", "/estimate", "/runs"].map((prefix) => [prefix, {
      target: "http://127.0.0.1:4178",
      changeOrigin: false,
    }])),
  },
});
