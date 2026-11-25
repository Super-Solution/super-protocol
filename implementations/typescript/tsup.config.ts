import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", plugin: "src/plugin.ts", chat: "src/chat.ts", router: "src/router.ts", run: "src/run.ts", editor: "src/editor.ts", chart: "src/chart.ts", ref: "src/ref.ts", plot: "src/plot.ts", theme: "src/theme.ts", placement: "src/placement.ts", mapping: "src/mapping.ts", version: "src/version.ts", "interop/ag-ui": "src/interop/ag-ui.ts", "interop/ai-sdk": "src/interop/ai-sdk.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
});
