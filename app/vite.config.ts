import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite only watches files under the project root (`app/`), so edits to the
 * sibling `sdk/` sources never invalidate the dev-server transform cache and
 * the browser keeps serving stale modules. Explicitly add the directory to
 * chokidar's watch list.
 */
function watchOutOfRootSdk(): Plugin {
  return {
    name: "watch-out-of-root-sdk",
    configureServer(server) {
      server.watcher.add(fileURLToPath(new URL("../sdk", import.meta.url)));
    },
  };
}

export default defineConfig({
  plugins: [react(), watchOutOfRootSdk()],
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
