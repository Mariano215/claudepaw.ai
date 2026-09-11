#!/bin/bash
# Policy-gated git push. Agents are told to call this, never `git push`.
#
#   scripts/git-push-wrapper.sh <project_id> [git push arguments]
#
# Exit 2 means the action is parked on an approval card. Exit 3 means the
# policy refuses it. Anything else is git's own exit code.
set -euo pipefail

PROJECT_ID="${1:-default}"
shift || true

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
code=0
node "$ROOT/dist/policy-cli.js" check "$PROJECT_ID" code.pr git-push-wrapper || code=$?
if [ "$code" -ne 0 ]; then
  echo "git push blocked by action policy (code.pr), decision code $code" >&2
  exit "$code"
fi

exec git push "$@"
