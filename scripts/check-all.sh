#!/usr/bin/env bash
# Local gate: every implementation against the shared conformance data. Hosted CI is not used.
# Python checks run only when `python3 -m venv` works; set SKIP_PYTHON=1 to skip them, SKIP_RUST=1 to skip the Rust crate.
# Set SUPER_CHAT_DIR to a Super Chat checkout (core built) to also check conformance/tool-repair.v0.json against its repair.ts
# and conformance/agent-loop-replay.v0.json against what its runAgent does.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== typescript"
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test

echo "== conformance data is reproducible"
before="$(mktemp -d)"
cp conformance/protocol.v1.json conformance/index.json "$before/"
pnpm conformance:export >/dev/null
for f in protocol.v1.json index.json; do
  if ! cmp -s "conformance/$f" "$before/$f"; then
    echo "conformance/$f drifted from the TypeScript reference; review the diff" >&2
    exit 1
  fi
done

echo "== agent loop cases are reproducible from their source"
node scripts/export-agent-loop.mjs --check
node scripts/export-index.mjs --check
echo "== json schemas are reproducible from the package"
node scripts/export-schemas.mjs --check
echo "== draft interop golden files are reproducible (and valid for the real ai and @ag-ui/core packages)"
node scripts/export-interop-ag-ui.mjs --check
node scripts/export-interop-ai-sdk.mjs --check
# The repair cases are generated from Super Chat's repair.ts: checked only when a Super Chat checkout is known.
if [ -n "${SUPER_CHAT_DIR:-}" ]; then
  node scripts/export-tool-repair.mjs --check
  node scripts/export-agent-replay.mjs --check
fi

echo "== go"
(cd implementations/go && go vet ./... && test -z "$(gofmt -l .)" && go test ./...)
echo "== go, through the language-neutral runner"
node scripts/conformance-run-selftest.mjs
node scripts/conformance-run.mjs --require-all --command "cd implementations/go && go run ./conformance-shim"

if [ "${SKIP_RUST:-0}" != "1" ]; then
  echo "== rust (agent loop)"
  (cd implementations/rust-agent-loop && cargo fmt --check && cargo clippy --all-targets --features http -- -D warnings && cargo test --features http)
fi

if [ "${SKIP_PYTHON:-0}" != "1" ]; then
  echo "== python"
  venv="$(mktemp -d)"
  python3 -m venv "$venv"
  "$venv/bin/pip" install -q -e "implementations/python[dev]"
  (cd implementations/python && "$venv/bin/pytest" -q && "$venv/bin/ruff" check . && "$venv/bin/mypy")
  echo "== python, through the language-neutral runner"
  node scripts/conformance-run.mjs --require-all --command "$venv/bin/python implementations/python/conformance-shim/shim.py"
fi
echo "all checks passed"
