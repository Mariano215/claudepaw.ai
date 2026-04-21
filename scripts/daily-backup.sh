#!/bin/bash

# Daily backup script for active projects
# Runs via ClaudePaw scheduler

REPOS=(
  "$HOME/claudepaw"
  "/path/to/project"
  "/path/to/project"
  "/path/to/project"
)

total=0
changed=0
errors=0
error_log=""

for repo in "${REPOS[@]}"; do
  if [[ ! -d "$repo/.git" ]]; then
    continue
  fi

  total=$((total + 1))
  cd "$repo" || continue

  # Check for uncommitted changes
  if [[ -n $(git status --porcelain) ]]; then
    changed=$((changed + 1))

    # Commit changes
    date_str=$(date +"%Y-%m-%d %H:%M")
    git add -A
    git commit -m "auto-backup: $date_str" > /dev/null 2>&1

    # Push to origin
    if ! git push origin 2>&1; then
      errors=$((errors + 1))
      repo_name=$(basename "$repo")
      error_log="${error_log}${repo_name}: push failed\n"
    fi
  fi
done

# Report
if [[ $errors -gt 0 ]]; then
  echo "Backup complete: $total repos checked, $changed had changes, $errors errors"
  echo -e "\nErrors:\n$error_log"
  exit 1
else
  echo "Backup complete: $total repos checked, $changed had changes, $errors errors"
  exit 0
fi
