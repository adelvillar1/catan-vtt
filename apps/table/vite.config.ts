/**
 * vite.config.ts — table dev server (:4274) + production build.
 *
 * `@catan-vtt/shared` is a workspace package whose entry points at TS source
 * (packages/shared/src/index.ts), so it needs an explicit alias — there is no
 * build step in the shared package.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const sharedSrc = fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: "@catan-vtt/shared", replacement: sharedSrc }],
  },
  server: { port: 4274, strictPort: true },
  build: { outDir: "dist", sourcemap: true },
});
