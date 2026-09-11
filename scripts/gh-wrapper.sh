#!/bin/bash
# Policy-gated gh. Agents are told to call this, never `gh` directly.
#
#   scripts/gh-wrapper.sh <project_id> pr create ...
#   scripts/gh-wrapper.sh <project_id> issue comment ...
#
# Only the subcommands listed in the case statement below can be run at all.
# Everything else, `gh api` included, exits 3 without reaching the policy
# layer. The subcommand is read from the first two tokens that are not flags,
# so moving a flag in front of it (`-R x/y pr merge 1`) does not get past the
# allowlist either. Put the subcommand first, then the flags.
#
# Exit 2 means the action is parked on an approval card. Exit 3 means the
# wrapper or the policy refuses it. Anything else is gh's own exit code.
set -euo pipefail

PROJECT_ID="${1:-default}"
shift || true

MERGE_REFUSAL="gh pr merge is never automated; merge from the dashboard or the Telegram card"
ALLOWED_LIST="issue comment, issue close, issue view, issue list, pr create, pr comment, pr diff, pr view, pr list, run list, run view"

# The subcommand is the first two non-flag tokens. A flag value that sits
# between them (`pr -R x/y merge`) shifts the pair, so the result is not on the
# allowlist and the call is refused rather than silently reclassified.
SUB=""
SUB2=""
for arg in "$@"; do
  case "$arg" in -*) continue ;; esac
  if [ -z "$SUB" ]; then
    SUB="$arg"
  else
    SUB2="$arg"
    break
  fi
done
SUBCMD="$SUB $SUB2"

# Merge is never automated (spec 6.1), in any shape. Compared as an exact
# pair, not a substring match: a stray token that merely contains the word
# merge (a repo argument, a flag value shifted in front of the subcommand)
# must fall through to the allowlist message below, not this one. The REST
# route (`api -X PUT repos/x/y/pulls/1/merge`) needs no case of its own, since
# `api` is not on the allowlist and is refused below.
if [ "$SUB" = "pr" ] && [ "$SUB2" = "merge" ]; then
  echo "$MERGE_REFUSAL" >&2
  exit 3
fi

if [ -z "$SUB" ]; then
  echo "gh: no subcommand given; allowed: $ALLOWED_LIST" >&2
  exit 3
fi

case "$SUBCMD" in
  # Read arm: nothing to approve, so no policy call.
  "issue view"|"issue list"|"pr diff"|"pr view"|"pr list"|"run list"|"run view")
    exec gh "$@"
    ;;
  "pr create") CLASS="code.pr" ;;
  "issue comment"|"pr comment"|"issue close") CLASS="github.comment" ;;
  *)
    echo "gh $SUBCMD is not allowed through the wrapper; allowed: $ALLOWED_LIST" >&2
    exit 3
    ;;
esac

# Test seam. Tests assert the class the wrapper picked without the policy layer
# opening a real approval card in store/claudepaw.db.
if [ "${GH_WRAPPER_DRY_RUN:-}" = "1" ]; then
  echo "class=$CLASS"
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
code=0
node "$ROOT/dist/policy-cli.js" check "$PROJECT_ID" "$CLASS" gh-wrapper || code=$?
if [ "$code" -ne 0 ]; then
  echo "gh blocked by action policy ($CLASS), decision code $code" >&2
  exit "$code"
fi

exec gh "$@"
