#!/usr/bin/env bash
# One-time npm setup for the Super libs (34 packages, scope @supersolutions).
#
#   bootstrap-npm.sh placeholders [repo]   publish an empty 0.0.0 placeholder for every package
#                                          that is not on npm yet (tag "placeholder", so `latest`
#                                          stays free for the real 0.1.0). npm only lets you
#                                          configure trust on a package that exists.
#   bootstrap-npm.sh trust <repo>          add the GitHub Actions trusted publisher to each
#                                          package of that repo (npm >= 11.15, account 2FA)
#   bootstrap-npm.sh list [repo]           print the table this script uses
#
# repo = super-protocol | super-chat | super-router | super-editor | super-chart | super-plot (default: all, for
# `placeholders` and `list`; `trust` needs one repo, because a new trust expires after 2 days
# without a successful publish: run it the day you release that repo).
#
#   OWNER=supersolutions   GitHub org in the trust entry (default Super-Solution; use the new name
#                          if the org was renamed first)
#   DRY_RUN=1              no change on npm: `npm publish --dry-run` / `npm trust --dry-run`
#
# Run it on your own machine, logged in with `npm login` (the account needs write access to the
# @supersolutions scope and 2FA on; a bypass-2FA token cannot configure trust). It publishes nothing
# but placeholders and never touches existing versions.
set -euo pipefail
OWNER="${OWNER:-Super-Solution}"
DRY_RUN="${DRY_RUN:-0}"

# repo|workflow file|package|license
TABLE='
super-protocol|npm-publish.yml|@supersolutions/super-protocol|Apache-2.0
super-chat|npm-publish.yml|@supersolutions/super-chat-core|Apache-2.0
super-chat|npm-publish.yml|@supersolutions/super-chat-client|Apache-2.0
super-chat|npm-publish.yml|@supersolutions/super-chat-server|Apache-2.0
super-chat|npm-publish.yml|@supersolutions/super-chat-ui-core|Apache-2.0
super-chat|npm-publish.yml|@supersolutions/super-chat-router|Apache-2.0
super-chat|npm-publish.yml|@supersolutions/super-chat-react|Apache-2.0
super-chat|npm-publish.yml|@supersolutions/super-chat-ui|Apache-2.0
super-chat|npm-publish.yml|@supersolutions/super-chat-plugin|Apache-2.0
super-router|npm-publish.yml|@supersolutions/super-router-contracts|Apache-2.0
super-router|npm-publish.yml|@supersolutions/super-router-core|Apache-2.0
super-router|npm-publish.yml|@supersolutions/super-router-fetch-adapters|Apache-2.0
super-router|npm-publish.yml|@supersolutions/super-router-payments|Apache-2.0
super-router|npm-publish.yml|@supersolutions/super-router-provider-anthropic|Apache-2.0
super-router|npm-publish.yml|@supersolutions/super-router-provider-openai|Apache-2.0
super-router|npm-publish.yml|@supersolutions/super-router-sdk|Apache-2.0
super-router|npm-publish.yml|@supersolutions/super-router-storage-memory|Apache-2.0
super-router|npm-publish.yml|@supersolutions/super-router-storage-postgres|Apache-2.0
super-router|npm-publish.yml|@supersolutions/super-router-billing-presets|Apache-2.0
super-router|npm-publish.yml|@supersolutions/super-router-server|Apache-2.0
super-router|npm-publish.yml|@supersolutions/super-router-worker|Apache-2.0
super-router|npm-publish.yml|@supersolutions/super-router-ui|Apache-2.0
super-editor|publish.yml|@supersolutions/super-editor-core|GPL-3.0-or-later
super-editor|publish.yml|@supersolutions/super-editor-opc|GPL-3.0-or-later
super-editor|publish.yml|@supersolutions/super-editor-docx|GPL-3.0-or-later
super-editor|publish.yml|@supersolutions/super-editor-ui|GPL-3.0-or-later
super-editor|publish.yml|@supersolutions/super-editor-react|GPL-3.0-or-later
super-editor|publish.yml|@supersolutions/super-editor-element|GPL-3.0-or-later
super-editor|publish.yml|@supersolutions/super-editor-chat-plugin|GPL-3.0-or-later
super-editor|publish.yml|@supersolutions/super-editor-api|AGPL-3.0-or-later
super-editor|publish.yml|@supersolutions/super-editor-mcp|AGPL-3.0-or-later
super-editor|publish.yml|@supersolutions/super-editor-cli|GPL-3.0-or-later
super-chart|npm-publish.yml|@supersolutions/super-chart-core|GPL-3.0-or-later
super-chart|npm-publish.yml|@supersolutions/super-chart-superscript|GPL-3.0-or-later
super-chart|npm-publish.yml|@supersolutions/super-chart-web|GPL-3.0-or-later
super-chart|npm-publish.yml|@supersolutions/super-chart-chat-plugin|GPL-3.0-or-later
super-plot|npm-publish.yml|@supersolutions/super-plot-core|Apache-2.0
super-plot|npm-publish.yml|@supersolutions/super-plot-web|Apache-2.0
super-plot|npm-publish.yml|@supersolutions/super-plot-react|Apache-2.0
super-plot|npm-publish.yml|@supersolutions/super-plot-chat-plugin|Apache-2.0
'

mode="${1:-}"; want="${2:-}"
rows() { printf '%s\n' "$TABLE" | awk -F'|' -v r="$want" 'NF==4 && (r=="" || $1==r)'; }

case "$mode" in
  list) rows ;;
  placeholders)
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    rows | while IFS='|' read -r repo _wf name license; do
      if npm view "$name" name >/dev/null 2>&1; then echo "exists   $name"; continue; fi
      dir="$tmp/${name//\//__}"; mkdir -p "$dir"
      printf '# %s\n\nPlaceholder. Releases are published from https://github.com/%s/%s by GitHub Actions.\n' "$name" "$OWNER" "$repo" > "$dir/README.md"
      node -e '
        const [name, license, owner, repo] = process.argv.slice(1);
        process.stdout.write(JSON.stringify({ name, version: "0.0.0", description: "Placeholder; real releases come from GitHub Actions.", license,
          repository: { type: "git", url: `git+https://github.com/${owner}/${repo}.git` }, files: ["README.md"], publishConfig: { access: "public" } }, null, 2));
      ' "$name" "$license" "$OWNER" "$repo" > "$dir/package.json"
      flags=(--access public --tag placeholder); [ "$DRY_RUN" = 1 ] && flags+=(--dry-run)
      echo "publish  $name 0.0.0 (placeholder)"
      (cd "$dir" && npm publish "${flags[@]}")
    done ;;
  trust)
    [ -n "$want" ] || { echo "usage: $0 trust <repo>" >&2; exit 2; }
    rows | while IFS='|' read -r repo wf name _license; do
      flags=(--file "$wf" --repo "$OWNER/$repo" --allow-publish --yes); [ "$DRY_RUN" = 1 ] && flags+=(--dry-run)
      echo "trust    $name  <-  $OWNER/$repo  $wf"
      npm trust github "$name" "${flags[@]}"
    done ;;
  *) sed -n '2,22p' "$0"; exit 2 ;;
esac
