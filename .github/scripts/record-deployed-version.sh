#!/usr/bin/env bash
# SPDX-FileCopyrightText: Max Health Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
# Hand the version just built to the infrastructure repository, as a pull request.
#
# The deployed version used to exist only as a flag on this workflow run and in the live
# ECS task definition, so nothing in git could answer "which build is in production?" and a
# rollback meant pushing an older image over a tag. proxy-smart-infra now carries it in
# deploy-versions.json.
#
# Opening a pull request rather than pushing to main is the point: merging it is what
# deploys production, with the CDK diff on the pull request as the review.
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
    --body "proxy-smart's release built and pushed ${VERSION}. Nothing in production runs
it yet.

**Merging this pull request is the production deployment.** Read the CDK diff above first:
it is the last look at what CloudFormation is about to change. The deploy then waits for
both ECS services to stabilise and checks that production still answers."
else
  echo "A pull request for ${BRANCH} is already open."
fi
