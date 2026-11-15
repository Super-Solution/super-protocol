#!/usr/bin/env bash
# Local gate: every implementation against the shared conformance data. Hosted CI is not used.
# Python checks run only when `python3 -m venv` works; set SKIP_PYTHON=1 to skip them.
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

echo "== go"
(cd go && go vet ./... && test -z "$(gofmt -l .)" && go test ./...)

if [ "${SKIP_PYTHON:-0}" != "1" ]; then
  echo "== python"
  venv="$(mktemp -d)"
  python3 -m venv "$venv"
  "$venv/bin/pip" install -q -e "python[dev]"
  (cd python && "$venv/bin/pytest" -q && "$venv/bin/ruff" check . && "$venv/bin/mypy")
fi
echo "all checks passed"
