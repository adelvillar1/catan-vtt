/**
 * vitest.config.ts — table unit tests (node env).
 *
 * P1 tests are pure: geometry alignment (src/scene/geom.test.ts) and the wire
 * frame router (src/wire/adapter.test.ts). No R3F/DOM rendering is tested —
 * `npm run build` is the gate that proves the TSX/JSX graph resolves.
 */
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const sharedSrc = fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: "@catan-vtt/shared", replacement: sharedSrc }],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    root: fileURLToPath(new URL(".", import.meta.url)),
  },
});
