#!/usr/bin/env bash
# scripts/check-scaffold.sh — verifies the repo skeleton is consistent.
# Run via: bash scripts/check-scaffold.sh   (from anywhere)
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

echo "== git hygiene =="
tracked_local=$(git ls-files | grep -c 'CLAUDE.local' || true)
[ "$tracked_local" = "0" ] && echo "OK   CLAUDE.local.md untracked" || { echo "MISS CLAUDE.local.md is tracked!"; fail=1; }
git check-ignore -q CLAUDE.local.md && echo "OK   CLAUDE.local.md gitignored" || { echo "MISS not gitignored"; fail=1; }

echo "== docs pointer drift (targets must exist) =="
for f in docs/architecture/overview.md docs/features/rules-kernel.md docs/features/multiplayer.md \
         docs/BUSINESS-CONTEXT.md docs/TROUBLESHOOTING.md docs/STATE-SNAPSHOT.md \
         docs/plans/README.md docs/plans/2026-09-08-rules-kernel.md \
         docs/recaps/README.md CLAUDE.md AGENTS.md \
         TECHNICAL-DOCUMENTATION.md FUNCTIONAL-SPECIFICATIONS.md README.md LICENSE \
         package.json tsconfig.base.json .npmrc .gitignore \
         packages/shared/package.json packages/shared/tsconfig.json \
         packages/shared/src/index.ts packages/shared/src/index.test.ts; do
  if [ -e "$f" ]; then echo "OK   $f"; else echo "MISS $f"; fail=1; fi
done

echo "== gates =="
node_modules/.bin/tsc --noEmit -p packages/shared/tsconfig.json && echo "OK   typecheck" || { echo "MISS typecheck"; fail=1; }
(cd packages/shared && CI=true ../../node_modules/.bin/vitest run 2>&1 | grep -E "Tests  " ) && true

if grep -RnE "^[[:space:]]*(TODO|FIXME|XXX)[[:space:]:]" packages/shared/src docs 2>/dev/null; then
  echo "MISS scaffold TODOs present (expected NONE)"; fail=1
else
  echo "OK   zero TODO/FIXME markers"
fi

[ $fail = 0 ] && echo "SCAFFOLD CHECK: PASS" || echo "SCAFFOLD CHECK: FAIL"
exit $fail
