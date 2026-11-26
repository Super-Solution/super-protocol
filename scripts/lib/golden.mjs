// Shared by scripts/export-interop-*.mjs: where the dev dependencies live, how scenario options become adapter options,
// and how a golden file is written (one case per line) or checked (`--check`).
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const packageDir = new URL("../../implementations/typescript/", import.meta.url);

/** Imports a devDependency of the TypeScript package (`ai`, `@ag-ui/core`, ...) the way that package would. */
export async function importDev(specifier) {
  const require = createRequire(new URL("package.json", packageDir));
  const mod = await import(pathToFileURL(require.resolve(specifier)).href);
  return mod.default && Object.keys(mod).length === 1 ? mod.default : mod;
}

export const devVersion = (name) => JSON.parse(readFileSync(createRequire(new URL("package.json", packageDir)).resolve(`${name}/package.json`), "utf8")).version;

/** The options a scenario can carry in JSON, as the options an adapter takes. */
export function adapterOptions(scenario = {}, losses) {
  const options = { onLoss: (loss) => losses.push(loss) };
  for (const key of ["threadId", "runId"]) if (scenario[key] !== undefined) options[key] = scenario[key];
  if (scenario.confirmKinds !== undefined) {
    options.isConfirm = (card) => scenario.confirmKinds.includes(card.spec.kind);
    options.interruptReason = (card) => (scenario.confirmKinds.includes(card.spec.kind) ? "confirmation" : "input_required");
  }
  if (scenario.now !== undefined) options.now = () => scenario.now;
  return options;
}

const line = (value) => JSON.stringify(value);

/** One top-level key per line for scalars, one case per line for the lists. */
function format(file) {
  const parts = Object.entries(file).map(([key, value]) => (Array.isArray(value) ? ` ${line(key)}: [\n${value.map((c) => `  ${line(c)}`).join(",\n")}\n ]` : ` ${line(key)}: ${line(value)}`));
  return `{\n${parts.join(",\n")}\n}\n`;
}

export function writeGolden(path, file, label) {
  const text = format(file);
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      /* missing */
    }
    if (current !== text) {
      console.error(`${label} is not what its generator writes; run \`node scripts/${label}\` and review the diff`);
      process.exit(1);
    }
    console.log(`${label}: ${path.split("/").pop()} matches`);
  } else {
    writeFileSync(path, text);
    const counts = Object.entries(file).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${v.length} ${k}`);
    console.log(`wrote ${path} (${counts.join(", ")})`);
  }
}
