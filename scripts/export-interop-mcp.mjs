// Writes conformance/interop-mcp.v0.json (DRAFT, like the agent-loop files: not part of protocol.v1.json and not stable):
// what the functions of implementations/typescript/src/interop/mcp.ts return, in the shape of the `mapping` section of
// protocol.v1.json: `{ fn, ...inputs, expect: { value } | { error } }`, so the language-neutral runner can run it
// (`node scripts/conformance-run.mjs --file conformance/interop-mcp.v0.json --command ...` with a program that has these functions).
//
// The expected values are what the TypeScript reference returns. They are NOT checked against an MCP SDK (none is a
// dependency of this package); the names and rules come from MCP 2026-07-28 (tool annotations, elicitation) and MCP Apps
// 2026-01-26 (host context), and the table in docs/INTEROP.md says where each rule is from.
//
// Run `pnpm build` first (the generator imports the built package). `--check` is what scripts/check-all.sh runs.
import { fileURLToPath } from "node:url";
import { writeGolden } from "./lib/golden.mjs";
import * as mcp from "../implementations/typescript/dist/interop/mcp.js";

const run = (fn) => {
  try {
    return { value: fn() ?? null };
  } catch (e) {
    return { error: e.message };
  }
};
const clone = (v) => JSON.parse(JSON.stringify(v));
const cases = [];
const add = (fn, inputs, call) => cases.push({ fn, ...inputs, expect: run(() => call(clone(inputs))) });

// authority -> annotations
for (const value of ["read", "draft", "act", "admin", "READ", "", null, undefined, 1, {}, []]) add("tool_annotations", { value }, ({ value: v }) => mcp.toolAnnotationsFromAuthority(v));

// annotations -> authority: untrusted by default; trusted reads the hints
const annotationCases = [
  { readOnlyHint: true },
  { readOnlyHint: true, destructiveHint: true },
  { readOnlyHint: false },
  { readOnlyHint: false, destructiveHint: false },
  { readOnlyHint: false, destructiveHint: true },
  { destructiveHint: false },
  { destructiveHint: true },
  { readOnlyHint: "true" },
  { readOnlyHint: 1 },
  { readOnlyHint: false, destructiveHint: "no" },
  { title: "Delete", idempotentHint: true, openWorldHint: false },
  {},
  null,
  "read",
  [],
];
for (const annotations of annotationCases) {
  add("authority_from_annotations", { annotations }, ({ annotations: a }) => mcp.authorityFromAnnotations(a));
  add("authority_from_annotations", { annotations, trusted: false }, ({ annotations: a }) => mcp.authorityFromAnnotations(a, { trusted: false }));
  add("authority_from_annotations", { annotations, trusted: true }, ({ annotations: a }) => mcp.authorityFromAnnotations(a, { trusted: true }));
}
add("authority_from_annotations", { annotations: { readOnlyHint: true }, trusted: "yes" }, ({ annotations: a, trusted }) => mcp.authorityFromAnnotations(a, { trusted }));
// The two directions agree for every authority a host can declare.
for (const authority of ["read", "draft", "act"]) add("authority_round_trip", { authority }, ({ authority: a }) => mcp.authorityFromAnnotations(mcp.toolAnnotationsFromAuthority(a), { trusted: true }));

// theme -> MCP Apps host context
const themes = [
  { mode: "light", tokens: {} },
  { mode: "dark", tokens: {} },
  { mode: "dark", tokens: { background: "#0b1011", surface: "#10181a", "surface-raised": "#162022", border: "#243033", text: "#e6eef0", "text-muted": "#8aa0a4", "font-sans": "Inter, sans-serif", "font-mono": "ui-monospace, monospace", radius: "8px" } },
  { mode: "light", tokens: { accent: "#0a7", "accent-contrast": "#fff" } },
  { mode: "light", tokens: { positive: "#0a7", negative: "#c33", warning: "#d90", info: "#06c", text: "light-dark(#171717, #fafafa)" } },
  { mode: "light", tokens: { text: "url(https://example.com/x)", background: "#fff;} body{display:none", border: "" } },
  { mode: "dark", tokens: { text: "#fff", unknown: "#000" } },
];
for (const theme of themes) add("theme_to_mcp_apps", { theme }, ({ theme: t }) => mcp.hostThemeToMcpAppsContext(t));

// MCP Apps host context -> theme (untrusted input)
const contexts = [
  { theme: "dark", styles: { variables: { "--color-background-primary": "#171717", "--color-text-primary": "#fafafa", "--font-sans": "Anthropic Sans, sans-serif", "--border-radius-md": "6px" } } },
  { theme: "light", styles: { variables: { "--color-text-success": "light-dark(#0a7, #3d9)", "--color-text-danger": "#c33", "--color-text-warning": "#d90", "--color-text-info": "#06c" } } },
  { theme: "light", styles: { variables: { "--color-background-primary": "url(https://example.com/x)", "--color-text-primary": "#111", "--color-ring-primary": "#00f", "--shadow-md": "0 1px 2px #0003", "--made-up": "x" } } },
  { theme: "light", styles: { variables: {} } },
  { theme: "light", styles: {} },
  { theme: "light" },
  { theme: "pip", styles: { variables: {} } },
  { styles: { variables: { "--color-text-primary": "#111" } } },
  { theme: "dark", styles: { variables: { "--color-text-primary": 7, "--font-mono": ["x"], "--color-border-primary": "  #333  " } } },
  null,
  "dark",
  [],
];
for (const context of contexts) add("theme_from_mcp_apps", { context }, ({ context: c }) => mcp.hostThemeFromMcpAppsContext(c));

// The theme survives the trip for every token that has a variable.
add("theme_round_trip", { theme: themes[2] }, ({ theme }) => mcp.hostThemeFromMcpAppsContext(mcp.hostThemeToMcpAppsContext(theme)));

// placement <-> display mode
for (const placement of ["inline", "panel", "document", "side", "", null, undefined, 1])
  for (const panelAs of ["fullscreen", "pip"]) add("placement_to_display_mode", { placement, panelAs }, ({ placement: p, panelAs: a }) => mcp.placementToDisplayMode(p, a));
for (const mode of ["inline", "fullscreen", "pip", "window", "", null, undefined, 1]) add("display_mode_to_placement", { mode }, ({ mode: m }) => mcp.displayModeToPlacement(m));

// card response -> elicitation action
for (const value of ["submit", "select", "confirm", "cancel", "dismiss", "decline", "accept", "Submit", "", null, undefined, 1]) add("elicitation_action", { value }, ({ value: v }) => mcp.cardResponseToElicitationAction(v));

add("style_variables", {}, () => ({ count: mcp.MCP_APPS_STYLE_VARIABLES.length, unique: new Set(mcp.MCP_APPS_STYLE_VARIABLES).size, variables: [...mcp.MCP_APPS_STYLE_VARIABLES] }));

writeGolden(
  fileURLToPath(new URL("../conformance/interop-mcp.v0.json", import.meta.url)),
  {
    version: 0,
    status: "draft",
    note: "DRAFT, not stable and not part of protocol.v1.json. Generated by scripts/export-interop-mcp.mjs from implementations/typescript/src/interop/mcp.ts. Case shape as in the `mapping` section of protocol.v1.json: `fn` names the function, the other keys are its inputs, `expect` is `{ value }` or `{ error }` (a RangeError message). Not checked against an MCP SDK: see docs/INTEROP.md for the source of each rule. `undefined` inputs are written as an absent key.",
    generated_with: { mcp: "2026-07-28", mcp_apps: "2026-01-26" },
    interop_mcp: cases,
  },
  "export-interop-mcp.mjs",
);
