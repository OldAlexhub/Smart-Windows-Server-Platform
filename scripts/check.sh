#!/usr/bin/env sh
# Usage: scripts/check.sh <item-id> "<verification note>"
# Marks a checklist item (or indented sub-item) done and appends its verification note.
set -e
id="$1"; note="$2"
f="$(dirname "$0")/../checklist.md"
sed -i "s/^\( *\)- \[[ ~]\] ${id} /\1- [x] ${id} /" "$f"
grep -Eq "^ *- \[x\] ${id} " "$f" || { echo "item ${id} not found"; exit 1; }
echo "- ${id} — ${note}" >> "$f"
