#!/bin/bash
# update-submodules.sh — Pull latest from upstream for all submodules
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

changed=0

echo "Updating submodules..."
echo

# Get list of submodule paths from git config
for path in $(git config --file .gitmodules --get-regexp 'path' | awk '{print $2}'); do
  branch=$(git config --file .gitmodules --get "submodule.$path.branch" 2>/dev/null || echo "main")

  echo -n "  $path ... "

  if ! cd "$path" 2>/dev/null; then
    echo -e "${RED}not initialized${NC}"
    cd - > /dev/null
    continue
  fi

  # Fetch latest
  if ! git pull origin "$branch" 2>/dev/null; then
    echo -e "${RED}fetch failed${NC}"
    cd - > /dev/null
    continue
  fi

  # Check if commit changed (skip if no previous commit)
  if git rev-parse --verify HEAD@{1} >/dev/null 2>&1; then
    if git diff --quiet HEAD@{1}..HEAD 2>/dev/null; then
      echo -e "${YELLOW}up to date${NC}"
    else
      echo -e "${GREEN}updated${NC}"
      changed=1
    fi
  else
    echo -e "${YELLOW}up to date${NC}"
  fi

  cd - > /dev/null
done

if [ "$changed" -eq 1 ]; then
  echo
  echo "Some submodules were updated. Commit the changes:"
  echo "  git add .ext/"
  echo "  git commit -m \"chore: update submodules\""
else
  echo
  echo "All submodules up to date."
fi