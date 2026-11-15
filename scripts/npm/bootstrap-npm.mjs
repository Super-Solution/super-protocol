#!/usr/bin/env node
// Cross-platform (Windows / macOS / Linux) version of bootstrap-npm.sh. Needs only Node + npm.
//
//   node bootstrap-npm.mjs list [repo]
//   node bootstrap-npm.mjs placeholders [repo]   publish an empty 0.0.0 placeholder (tag "placeholder")
//                                                for every package not on npm yet
//   node bootstrap-npm.mjs trust <repo>          add the GitHub Actions trusted publisher to each package
//                                                of that repo (npm >= 11.15, account 2FA on)
//
// repo = super-protocol | super-chat | super-router | super-editor | super-chart
// Env: OWNER (default Super-Solution), DRY_RUN=1 (npm --dry-run; PowerShell: $env:DRY_RUN=1)
// Run `npm login` first. It publishes only placeholders and never touches existing versions.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWNER = process.env.OWNER || "Super-Solution";
const DRY = process.env.DRY_RUN === "1";
// [repo, workflow file, package, license]
const TABLE = [
  ["super-protocol", "npm-publish.yml", "@supersolutions/super-protocol", "Apache-2.0"],
  ["super-chat", "npm-publish.yml", "@supersolutions/super-chat-core", "Apache-2.0"],
  ["super-chat", "npm-publish.yml", "@supersolutions/super-chat-client", "Apache-2.0"],
  ["super-chat", "npm-publish.yml", "@supersolutions/super-chat-server", "Apache-2.0"],
  ["super-chat", "npm-publish.yml", "@supersolutions/super-chat-ui-core", "Apache-2.0"],
  ["super-chat", "npm-publish.yml", "@supersolutions/super-chat-router", "Apache-2.0"],
  ["super-chat", "npm-publish.yml", "@supersolutions/super-chat-react", "Apache-2.0"],
  ["super-chat", "npm-publish.yml", "@supersolutions/super-chat-ui", "Apache-2.0"],
  ["super-chat", "npm-publish.yml", "@supersolutions/super-chat-plugin", "Apache-2.0"],
  ["super-router", "npm-publish.yml", "@supersolutions/super-router-contracts", "Apache-2.0"],
  ["super-router", "npm-publish.yml", "@supersolutions/super-router-core", "Apache-2.0"],
  ["super-router", "npm-publish.yml", "@supersolutions/super-router-fetch-adapters", "Apache-2.0"],
  ["super-router", "npm-publish.yml", "@supersolutions/super-router-payments", "Apache-2.0"],
  ["super-router", "npm-publish.yml", "@supersolutions/super-router-provider-anthropic", "Apache-2.0"],
  ["super-router", "npm-publish.yml", "@supersolutions/super-router-provider-openai", "Apache-2.0"],
  ["super-router", "npm-publish.yml", "@supersolutions/super-router-sdk", "Apache-2.0"],
  ["super-router", "npm-publish.yml", "@supersolutions/super-router-storage-memory", "Apache-2.0"],
  ["super-router", "npm-publish.yml", "@supersolutions/super-router-storage-postgres", "Apache-2.0"],
  ["super-router", "npm-publish.yml", "@supersolutions/super-router-billing-presets", "Apache-2.0"],
  ["super-router", "npm-publish.yml", "@supersolutions/super-router-server", "Apache-2.0"],
  ["super-router", "npm-publish.yml", "@supersolutions/super-router-worker", "Apache-2.0"],
  ["super-router", "npm-publish.yml", "@supersolutions/super-router-ui", "Apache-2.0"],
  ["super-editor", "publish.yml", "@supersolutions/super-editor-core", "GPL-3.0-or-later"],
  ["super-editor", "publish.yml", "@supersolutions/super-editor-ui", "GPL-3.0-or-later"],
  ["super-editor", "publish.yml", "@supersolutions/super-editor-react", "GPL-3.0-or-later"],
  ["super-editor", "publish.yml", "@supersolutions/super-editor-element", "GPL-3.0-or-later"],
  ["super-editor", "publish.yml", "@supersolutions/super-editor-chat-plugin", "GPL-3.0-or-later"],
  ["super-editor", "publish.yml", "@supersolutions/super-editor-api", "AGPL-3.0-or-later"],
  ["super-editor", "publish.yml", "@supersolutions/super-editor-mcp", "AGPL-3.0-or-later"],
  ["super-editor", "publish.yml", "@supersolutions/super-editor-cli", "GPL-3.0-or-later"],
  ["super-chart", "npm-publish.yml", "@supersolutions/super-chart-core", "GPL-3.0-or-later"],
  ["super-chart", "npm-publish.yml", "@supersolutions/super-chart-superscript", "GPL-3.0-or-later"],
  ["super-chart", "npm-publish.yml", "@supersolutions/super-chart-web", "GPL-3.0-or-later"],
  ["super-chart", "npm-publish.yml", "@supersolutions/super-chart-chat-plugin", "GPL-3.0-or-later"]
];

const [mode, want = ""] = process.argv.slice(2);
const rows = TABLE.filter((r) => !want || r[0] === want);
if (want && !rows.length) { console.error(`unknown repo: ${want}`); process.exit(2); }
// npm is npm.cmd on Windows, which needs a shell; arguments here contain no spaces.
const npm = (args, opts = {}) => spawnSync("npm", args, { shell: process.platform === "win32", stdio: "inherit", ...opts });

if (mode === "list") {
  for (const r of rows) console.log(r.join("|"));
} else if (mode === "placeholders") {
  const tmp = mkdtempSync(join(tmpdir(), "supersolutions-"));
  try {
    for (const [repo, , name, license] of rows) {
      if (npm(["view", name, "name"], { stdio: "ignore" }).status === 0) { console.log(`exists   ${name}`); continue; }
      const dir = join(tmp, name.replace("/", "__")); mkdirSync(dir);
      writeFileSync(join(dir, "README.md"), `# ${name}\n\nPlaceholder. Releases are published from https://github.com/${OWNER}/${repo} by GitHub Actions.\n`);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", description: "Placeholder; real releases come from GitHub Actions.", license,
        repository: { type: "git", url: `git+https://github.com/${OWNER}/${repo}.git` }, files: ["README.md"], publishConfig: { access: "public" } }, null, 2));
      console.log(`publish  ${name} 0.0.0 (placeholder)`);
      const r = npm(["publish", "--access", "public", "--tag", "placeholder", ...(DRY ? ["--dry-run"] : [])], { cwd: dir });
      if (r.status !== 0) { console.error(`FAILED ${name} (stopping)`); process.exitCode = 1; break; }
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
} else if (mode === "trust") {
  if (!want) { console.error("usage: node bootstrap-npm.mjs trust <repo>"); process.exit(2); }
  for (const [repo, wf, name] of rows) {
    console.log(`trust    ${name}  <-  ${OWNER}/${repo}  ${wf}`);
    const r = npm(["trust", "github", name, "--file", wf, "--repo", `${OWNER}/${repo}`, "--allow-publish", "--yes", ...(DRY ? ["--dry-run"] : [])]);
    if (r.status !== 0) { console.error(`FAILED ${name} (stopping)`); process.exitCode = 1; break; }
  }
} else {
  console.error("usage: node bootstrap-npm.mjs list|placeholders [repo] | trust <repo>"); process.exit(2);
}
