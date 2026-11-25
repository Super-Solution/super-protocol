// The license boundary: this package is Apache-2.0 and is imported by Apache hosts (super-chat)
// and by GPL/AGPL plugins alike. It must stay dependency-free and self-contained.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const isSource = (f: string) => f.endsWith(".ts") && !f.endsWith(".test.ts");
// The draft interop modules live in src/interop/ and are held to the same rule.
const sources = [
  ...readdirSync(new URL(".", import.meta.url)).filter(isSource),
  ...readdirSync(new URL("interop/", import.meta.url)).filter(isSource).map((f) => `interop/${f}`),
];

describe("license boundary", () => {
  it("is Apache-2.0", () => expect(pkg.license).toBe("Apache-2.0"));
  it("has no runtime dependencies", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });
  it("imports nothing but its own files", () => {
    expect(sources.length).toBeGreaterThan(0);
    for (const f of sources) {
      const text = readFileSync(new URL(f, import.meta.url), "utf8");
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        expect(m[1], `${f} imports ${m[1]}`).toMatch(/^\.\.?\//);
      }
    }
  });
  it("builds every subpath the package exports", () => {
    const config = readFileSync(new URL("../tsup.config.ts", import.meta.url), "utf8");
    const entries = [...config.matchAll(/(?:(\w+)|"([\w/-]+)"):\s*"src\/[^"]+"/g)].map((m) => m[1] ?? m[2]);
    for (const [subpath, target] of Object.entries<{ import: string }>(pkg.exports)) {
      const name = /^\.\/dist\/([\w/-]+)\.js$/.exec(target.import)?.[1];
      expect(entries, `${subpath} -> ${target.import}`).toContain(name);
    }
  });
});
