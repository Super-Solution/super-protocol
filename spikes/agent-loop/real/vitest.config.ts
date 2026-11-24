// Runs the spike's cases against Super Chat's REAL runAgent. Needs a Super Chat checkout with `pnpm install` done:
//   SUPER_CHAT_DIR=/path/to/super-chat pnpm exec vitest run --config <this file> --root <this folder>
// (from inside the Super Chat checkout, so `pnpm exec` finds vitest). The core is imported from source.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const chat = process.env.SUPER_CHAT_DIR;
if (!chat) throw new Error("Set SUPER_CHAT_DIR to a Super Chat checkout.");

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: { alias: { "@supersolutions/super-chat-core": `${chat}/packages/core/src/index.ts` } },
  server: { fs: { strict: false } },
  test: { include: ["*.test.ts"], environment: "node" },
});
