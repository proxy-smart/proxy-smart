#!/bin/sh
# SPDX-FileCopyrightText: Max Health Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
#
# Workspace install for CI and Docker. Cold installs on GitHub runners wedge on
# keep-alive sockets with no read timeout, so bound each attempt and retry.
# Extra args pass through to `bun install`.
set -e

: "${BUN_INSTALL_ATTEMPTS:=3}"
: "${BUN_INSTALL_TIMEOUT:=360}"

# @max-health-inc is a different org, so the automatic GITHUB_TOKEN is refused there —
# it must be the PAT. Checked up front: bun stalls on this instead of erroring.
if [ -z "${GH_PACKAGES_TOKEN:-}" ]; then
  echo "ERROR: GH_PACKAGES_TOKEN is empty." >&2
  echo "  CI: the reusable workflow chain needs 'secrets: inherit' all the way down." >&2
  echo "  Local: export GH_PACKAGES_TOKEN=\$(gh auth token)" >&2
  exit 1
fi

attempt=1
while [ "$attempt" -le "$BUN_INSTALL_ATTEMPTS" ]; do
  echo "::group::bun install attempt $attempt"
  # Last attempt is verbose so a persistent failure names the request that hung.
  if [ "$attempt" -eq "$BUN_INSTALL_ATTEMPTS" ]; then
    set -- "$@" --verbose
  fi
  if timeout "$BUN_INSTALL_TIMEOUT" bun install --network-concurrency=16 "$@"; then
    echo "::endgroup::"
    echo "bun install succeeded on attempt $attempt"
    exit 0
  fi
  echo "::endgroup::"
  echo "attempt $attempt stalled or failed; retrying with a warmer cache"
  attempt=$((attempt + 1))
done

echo "bun install failed after $BUN_INSTALL_ATTEMPTS attempts" >&2
exit 1
