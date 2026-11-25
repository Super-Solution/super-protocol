#!/usr/bin/env bash
# Local gate: every implementation against the shared conformance data. Hosted CI is not used.
# Python checks run only when `python3 -m venv` works; set SKIP_PYTHON=1 to skip them, SKIP_RUST=1 to skip the Rust crate.
# Set SUPER_CHAT_DIR to a Super Chat checkout to also check conformance/tool-repair.v0.json against its repair.ts.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== typescript"
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test

echo "== conformance data is reproducible"
cp conformance/protocol.v1.json /tmp/protocol.v1.json.before
pnpm conformance:export >/dev/null
if ! cmp -s conformance/protocol.v1.json /tmp/protocol.v1.json.before; then
  echo "conformance/protocol.v1.json drifted from the TypeScript reference; review the diff" >&2
  exit 1
fi

echo "== agent loop cases are reproducible from their source"
node scripts/export-agent-loop.mjs --check
# The repair cases are generated from Super Chat's repair.ts: checked only when a Super Chat checkout is known.
if [ -n "${SUPER_CHAT_DIR:-}" ]; then
  node scripts/export-tool-repair.mjs --check
fi

echo "== go"
(cd implementations/go && go vet ./... && test -z "$(gofmt -l .)" && go test ./...)

if [ "${SKIP_RUST:-0}" != "1" ]; then
  echo "== rust (agent loop)"
  (cd implementations/rust-agent-loop && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)
fi

if [ "${SKIP_PYTHON:-0}" != "1" ]; then
  echo "== python"
  venv="$(mktemp -d)"
  python3 -m venv "$venv"
  "$venv/bin/pip" install -q -e "implementations/python[dev]"
  (cd implementations/python && "$venv/bin/pytest" -q && "$venv/bin/ruff" check . && "$venv/bin/mypy")
fi
echo "all checks passed"
