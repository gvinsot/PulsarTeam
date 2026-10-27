#!/usr/bin/env bash
# Run the CI gates locally, the same steps as .github/workflows/ci.yml.
#
#   scripts/check.sh                   # api frontend desktop
#   scripts/check.sh api frontend      # only these
#   scripts/check.sh --fix frontend    # prettier --write + eslint --fix first
#
# Exit code is non-zero if any gate of any project failed. Every project still
# runs, so one red project does not hide the state of the others (same as CI's
# fail-fast: false).
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fix=0
projects=()
for arg in "$@"; do
  case "$arg" in
    --fix) fix=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) projects+=("$arg") ;;
  esac
done
[ ${#projects[@]} -eq 0 ] && projects=(api frontend desktop)

failed=()
run() { # project, gate name, command...
  local project=$1 name=$2; shift 2
  local log; log=$(mktemp)
  if "$@" >"$log" 2>&1; then
    printf '  ✓ %s\n' "$name"
  else
    printf '  ✗ %s\n' "$name"; tail -n 40 "$log" | sed 's/^/      /'
    failed+=("$project:$name")
  fi
  rm -f "$log"
}

has_script() { node -e "process.exit(require('./package.json').scripts?.['$1'] ? 0 : 1)"; }

for project in "${projects[@]}"; do
  dir="$root/$project"
  if [ ! -f "$dir/package.json" ]; then
    echo "skip $project: no package.json (python services: python3 -m pytest -q tests)"
    continue
  fi
  echo "── $project"
  cd "$dir" || exit 1
  if [ ! -d node_modules ]; then
    run "$project" "npm ci" npm ci --no-audit --no-fund
    if [ "${failed[*]: -1}" = "$project:npm ci" ] 2>/dev/null; then
      rm -rf node_modules # a partial install would make the next run skip npm ci
      echo "  … skipping $project gates: dependencies did not install"
      continue
    fi
  fi
  if [ $fix -eq 1 ]; then
    has_script format && run "$project" "format (write)" npm run -s format
    has_script lint:fix && run "$project" "lint:fix" npm run -s lint:fix
  fi
  run "$project" typecheck npm run -s typecheck
  has_script lint && run "$project" lint npm run -s lint
  run "$project" test npm test
  run "$project" build npm run -s build
  has_script format:check && run "$project" format:check npm run -s format:check
done

if [ ${#failed[@]} -gt 0 ]; then
  echo; echo "FAILED: ${failed[*]}"; exit 1
fi
echo; echo "all gates green"
