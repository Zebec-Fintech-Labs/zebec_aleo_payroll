import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ["@provablehq/sdk"],
    // The sdk's browser bundle imports this core-js proposal module, which is
    // CommonJS; pre-bundle it or the browser hits `require is not defined`.
    include: ["core-js/proposals/json-parse-with-source.js"],
  },
  worker: {
    format: "es",
  },
  build: {
    // @provablehq/sdk's wasm init uses top-level await.
    target: "esnext",
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: {
      allow: [".."],
    },
  },
});
