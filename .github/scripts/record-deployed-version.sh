#!/usr/bin/env bash
# SPDX-FileCopyrightText: Max Health Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
# Record the version just deployed in the infrastructure repository, as a pull request.
#
# The deployed version used to exist only as a flag on this workflow run and in the live
# ECS task definition, so nothing in git could answer "which build is in production?" and a
# rollback meant pushing an older image over a tag. proxy-smart-infra now carries it in
# deploy-versions.json; this keeps that file honest.
#
# Opening a pull request rather than pushing to main is the point: merging it is what will
# eventually perform the deployment, once the CDK steps move out of this workflow. Until
# then the file only records what already happened.
#
# Expects: VERSION, GH_TOKEN (scoped to the infra repository), and the infra checkout in
# INFRA_DIR.
set -euo pipefail

INFRA_DIR=${INFRA_DIR:-infra}
BRANCH="release/${VERSION}"

cd "$INFRA_DIR"

if [ "$(jq -r '.appVersion' deploy-versions.json)" = "$VERSION" ]; then
  echo "deploy-versions.json already records ${VERSION}; nothing to open."
  exit 0
fi

jq --arg v "$VERSION" '.appVersion = $v' deploy-versions.json > deploy-versions.json.tmp
mv deploy-versions.json.tmp deploy-versions.json

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git checkout -b "$BRANCH"
git add deploy-versions.json
git commit -m "release: ${VERSION}"
git push --force-with-lease origin "$BRANCH"

# Same shape as the org's other auto-PRs: ask first, then create or leave alone.
if [ "$(gh pr list --head "$BRANCH" --state open --json number --jq length)" = "0" ]; then
  gh pr create \
    --base main \
    --head "$BRANCH" \
    --title "release: ${VERSION}" \
    --body "Records the version deployed to production by proxy-smart's release workflow.

Merging this deploys nothing extra today; the release has already applied it. Once the CDK
steps move out of that workflow, merging this pull request becomes the deployment."
else
  echo "A pull request for ${BRANCH} is already open."
fi
