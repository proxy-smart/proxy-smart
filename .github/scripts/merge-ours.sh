#!/usr/bin/env bash
# SPDX-FileCopyrightText: Max Health Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

# Merges <ref> into the checked-out branch, keeping our side of every conflict.
# Usage: merge-ours.sh <ref> <commit message>

set -euo pipefail

REF="${1:?usage: merge-ours.sh <ref> <message>}"
MESSAGE="${2:?usage: merge-ours.sh <ref> <message>}"

if git merge "$REF" -X ours --no-edit -m "$MESSAGE"; then
  exit 0
fi

echo "Conflicts remain after -X ours, resolving them as ours"
CONFLICTED=$(git diff --name-only --diff-filter=U)
if [ -n "$CONFLICTED" ]; then
  echo "$CONFLICTED" | xargs git checkout --ours
  git add -A
fi
git commit --no-edit -m "$MESSAGE" || true
