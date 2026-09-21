# Changelog

All notable changes to Proxy Smart will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.4.16-alpha.202609211144.048d3046b] - 2026-09-21

- 🔧 Chores & Improvements: Version bump to 0.4.16-alpha.202609211144.048d3046b (alpha)
- 📚 Documentation: Update CHANGELOG.md for PR #1218

**Full Changelog**: https://github.com/proxy-smart/proxy-smart/pull/1219


## [0.4.16-alpha.202609211140.359a88dc6] - 2026-09-21

- 🔧 Chores & Improvements: CI fix to accurately count PR commits for release gating
- 🔧 Chores & Improvements: Update alpha version tag to 0.4.16-alpha.202609211140.359a88dc6
- ⚠️ Breaking Changes: none
- ✨ Features: none
- 🐛 Bug Fixes: none
- 📚 Documentation: none

**Full Changelog**: https://github.com/proxy-smart/proxy-smart/pull/1218


## [0.4.16-beta.202609141727.a5570bf9a] - 2026-09-14

- 📚 Documentation: Backfill and correct 0.4 changelog; fix README/docs drift and stale facts
  - Includes corrections to four pages surfaced by README audit
  - Clarifies repository structure (admin UI and DICOM template moved to separate repos)
  - Corrects outdated frontend/workspace references and release notes logic
- 🔧 Chores & Improvements: Update and sync versioning references in release metadata

**Full Changelog**: https://github.com/proxy-smart/proxy-smart/pull/1213


### 🔧 Maintenance

- keep only the newest release pull request open

## [0.4.15] - 2026-09-14

### 🔧 Maintenance

- point the IG typecheck at the action's public home

**Full Changelog**: https://github.com/proxy-smart/proxy-smart/compare/v0.4.14-RELEASE.202609141702.3bcf5481e...v0.4.15-RELEASE.202609141716.7e2bac068


## [0.4.14] - 2026-09-14

### 📚 Documentation

- **oauth-scopes**: keep the invariants, drop the incident write-ups

### 🔧 Maintenance

- hand production deploys to proxy-smart-infra

**Full Changelog**: https://github.com/proxy-smart/proxy-smart/compare/v0.4.13-RELEASE.202609141534.f9d49106e...v0.4.14-RELEASE.202609141702.3bcf5481e


## [0.4.13] - 2026-09-14

### ✨ Features

- **login**: collapse the password form behind "Or sign in with your password"
- **login**: put the identity provider above the username and password form

### 🐛 Bug Fixes

- **test**: open the password disclosure before filling the login form
- **keycloak**: declare the membership attributes the IdP imports
- **admin**: report last login from the stored attribute, not live sessions

### 📚 Documentation

- cut the comments back to the decision, not the history

### 🔧 Maintenance

- record the deployed version in the infrastructure repository
- **keycloak**: authenticate the admin client once per token lifetime
- give the token-cache margin case room to run under load
- **e2e**: match the sign-in button on SMART, not its full label

**Full Changelog**: https://github.com/proxy-smart/proxy-smart/compare/v0.4.12-RELEASE.202609041913.23902a03d...v0.4.13-RELEASE.202609141534.f9d49106e


## [0.4.12] - 2026-09-05

### 🐛 Bug Fixes

- **ci**: resolve the registry token in the publish workflows

### 🔧 Maintenance

- split smart-apps and fhir-servers, and move mTLS out of the routes layer
- stop the events-logger harness sharing fixture state between cases
- stop running Inferno compliance on every dev/* push
- split the two files that were half the LOC-gate debt
- one event journal and one TTL cache instead of six and eighteen

**Full Changelog**: https://github.com/proxy-smart/proxy-smart/compare/v0.4.11-RELEASE.202609032203.fa983a0b0...v0.4.12-RELEASE.202609041913.23902a03d


## [0.4.11] - 2026-09-04

### ⚠️ Breaking Changes

- **elysia-mcp**: require the dispatch app instead of a synthetic context

### 🐛 Bug Fixes

- prefer a declared client_uri when backfilling baseUrl
- **seo**: give the named crawler groups the full disallow list
- **theme**: make the two page-expired links say what they do

### 🔧 Maintenance

- **auth**: keep the auth package internal
- **backend**: remove document import, which is not an auth concern
- sync package versions
- pin the smart-config endpoints as admin-only
- **auth**: align the smart-config handlers with validateAdminToken
- drop an unnecessary type assertion in the baseUrl backfill
- short comments, or none

**Full Changelog**: https://github.com/proxy-smart/proxy-smart/compare/v0.4.10-RELEASE.202608302020.90539381e...v0.4.11-RELEASE.202609032203.fa983a0b0


## [0.4.10] - 2026-08-30

### ✨ Features

- **auth**: ask which identity a launch is for, instead of guessing

### 🐛 Bug Fixes

- **auth**: keep the identity picker out of the launches SMART expects to be seamless
- **auth**: send "Back to application" to the application
- **app-store**: hide the Admin link unless a deployment asks for it

### 📚 Documentation

- **auth**: document the identity-choice API, restoring the coverage gate
- **auth**: why PractitionerRole is not a candidate identity
- **auth**: a practitioner seat is not scoped to the account holding it

### 🔧 Maintenance

- sync package versions
- **auth**: one reader for patient_facing, beside the helper that knows the shape
- publish with the repository's own token, and stop reading a 401 as "unpublished"

**Full Changelog**: https://github.com/proxy-smart/proxy-smart/compare/v0.4.9-RELEASE.202608301614.67e3a1cdf...v0.4.10-RELEASE.202608302020.90539381e


## [0.4.9] - 2026-08-30

### 🐛 Bug Fixes

- **auth**: let a token name a per-server FHIR MCP endpoint

### 🔧 Maintenance

- sync package versions

**Full Changelog**: https://github.com/proxy-smart/proxy-smart/compare/v0.4.8-RELEASE.202608301044.4d3c22033...v0.4.9-RELEASE.202608301614.67e3a1cdf


## [0.4.8] - 2026-08-30

### 🐛 Bug Fixes

- **auth**: put FHIR server management behind the admin guard
- **auth**: describe only the MCP endpoints this deployment actually serves

### 🔧 Maintenance

- sync package versions
- **cors**: one allowedOrigin, next to the predicate it wraps

**Full Changelog**: https://github.com/proxy-smart/proxy-smart/compare/v0.4.7-RELEASE.202608301014.276d60e05...v0.4.8-RELEASE.202608301044.4d3c22033


## [0.4.7] - 2026-08-30

### 🐛 Bug Fixes

- **auth**: answer a successful client registration with 201, as RFC 7591 requires

### 🔧 Maintenance

- sync package versions
- stop both publish workflows failing on every run since the org move

**Full Changelog**: https://github.com/proxy-smart/proxy-smart/compare/v0.4.6-RELEASE.202608300908.c96983eaa...v0.4.7-RELEASE.202608301014.276d60e05


## [0.4.6] - 2026-08-30

### ✨ Features

- **publish**: take the release version from the tag, not from a committed manifest
- **build**: let the builder supply the commit, and fix a source offer that could point nowhere

### 🐛 Bug Fixes

- **auth**: read patient_facing as the string Keycloak sends, not its first letter
- **mcp**: describe the requested resource in path-scoped metadata, not the admin MCP
- **auth**: stop dropping prompt, nonce, login_hint and max_age at /authorize

### 🔧 Maintenance

- **hooks**: stamp package versions on release branches only
- sync package versions

**Full Changelog**: https://github.com/proxy-smart/proxy-smart/compare/v0.4.5-RELEASE.202608300043.1ba9b4a6e...v0.4.6-RELEASE.202608300908.c96983eaa


## [0.4.5] - 2026-08-30

### 🐛 Bug Fixes

- **fhir-mcp**: give the per-server MCP endpoint the FHIR proxy's audience policy
- **smart-apps**: let patientFacing be cleared, not just set
- **oauth**: resolve a Person fhirUser upstream, not through the proxy

**Full Changelog**: https://github.com/proxy-smart/proxy-smart/compare/v0.4.4-RELEASE.202608300000.3a802fe94...v0.4.5-RELEASE.202608300043.1ba9b4a6e


## [0.4.4] - 2026-08-30

### 🐛 Bug Fixes

- consume the Consent IG as @proxy-smart/consent-fhir

**Full Changelog**: https://github.com/proxy-smart/proxy-smart/compare/v0.4.3-RELEASE.202608292300.0e4b71967...v0.4.4-RELEASE.202608300000.3a802fe94


## [0.4.3] - 2026-08-30

### 🐛 Bug Fixes

- **ci**: publish the Consent IG as @proxy-smart/consent-fhir

### 🔧 Maintenance

- sync package versions

**Full Changelog**: https://github.com/proxy-smart/proxy-smart/compare/v0.4.2-RELEASE.202608292233.1e999588c...v0.4.3-RELEASE.202608292300.0e4b71967


## [0.4.2] - 2026-08-30

### 🐛 Bug Fixes

- **idp**: check what a mapper DOES, not just that one exists

### 🔧 Maintenance

- sync package versions
- lockstep only the packages the backend's version actually describes
- drop dead config from the version script
- gitignore .npmrc
- revert main only when production actually changed
- derive the publish scope from the repository owner

**Full Changelog**: https://github.com/proxy-smart/proxy-smart/compare/v0.4.1-RELEASE.202608292044.406aac756...v0.4.2-RELEASE.202608292233.1e999588c


## [0.4.1] - 2026-08-29

### 🐛 Bug Fixes

- **theme**: stop the error page's only link being a 403

### 📚 Documentation

- **ci**: correct the comments the move made wrong

### 🔧 Maintenance

- sync package versions
- **ci**: drop the dead setup-node-ai action
- move to the proxy-smart org and put every package under its scope
- let each deploy job own its toolchain instead of nesting it in the action
- keep the nested checkout from deleting the admin UI it just cloned
- gate deploys on the theme's ${env.X} actually being set
- cap the version-ops job so a hang cannot block every alpha release
- build the admin UI before the image that copies it, on both deploy paths
- follow the admin UI to the proxy-smart org
- **ci**: finish removing the AI self-heal subsystem

### 📦 Other Changes

- Revert "refactor: move the CLI to proxy-smart/cli"

**Full Changelog**: https://github.com/proxy-smart/proxy-smart/compare/v0.4.0-RELEASE.202608291352.6abf886ca...v0.4.1-RELEASE.202608292044.406aac756


## [0.4.0] - 2026-08-29

### ✨ Features

- **mcp**: draw a write tool's arguments as a form the user fills in
- **mcp**: render tool results as prefab UIs for MCP Apps hosts
- **elysia-mcp**: let a tool result carry a rendered view
- **api-client**: publish the generated client as a package

### 🐛 Bug Fixes

- **docker**: drop the COPY of a lib/ directory that no longer exists
- **ci**: compile doc examples from a workspace that still exists
- **api-client**: bundle the entries so Node can resolve them
- **docker**: build the api-client package instead of the removed UI directory
- **webapp**: explain a missing admin UI instead of failing on the file
- **test**: stop racing the clock in the consent cache cleanup test
- **ci**: green the doc-coverage and REUSE gates
- **elysia-mcp**: drop the dangling ./transport export
- **deploy**: keep beta secrets out of the remote process table

### 📚 Documentation

- **mcp**: correct the protocol revision and document the SDK boundary

### 🔧 Maintenance

- sync package versions
- move the CLI to proxy-smart/cli
- move the agent plugins to proxy-smart/plugins
- move the DICOM app template out, and bump to 0.4.0
- move the admin UI to its own private repository
- **license**: declare the dual licence consistently, drop the MIT outlier
- consume the published IG packages instead of vendored tarballs
- bump zod and lucide-react (#1096)

**Full Changelog**: https://github.com/proxy-smart/proxy-smart/compare/v0.3.29-RELEASE.202608282359.873fe413d...v0.4.0-RELEASE.202608291352.6abf886ca


## [0.3.30-alpha.202608291138.c2ac99f12] - 2026-08-29

- 🔧 Chores & Improvements: Version bumps for pre-release alpha 0.3.30-alpha.202608291138.c2ac99f12
- 📚 Documentation: changelog update for PR #1107

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1108


## [0.3.30-alpha.202608291135.c83e9dd58] - 2026-08-29

- ✨ Features
  - None

- 🐛 Bug Fixes
  - fix(webapp): handle missing admin UI gracefully when public/webapp/index.html is absent, avoiding failure and clarifying REST API-admin surface behavior
  - fix(test): stabilize consent cache cleanup test by addressing clock vs timer discrepancy

- 📚 Documentation
  - docs: update CHANGELOG.md for PR #1106

- 🔧 Chores & Improvements
  - chore: sync package versions
  - chore: sync package versions (duplicate)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1107


## [0.3.30-beta.202608291115.70c5bb971] - 2026-08-29

- ✨ Features:
  - MCP UI: render tool results as prefab UIs for MCP Apps hosts (prefab UI from tool payload)
  - MCP UI: draw a write tool's arguments as a form the user fills in

- 🐛 Bug Fixes:
  - Fix CI gates: green doc-coverage and REUSE gates by aligning documentation naming with actual symbols

- 🔧 Chores & Improvements:
  - Sync package versions
  - Update version metadata to 0.3.30-beta.202608291115.70c5bb971 (beta)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1106


## [0.3.30-beta.202608291010.f3c0b0f8b] - 2026-08-29

- ✨ Features: render tool results as prefab UIs for MCP Apps hosts (mcp)
- 🔧 Chores & Improvements: sync package versions
- 🔧 Chores & Improvements: update version to 0.3.30-beta.202608291010.f3c0b0f8b (beta)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1104


## [0.3.30-beta.202608290842.c91c9caea] - 2026-08-29

- 🔧 Chores & Improvements: Sync package versions and consume published IG packages (remove vendored tarballs)
  - chore: sync package versions (quotentiroler)
  - chore: consume the published IG packages instead of vendored tarballs (quotentiroler)

- ✨ Features (new functionality)
  - None

- 🐛 Bug Fixes
  - None

- 📚 Documentation
  - docs: correct MCP protocol revision and SDK boundary documentation

- ⚠️ Breaking Changes
  - None

- 🔧 Chores & Improvements (CI/CD)
  - 🔄 Update version to 0.3.30-beta.202608290842.c91c9caea (beta)
  - 🔄 Update version to 0.3.30-alpha.202608290842.c91c9caea (alpha)
  - chore: sync package versions (quotentiroler)
  - docs: update CHANGELOG.md for PR #1098
  - docs: update CHANGELOG.md for PR #1097

Notes:
- Skipped: update commits without meaningful context; merge commits; metadata updates.
- Only meaningful changes since last release are included.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1100


## [0.3.30-alpha.202608290832.00558e9bd] - 2026-08-29

- 🔧 Chores & Improvements: Internal updates and maintenance

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1098


## [0.3.30-alpha.202608290829.d740f3a7f] - 2026-08-29

- 🔧 Chores & Improvements: Bump versions for zod and lucide-react across frontends; clean up transport export handling to reflect moved mcp-http components
- 🐛 Bug Fixes: Remove dangling ./transport export reference to prevent resolution errors after transport/session move
- 🔧 Chores & Improvements: Sync package versions and update internal metadata to reflect 0.3.30-alpha.202608290829.d740f3a7f

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1097


## [0.3.29-beta.202608282325.afbdef61d] - 2026-08-28

- ✨ Features
  - No user-facing features detected in this set.

- 🐛 Bug Fixes
  - Narrow type checks in consent/types.ts to avoid unnecessary assertions while maintaining correct behavior for R4/R5 union handling.

- 🔧 Chores & Improvements
  - Refactor UI: share a single DICOM form between add and edit dialogs to reduce duplication.
  - Refactor UI: share monitoring socket logic between OAuth and consent to consolidate common behavior.
  - Re-structure internal code to reduce duplication and improve maintainability.

- 📚 Documentation
  - No documentation changes detected.

- ⚠️ Breaking Changes
  - None detected.

- 🔄 CI/CD / Versioning
  - Bump versions across packages and update beta version identifiers.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1091


## [0.3.29-beta.202608282259.633003ecd] - 2026-08-28

- ✨ Features: None
- 🐛 Bug Fixes: None
- 📚 Documentation: None
- 🔧 Chores & Improvements:
  - Refactors and maintenance: consolidate monitoring modules into a factory; share contract between admin and SMART document-import routes; remove backend launch-code copy in auth package
  - Dependency and version housekeeping: update dependencies to latest (TypeScript kept at 6.0.3); sync package versions
  - Test improvements: test the logger directly instead of a copied implementation
- ⚠️ Breaking Changes: None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1088


## [0.3.29-beta.202608282230.0be408206] - 2026-08-28

- ✨ Features
  - None

- 🐛 Bug Fixes
  - fix: stop beta deploy stripping prompt from maxhealth broker; align prompt and logoutUrl to avoid losing added fields during beta deploys
  - fix: keep deployed-realm assertions running after path change to ensure seeds and CI accounts are created as expected

- 📚 Documentation
  - docs: note practitioner panel narrowing is not yet implemented

- 🔧 Chores & Improvements
  - chore: build Keycloak from a realm-less base and layer realm per environment for cleaner images
  - CI/CD: versioning updates for beta/alpha pre-releases

- ⚠️ Breaking Changes
  - None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1085


## [0.3.28-alpha.202608271636.ea49e0947] - 2026-08-27

- 🔧 Chores & Improvements: Synchronize package versions and update alpha pre-release to 0.3.28-alpha.202608271636.ea49e0947
- 🐛 Bug Fixes: Fix FHIR generation to use babelfhir-ts 1.6.10 for consent-fhir to avoid extra client-r4 dependency and related issues

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1074


## [0.3.25-beta.202608261825.cd165e80f] - 2026-08-26

- 🔧 Chores & Improvements: Sync package versions
- 📚 Documentation: Keep onboarding example deployment-neutral; remove sensitive/irrelevant deployment names from example config

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1061


## [0.3.21-beta.202608251511.5fc93e7ad] - 2026-08-26

- 🐛 Bug Fixes: Fix Keycloak provisioning to create fhir-resource-server when missing in production environments, ensuring correct FHIR aud mapping and token exchange.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1049


## [0.3.20-RELEASE.202608251354.1cfc4b69b] - 2026-08-25

- 🐛 Bug Fixes
  - fix(keycloak): create fhir-resource-server when missing in production to resolve invalid_target during token exchange

- 🔧 Chores & Improvements
  - chore: sync package versions
  - 🔄 Update version to 0.3.20-RELEASE.202608251354.1cfc4b69b
  - 🔄 Update version to 0.3.20-beta.202608251354.1cfc4b69b
  - 🔄 Update version to 0.3.20-alpha.202608251354.1cfc4b69b

- ⚠️ Breaking Changes
  - None

- 📚 Documentation
  - docs: update CHANGELOG.md for PR #1046

- 🔧 Chores & Improvements (stability/infra)
  - fix(infra): alarm on backend memory and ensure stability under production loads
  - fix(infra): give backend more headroom to prevent OOM kills

Notes:
- Updated to stable release 0.3.20 and included related beta/alpha version bumps.
- Focused on user-facing fix for production token exchange and infrastructure stability.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1050


## [0.3.20-beta.202608251354.1cfc4b69b] - 2026-08-25

- 🐛 Bug Fixes: Addressed memory alarm handling to prevent OOM kills under backpressure; clarified behavior of launch-context store per-task to avoid carrying state across restarts
- 🔧 Chores & Improvements: Update version pre-release tag to 0.3.20-beta.202608251354.1cfc4b69b

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1046


## [0.3.16-beta.202608161817.167c04f59] - 2026-08-19

- ✨ Features
  - 🧭 (No new user-facing features found)

- 🐛 Bug Fixes
  - fix(picker): restrict patient directory access to practitioners only
  - fix(admin): ensure federated-identity link endpoint is callable

- 🔧 Chores & Improvements
  - chore: sync package versions
  - chore: update internal version metadata and related housekeeping

- ⚠️ Breaking Changes
  - (None detected)

Note: Only changes since last release included; merge/update commits skipped.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1030


## [0.3.14-beta.202608131924.cfdc0c7f7] - 2026-08-13

- 🔧 Chores & Improvements: CI/CD and version synchronization
  - Update version to 0.3.14-beta.202608131924.cfdc0c7f7 (beta)
  - chore: sync package versions
- 🐛 Bug Fixes: EHR launch flow fix
  - fix(ci): perform the EHR half of the EHR launch instead of scraping a URL
    - Corrects misnamed launch path handling and ensures proper iss correlation

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1019


## [0.3.11-RELEASE.202608121633.0ee3da2eb] - 2026-08-13

- ✨ Features
  - Add explicit region handling and validation in deploy/infra: require region via CDK context, validate against allowed list, and guard against region mismatches.

- 🐛 Bug Fixes
  - Improve FHIR endpoint verification: perform curl-based reachability check against /proxy-smart-backend/hapi-fhir-server/R4/metadata; treat 2xx/401/403 as reachable and fail deploy on other statuses.

- 🔧 Chores & Improvements
  - None additional beyond the above (merged/metadata commits skipped).

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1004


## [0.3.11-beta.202608121633.0ee3da2eb] - 2026-08-12

- 🔧 Chores & Improvements: Enforced explicit region handling in deploy/infra; added DEPLOY_REGIONS, CDK context region validation, and mismatch guard between ambient and provided regions.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1002



- 🔧 Chores & Improvements: Internal updates and maintenance
- 📚 Documentation: Update CHANGELOG.md for recent PRs

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/1005


## [0.3.9-beta.202608120811.c481d7d66] - 2026-08-12

- ✨ Features: none
- 🐛 Bug Fixes: none
- 📚 Documentation: none
- 🔧 Chores & Improvements: sync package versions; fix non-deprecated OpenAI embedding accessor; pin read/write config parity to prevent schema drift
- ⚠️ Breaking Changes: none

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/994


## [0.3.4-beta.202608081721.cb4b3a46e] - 2026-08-08

- ✨ Features: 
  - feat(admin-ui): let the user editor show and assign technical roles

- 🔧 Chores & Improvements:
  - refactor(admin-ui): route console logging through the buffered logger
  - refactor(mcp): serve the per-server FHIR endpoint through @maxhealth.tech/mcp-http
  - chore: sync package versions

- 🐛 Bug Fixes:
  - fix(mcp): fail closed on the Bearer gate, and serve /mcp through mcp-http

Note: Skipped update/metadata/merge commits per guidelines.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/970


## [0.3.2-beta.202608080958.1d8c5f755] - 2026-08-08

- 🔧 Chores & Improvements: Sync package versions (quotentiroler)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/956


## [0.3.1-RELEASE.202608080909.7c5548376] - 2026-08-08

- 🔧 Chores & Improvements: CI/docs checks added; doc-check tooling introduced (typecheck doc examples, doc coverage) and integrated into build/check scripts; ignore artifacts (.doccheck/, lib/maxhealth.consent-*.tgz); docs tweaks to skip doccheck in specific MD files

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/955


## [0.3.1-beta.202608080909.7c5548376] - 2026-08-08

- 🔧 Chores & Improvements: Update and maintain dev SMART compliance report references for testing
- 🔧 Chores & Improvements: Version metadata update for pre-release 0.3.1-beta.202608080909.7c5548376

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/953


## [0.3.1-beta.202608080900.da2df3824] - 2026-08-08

- 🔧 Chores & Improvements: Internal updates and maintenance

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/951


## [0.3.1-beta.202608080834.e4dd5c08f] - 2026-08-08

- 🔧 Chores & Improvements: CI/CD and testing updates
  - chore(testing): update dev SMART compliance report
  - 🔧 Chores & Improvements: version metadata changes (internal)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/949


## [0.2.33-beta.202608080800.fdbdc247a] - 2026-08-08

- 🔧 Chores & Improvements: Update development/testing tooling and version identifier

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/945


## [0.2.33-alpha.202608080713.96ba5453a] - 2026-08-08

- 🔧 Chores & Improvements: Minor CI/CD and versioning updates
  - Update docs: CHANGELOG entries for recent PRs
  - Bump versions to 0.2.32-beta and 0.2.33-alpha

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/942


## [0.2.32-RELEASE.202608071630.8c09b932d] - 2026-08-07

- ✨ Features: Introduced centralized WAF rule management
  - Add waf-rules.ts with shareable managedRuleGroups for WAF usage across BackendStack and KeycloakStack
  - Remove inline AWSManagedRules…RuleSet configurations in stacks in favor of centralized managedRuleGroups (with exclusions)

- 🔧 Chores & Improvements: Code organization and imports
  - KeycloakStack and BackendStack now import managedRuleGroups from waf-rules.ts
  - Minor header/IP edits; add SPDX headers and additional imports
  - Preserve metrics configuration via shared exclusions

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/939



- 🔧 Chores & Improvements: Centralize WAF rules via waf-rules.ts; remove inline AWSManagedRules configurations and import shareable managedRuleGroups in KeycloakStack and BackendStack; preserve existing metrics exclusions and add SPDX headers.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/941


## [0.2.31-beta.202608071218.dc88343db] - 2026-08-07

- 🔧 Chores & Improvements: Dependency and tooling updates, including bun.lock bumps across multiple packages and registry config tweaks
- 🔧 Chores & Improvements: Frontend i18n tooling cleanup and script removals; translations.json updated, large-scale tooling trimmed
- 🔧 Chores & Improvements: Frontend UI i18n scripts added (i18n:sync, i18n:scan, i18n:translate) and devDependency on @max-network/i18n

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/936


## [0.2.30-beta.202608061003.8c8a24a2f] - 2026-08-07

- 🔧 Chores & Improvements: Update dev SMART compliance report (testing)
- 🔧 Chores & Improvements: Update version to 0.2.30-beta.202608061003.8c8a24a2f

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/932


## [0.2.29-beta.202608060854.0000d3360] - 2026-08-06

- 🔧 Chores & Improvements: Internal maintenance and CI/CD updates

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/929



- 🔧 Chores & Improvements: Internal updates and maintenance
  - Update dev SMART compliance report (testing)
  - Update dev SMART compliance report (testing)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/930


## [0.2.22-beta.202608050846.e7ba4062e] - 2026-08-05

- 🔧 Chores & Improvements: Version bump housekeeping (update to 0.2.23-alpha; skip CI)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/908


## [0.2.13-alpha.202607241629.9c34f2cb0] - 2026-07-24

- 🔧 Chores & Improvements: CI/CD enhancements
  - Upgrade GitHub Actions runners and actions (Buildx, Python UV setup, publisher workflows)
  - Increase uv setup action version and bump Docker Buildx action

No user-facing features or bug fixes detected.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/865


## [0.2.13-alpha.202607241617.e4a5c5785] - 2026-07-24

- 🔧 Chores & Improvements: CI/CD updates
  - Upgrade Docker Buildx action to v4
  - Update Python UV setup action to v8.1.0
  - Update GitHub Actions runners and configs:
    - publish-ig.yml: checkout v4 → v6; setup-node v4 → v6 (node 22, GitHub Packages registry)
    - spdx-headers.yml: checkout v4 → v6 (main and PR paths); fetch-depth 0 for PR path remains

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/863


## [0.2.13-alpha.202607241531.7c951cea5] - 2026-07-24

- 🔧 Chores & Improvements: Sync package versions across modules
- 🐛 Bug Fixes: Fix license parsing by avoiding reuse of lint parsing code as license expressions
- 📚 Documentation: Update CHANGELOG.md for PRs 859 and 860
- 🔧 Chores & Improvements: CI/CD and testing updates (SMART compliance reports, beta and dev test reports)
- 🔧 Chores & Improvements: Update version metadata to 0.2.13-alpha.202607241531.7c951cea5

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/862


## [0.2.13-alpha.202607241526.f496667b0] - 2026-07-24

- 🔧 Chores & Improvements: Sync package versions and update beta/alpha version metadata
- 📚 Documentation: Update CHANGELOG for PR #859
- 🧪 Features: Internal testing/report updates (SMART compliance reports)
- ⚠️ Breaking Changes: None detected

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/860


## [0.2.13-alpha.202607241513.91cfdf6c8] - 2026-07-24

- 🔧 Chores & Improvements: Internal updates and maintenance
  - Update dev SMART compliance report (testing)
  - Sync package versions
  - Refactor(source): extract handler using Elysia's exported Context type

Note: Skipped: update/version metadata commits and merge commits per rules.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/859


## [0.2.13-alpha.202607241419.b78d263f2] - 2026-07-24

- 🔧 Chores & Improvements: Introduced SHL-Consent reconciliation flow with startup trigger, idempotent mirror handling, retry logic, and updated session storage (consent_mirrored flag). Added DB migration support and API for reconciliation (consent_mirrored column, markConsentMirrored, listUnmirroredActive). Added tests for reconciliation bookkeeping.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/856


## [0.2.13-beta.202607241021.3163c8e52] - 2026-07-24

- ✨ Features: Add SHL-Consent reconciliation flow, including startup trigger, explicit reconciliation logic, idempotent mirror handling, and retry mechanism
- 🧭 Database & API: Introduce consent_mirrored flag, markConsentMirrored method, and listUnmirroredActive for reconciliation sweeps
- 🧪 Testing: Add tests for reconciliation bookkeeping (backend/test/shl-consent-reconcile.test.ts)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/855


## [0.2.13-alpha.202607241021.3163c8e52] - 2026-07-24

- ✨ Features: honest share model + distinct-device access tracking (shl)
- 🐛 Bug Fixes: return 404 for no-longer-active links per SHL spec (shl)
- 🔧 Chores & Improvements: sync package versions; update beta/alpha version metadata (internal tooling and CI)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/854


## [0.2.13-beta.202607231720.f8ff94f16] - 2026-07-23

- ✨ Features: Brand theming support
  - Backend: add primaryColor and accentColor to config, propagate to runtime, and expose in session-based brand context for theming
  - Frontend: BrandSettings supports editing/preview of primaryColor and accentColor; default values added
  - Client: fetchBrandContext API to apply brand colors to CSS variables on load

- 🔧 Chores & Improvements: Dependency and packaging updates
  - Bump multiple packages to 0.2.13-beta.202607221520.e50fd77ec
  - Update ESLint config and integrate brandc package for UI theming
  - Update token imports in UI CSS and bunfig.toml scoping for brand-token contract

- 📚 Documentation: (none)

- ⚠️ Breaking Changes: (none)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/849


## [0.2.13-alpha.202607231720.f8ff94f16] - 2026-07-23

- ✨ Features: Brand theming support across backend and frontend
  - Add primaryColor and accentColor to backend config, org-branding, runtime config, and admin schema
  - Extend OAuth brand-context endpoint to return theming colors for session-based use
  - Frontend BrandSettings: enable editing/preview of primaryColor and accentColor with defaults
  - Patient picker applies brand-context to theme CSS variables on load; new API client fetchBrandContext

- 🔧 Chores & Improvements: Dependency and packaging updates
  - Bump multiple packages to 0.2.13-beta.202607221520
  - Update ESLint config and UI to depend on brandc package; update token imports in UI CSS
  - bunfig.toml scopes note for brand-token contract
  - Propagate version bumps across nested projects (auth, cli, app-store, etc.)

- 💡 Documentation: (none)

- ⚠️ Breaking Changes: (none)

- 🔧 Chores & Improvements: Internal updates and maintenance

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/848


## [0.2.13-beta.202607231603.838c9317b] - 2026-07-23

- ✨ Features: Frontend BrandSettings now supports editing/preview of primaryColor and accentColor; runtime brand config now propagates and uses these values. Brand-context endpoint extended to resolve and return colors for session-based theming.
- 🐛 Bug Fixes: None explicitly stated beyond feature-related updates.
- 📚 Documentation: None.
- 🔧 Chores & Improvements: Brand theming fields added across backend and runtime configs; theme CSS variables are applied on load; new API client for fetchBrandContext; package version bumps to 0.2.13-beta.202607231603.838c9317b; ESLint and token import updates; bunfig.toml note added for brand-token contract.
- ⚠️ Breaking Changes: None detected.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/847


## [0.2.13-alpha.202607231603.838c9317b] - 2026-07-23

- ✨ Features: 
  - Add brand theming support across backend and frontend (primaryColor, accentColor) with propagation to runtime brand config and session-based theming via OAuth endpoint.
  - Frontend BrandSettings now supports editing/preview of primaryColor and accentColor; default values added.
  - Patient picker applies brand-context theming to root CSS variables (--primary, --maxhealth) on load.
  - New API client to fetch brand context.

- 🔧 Chores & Improvements:
  - Dependency/version bumps to new beta tag across core, frontend, and packages.
  - ESLint updates and brandc package integration for token imports in UI CSS (brandc/theme.css, brandc/tailwind.css).
  - bunfig.toml scopes note added for brand-token contract. 

- ⚠️ Breaking Changes: None detected.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/846


## [0.2.13-beta.202607231432.7f3c31ebe] - 2026-07-23

- ✨ Features: Brand theming support
  - backend/config propagation for primaryColor and accentColor; runtime brand config integration
  - OAuth brand-context endpoint enhanced to provide primary/accent colors for session-based theming
  - Frontend BrandSettings supports editing/preview of primaryColor and accentColor
  - Patient picker applies brand-context to theme CSS variables on load

- 🔧 Chores & Improvements: Version sync and dependencies
  - Bump multiple packages to 0.2.13-beta.202607221520.e50fd77ec (across bun.lock, bunfig, and package.jsons)
  - Update ESLint config and UI to depend on brandc package; adjust token imports in UI CSS
  - bunfig.toml scope note added for brand-token contract

- 🔧 Chores & Improvements: Misc maintenance
  - Propagation of brand color values through config and runtime layers
  - Frontend/CSS token updates to align with new theming system

- ⚠️ Breaking Changes: None detected

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/845


## [0.2.13-alpha.202607231432.7f3c31ebe] - 2026-07-23

- ✨ Features: 
  - Brand theming support: add primaryColor and accentColor across backend config, org-branding, runtime config, and admin schema; frontend editor/preview for colors; session-based theming available via updated brand-context endpoint.
  - Frontend/theme integration: apply brand-context to root CSS variables on load; new API client to fetch brand context.

- 🔧 Chores & Improvements:
  - Version bumps across multiple packages to 0.2.13-beta.202607221520.e50fd77ec.
  - Update ESLint config and token imports to align with brandc package (UI theme tokens).
  - bunfig.toml scopes added for brand-token contract.

- 🐛 Bug Fixes:
  - Propagation of primary/accent colors between config and runtime brand config; ensure runtime getRuntimeBrandConfig reflects changes.

- 📚 Documentation: (none)

- ⚠️ Breaking Changes: (none)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/844


## [0.2.13-beta.202607231042.705d38ecd] - 2026-07-23

- ✨ Features:
  - Brand theming: add primaryColor and accentColor support across backend config, org-branding, runtime config, and admin schema; frontend supports editing/preview of these colors.
  - Runtime theming: propagate and apply brand colors in runtime brand config; session-based theming via OAuth context.

- 🔧 Chores & Improvements:
  - Frontend: integrate brandc package for theming tokens and update CSS imports; enhance API client to fetch brand context.
  - Versioning/CI: update to 0.2.13-beta.202607231042.705d38ecd across packages; adjust ESLint and token imports accordingly.
  - Packaging: bunfig.toml scopes note for brand-token contract; propagate version bumps through nested projects.

- ⚠️ Breaking Changes:
  - None detected.

- 🐛 Bug Fixes:
  - None detected.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/842



- ✨ Features: Brand theming support across backend and frontend
  - Add primaryColor and accentColor to backend config, org-branding, runtime config, and admin schema
  - Frontend BrandSettings: edit/preview primaryColor and accentColor with defaults
  - OAuth brand-context endpoint now resolves and returns primary/accent colors for session-based theming
  - Patient picker applies brand-context to theme root CSS variables on load
- 🔧 Chores & Improvements: Dependency and config updates for beta
  - Bump multiple packages to 0.2.13-beta.202607231042
  - Update ESLint config and UI to depend on brandc package; update token imports in UI CSS
  - bunfig.toml: note scopes for brand-token contract
  - Propagate version bumps across nested projects (auth, cli, app-store, etc.)

Note: No breaking changes detected.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/843


## [0.2.13-alpha.202607231042.705d38ecd] - 2026-07-23

- ✨ Features
  - Frontend: brand theming support with editable primaryColor and accentColor; runtime theme integration via brand-context
  - Backend: brand-context endpoint enhanced to provide primary/accent colors for session-based theming

- 🔧 Chores & Improvements
  - Dependency and version bumps to 0.2.13-beta.202607221520 (across bun.lock, bunfig, multiple package.jsons)
  - UI: brandc integration and token imports in CSS (brandc/theme.css, brandc/tailwind.css)
  - bunfig.toml: added note about brand-token contract scope

- ⚠️ Breaking Changes
  - None identified

- 📚 Documentation
  - None

- 🐛 Bug Fixes
  - None identified

Note: Only changes since last release included; no breaking changes detected.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/841


## [0.2.13-beta.202607191927.fe7e4bfa3] - 2026-07-19

- 🔧 Chores & Improvements: CI/CD and version bump housekeeping
  - chore(testing): update dev SMART compliance report
  - 🔄 Update version to 0.2.13-alpha.202607191930.ad4938422 (alpha)
  - 🔄 Update version to 0.2.13-beta.202607191927.fe7e4bfa3 (beta)
  - chore: sync package versions

- 🐛 Bug Fixes: small compatibility and description length tweaks
  - fix(keycloak): shorten mcp-resource-server description to fit DB column (<=255)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/824


## [0.2.11-alpha.202606032247.2e8256972] - 2026-06-03

- ⚠️ Breaking Changes: None detected
- ✨ Features (new functionality): None detected
- 🐛 Bug Fixes: None detected
- 📚 Documentation: CHANGELOG updated for PR #791
- 🔧 Chores & Improvements: Internal version updates and maintenance

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/795


## [0.2.10-alpha.202606031951.ea3c49f35] - 2026-06-03

- ✨ Features: Expose app_store_url in .well-known/smart-configuration (smart-config)
- 🔧 Chores & Improvements: Sync package versions
- 🔧 Chores & Improvements: Docker: include packages/elysia-mcp in build

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/791


## [0.2.8-alpha.202606030828.6d5ddb841] - 2026-06-03

- 🔧 Chores & Improvements: sync package versions; update version metadata to alpha; CI/CD housekeeping
- 🐛 Bug Fixes: remove static launch context admin routes and related dead code
- 📚 Documentation: update CHANGELOG.md for PR #780

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/781


## [0.2.8-alpha.202606030821.c22ab62fc] - 2026-06-03

- 🔧 Chores & Improvements: Replace console.debug with logger.debug in smartStore.ts and add logger import for improved logging

- ⚠️ Breaking Changes: Remove Launch Context Sets feature scaffolding (LaunchContextManager.tsx, LaunchContextSetBuilder.tsx, related smartStore state/actions) and reduce related UI/store references in SmartConfigManager.tsx and smartStore.ts

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/780


## [0.2.7-beta.202606022042.f06c666e8] - 2026-06-02

- 🔧 Chores & Improvements: Version bumps across multiple packages and configs; mcp-endpoint.json updated timestamp; mcp-endpoint-config.ts now initializes enabledTools to [] instead of null.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/777


## [0.2.7-alpha.202606021939.a056cbc8a] - 2026-06-02

- 🔧 Chores & Improvements: Update JWKS configuration to use external URL in realm-export.json (remove embedded jwks, enable jwks.url)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/775


## [0.2.6-alpha.202606021350.3ff714da8] - 2026-06-02

- 🔧 Chores & Improvements: Sync package versions; internal version bump to 0.2.6-alpha.202606021350.3ff714da8
- 🐛 Bug Fixes: Use dot notation *.beta.maxhealth.tech (not dash) for beta domain
- ⚠️ Breaking Changes: None
- 📚 Documentation: None
- ✨ Features: None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/766


## [0.2.5-RELEASE.202606021010.e02c0b714] - 2026-06-02

- ✨ Features: Seed data and config on first run
  - Dockerfile now copies seed data into the image for initial setup
  - Seeded app-store-config.json added (new config with published apps)
  - Data initialization extends to seed missing config files from data-seed into DATA_DIR on startup (SEED_DIR handling)

- 🔧 Chores & Improvements: Minor repo housekeeping for data files
  - backend/.gitignore updated to track app-store-config.json and mcp-endpoint.json while still ignoring data directory contents
  - Backend data init logic enhanced to copy missing seed files on startup

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/762


## [0.2.5-beta.202606021010.e02c0b714] - 2026-06-02

- 🔧 Chores & Improvements: Version management updates not included in user-facing changes (ignore non-impactful metadata)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/760


## [0.2.3-beta.202606011847.26652b925] - 2026-06-01

- 🔧 Chores & Improvements: Sync package versions across monorepo
- 🔧 Chores & Improvements: Update shared-ui to 1b06f6a (table header/body spacing fix)
- 🐛 Bug Fixes: Remove accidental @max-health-inc/shared-ui npm dep from root
- 🔧 Chores & Improvements: Update beta/dev SMART compliance reports for CI/CD
- 🔧 Chores & Improvements: Version bump updates for pre-release tags (beta/alpha)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/755


## [0.2.2-beta.202605291257.9974557c6] - 2026-05-29

- ⚠️ Breaking Changes: None detected
- ✨ Features: None detected
- 🐛 Bug Fixes: None detected
- 📚 Documentation: None detected
- 🔧 Chores & Improvements: Internal updates and maintenance

Note: No user-visible feature or bugfix changes found since last release.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/739


## [0.2.0-alpha.202605221345.9f0067627] - 2026-05-22

- 🔧 Chores & Improvements: Conditional App Store UI serving and UI hiding
  - Backend: serveAppStoreUi() added to inject global flag and serve App Store UI HTML
  - Routing: /apps and /apps/ now use serveAppStoreUi() instead of Bun.file
  - Client: App Store UI hides Admin link when APP_STORE_HIDE_ADMIN is true

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/728


## [0.1.1-beta.202605221222.79711d615] - 2026-05-22

- 🔧 Chores & Improvements: CI/CD updates
  - Replace GH_PAT with GitHub App token flow in deploy-beta: add APP_ID and APP_PRIVATE_KEY, generate and use app token for private repo checkouts; deployment-strategy updated to stop requiring GH_PAT and pass APP_ID/APP_PRIVATE_KEY to jobs.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/724


## [0.1.1-alpha.202605221222.79711d615] - 2026-05-22

- 🔧 Chores & Improvements: CI/CD tweaks and package version sync
  - Sync package versions across multiple commits
  - Update version to 0.1.1-alpha.202605221222.79711d615 (alpha)
  - Update version to 0.1.1-alpha.202605221215.8cd1ff9b2 (alpha)
  - Update version to 0.1.1-alpha.202605221150.2bb2cb8d0 (alpha)
  - Update version to 0.1.1-alpha.202605221146.630e13ae (alpha)
  - Update version to 0.1.1-alpha.202605221042.3bc3a665 (alpha)
  - Update version to 0.1.1-alpha.202605221034.4f769c71 (alpha)
  - Update version to 0.1.1-beta.202605191043.72318795 (beta)
  - Add id-token:write permission for AWS OIDC deployment
  - Remove orphaned AI assistant system prompt
  - Move refactors and reorganizations (AI assistant, seed data, configs, infra)
  - Remove unused monorepo components (genomics-reporting-generated.tgz, patient-portal, dtr-app, consent-app)
- ✨ Features (new functionality)
  - feat: centralized auth error handling via shared-ui bus
  - feat(consent): nudge users to consent app on 403 denial
  - feat(infra): add FHIR stack + restrict Keycloak WAF to browser paths
  - fix(admin-ui): add appUrl to ConsentConfig default
  - fix(admin-ui): add Save button to scope management dialog
  - refactor: extract AI assistant to max-health-inc/ai-assistant
  - refactor: move patient-picker to dedicated location
  - refactor: move eslint-config/configs and infra reorganizations
- 🐛 Bug Fixes
  - fix(ci): patient-picker not served — copy script fixed
  - fix: update hardcoded app URLs for subdomain hosting
  - fix(keycloak): update redirect URIs for subdomain hosting
  - fix: remove ChatResponse re-export from types/api.ts
- 📚 Documentation
  - docs: update CHANGELOG.md for PR #722
- ⚠️ Breaking Changes
  - none observed in these changes

Note: Some commits are purely maintenance or version bumps; where no user-facing impact, they are grouped under Chores & Improvements.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/723


## [0.1.1-alpha.202605221215.8cd1ff9b2] - 2026-05-22

- 🔧 Chores & Improvements: Sync package versions across modules
- 🐛 Bug Fixes: Fix CI script paths for patient-picker; update admin-ui ConsentConfig default; fix admin-ui Save button in scope management; update hardcoded app URLs and Keycloak redirect URIs for subdomain hosting
- ✨ Features: Centralized auth error handling via shared-ui bus; FHIR stack integration and Keycloak WAF restrictions
- 📚 Documentation: Remove orphaned AI assistant system prompt; move AI assistant refactor to new repo path
- ⚠️ Breaking Changes: None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/722


## [0.1.1-beta.202605171634.2925aa76] - 2026-05-17

- 🔧 Chores & Improvements: Improve Keycloak path matching in docker-compose.beta.yml (broaden /auth/realms/*/broker/* to /auth/realms/*/broker/** with clarifying comment).

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/719


## [0.1.0-alpha.202605142141.3f719102] - 2026-05-14

- 🔧 Chores & Improvements: Update Docker setup and non-root execution
  - Dockerfile: add data directory for /app/backend/data, declare VOLUME, run as non-root app user (app) with ownership fix
  - Docker-related: healthcheck context updated to upstream 8445

- 🔧 Chores & Improvements: CI/CD and environment updates
  - docker-compose.beta.yml: extend Keycloak path filter to include broker endpoints: /auth/realms/*/broker/*

- ⚠️ Breaking Changes: Version bumps across packages
  - Bump version from 0.1.0-beta.202605142110.f2a50289 to 0.1.0-alpha.202605142130.6801ee2f in multiple packages (apps, libs, testing, eslint-config)

- ✨ Features: Expanded Caddy and path routing scope
  - Caddy path labels expanded to include a broad set of allowed backend paths (auth/*, admin/*, API, docs, OAuth/OpenID, fhir, dicomweb, apps, swagger, openapi, proxy-smart-backend, webapp, etc.)
  - Removed separate caddy.3_reverse_proxy block; now using a single caddy.1_reverse_proxy

- 🐛 Bug Fixes: Healthcheck alignment
  - Healthcheck now targets upstream 8445 with existing health settings

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/713


## [0.1.0-beta.202605140839.bf478422] - 2026-05-14

- ✨ Features
  - Backend: per-server MCP features introduced (server-level mcpEnabled flag, new /fhir/{server_id}/mcp route, session management, tool registration helper, and UI support for per-server MCP exposure)
  - UI: MCP toggle handling and per-server MCP UI elements (ServerCard, ServerOverview)

- 🔧 Chores & Improvements
  - CI/CD: gate step added to CI workflow to wait for required checks (Alpha Release + Build & Test) before auto-merge
  - Versioning: bump across multiple packages/apps to 0.1.0-alpha.202605140839.bf478422

- 🐛 Bug Fixes
  - FHIR client: stop stripping resource type; use logical IDs and adopt FHIR-friendly PUT workflow
  - Context enrichment: enforce logical IDs for Patient/Encounter in SMART STU 2.2

- 📚 Documentation
  - (None)

- ⚠️ Breaking Changes
  - (None)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/707


## [0.1.0-alpha.202605140839.bf478422] - 2026-05-14

- ✨ Features
  - UI: MCP toggle handling and per-server MCP exposure in ServerCard/ServerOverview
  - Backend: per-server MCP feature groundwork (server-level mcpEnabled flag, MCP routes at /fhir/{server_id}/mcp, session management, tool registration helper)
- 🔧 Chores & Improvements
  - CI/CD: gate step added to wait for required checks (Alpha Release + Build & Test) before auto-merge
  - Version bumps across multiple packages to 0.1.0-alpha.202605140839.bf478422

- ⚠️ Breaking Changes
  - None

- 🐛 Bug Fixes
  - FHIR client: stop stripping resource type; use logical IDs; adjust PUT/update strategy to FHIR-friendly payload
  - Tests updated to reflect logical IDs (no resource prefixes) in responses

- 📚 Documentation
  - None

- Note: Update commits and unrelated merge/metadata commits have been omitted per guidelines.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/706


## [0.1.0-alpha.202605132148.c3d57db3] - 2026-05-14

- ✨ Features: 
  - Add per-server MCP features and UI toggles (MCP enablement, per-server exposure, new /fhir/{server_id}/mcp route)
  - UI: MCP toggle handling and MCP-related UI elements in ServerCard/ServerOverview
- 🐛 Bug Fixes:
  - Fix patient-portal FHIR client to use logical IDs and proper PUT/update flow
  - Enforce logical IDs for context enrichment (strip resource prefixes) per SMART STU 2.2
- 🔧 Chores & Improvements:
  - Version bump to 0.1.0-alpha.202605131622.3716f6f9 across packages/apps
  - Internal wiring: server discovery/routes updated to show mcpEnabled flag; plumbing for setMcpEnabled
- 📚 Documentation: (none)
- ⚠️ Breaking Changes: (none)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/705


## [0.1.0-alpha.202605131622.3716f6f9] - 2026-05-13

- ✨ Features: 
  - Per-server MCP exposure introduced (MCP toggle, UI elements in ServerCard/ServerOverview, and per-server MCP enable flag)
  - MCP backend routes at /fhir/{server_id}/mcp with session management and tool registration helper
- 🔧 Chores & Improvements:
  - Wire MCPEnabled flag into server discovery/routes for visibility
  - Plumbing for setMcpEnabled across server store and admin schema
  - UI pass-through and toggle handling for MCP feature

(Note: No breaking changes or documentation updates detected.)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/704


## [0.1.0-alpha.202605131506.c7806a64] - 2026-05-13

- 🔧 Chores & Improvements: Version bump across all packages to 0.1.0-alpha.202605131506.c7806a64
- ✨ Features: UI asset updates with new SVG icon definitions (stethoscope, syringe, pill, test-tube, microscope, etc.)
- 🔧 Chores & Improvements: Minor UI TS/JS import tweak (ReactNode type addition and expanded Lucide icon set imports)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/703


## [0.1.0-alpha.202605131501.acc817f4] - 2026-05-13

- 🔧 Chores & Improvements: Version bumps across multiple packages to 0.1.0-alpha.202605131501.acc817f4
- ⚠️ Breaking Changes: Backend default ROLE_BASED_FILTERING_MODE changed from 'enforce' to 'audit-only' (invalid values clamped to 'audit-only')
- 🔧 Chores & Improvements: Backend refactor - removed Practitioner-specific role filtering; now only Patient-based filtering applies (tests updated accordingly)
- 📚 Documentation: Tests updated to reflect default audit-only mode and new filtering behavior

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/702


## [0.1.0-alpha.202605121710.8c4f2d1c] - 2026-05-12

- 🔧 Chores & Improvements: Update versions across apps/packages/docs to 0.1.0-alpha.202605121710.8c4f2d1c
- 🔧 Chores & Improvements: Backend: enable supportsClientAssertions: true check for proxy signing IdP configuration; tighten IdP existence criteria
- ⚠️ Breaking Changes: None
- 📚 Documentation: Add Federated JWT client authentication guide (new file)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/701


## [0.1.0-alpha.202605121707.0600c9d4] - 2026-05-12

- ✨ Features
  - None

- 🐛 Bug Fixes
  - Backend: adjust Keycloak flow copy call to use newName (no functional behavior changes beyond parameter name).

- 📚 Documentation
  - None

- 🔧 Chores & Improvements
  - Version bumps across multiple packages/apps (alpha → next beta/alpha sequence).
  - E2E/Smart-compliance workflow improvements: Playwright caching, install flow optimizations, and temporary directory usage.
  - Keycloak admin-service: ensure admin-service has manage-identity-providers role via service account (realm-export updated). 

- ⚠️ Breaking Changes
  - None

Note: Only changes since last release are included; no merge/metadata/update commits are listed as changes.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/700


## [0.1.0-beta.202605121343.f6981e3a] - 2026-05-12

- 🔧 Chores & Improvements: E2E workflow improvements (Playwright caching, conditional install, cache-hit flow) and Smart-compliance workflow refactor (setup in tmp, browser cache, global install, copy into workspace); CI/CD enhancements
- 🔧 Chores & Improvements: Version bumps across multiple packages/apps from alpha to beta
- ⚠️ Breaking Changes: Keycloak realm-export updated to include manage-identity-providers and view-identity-providers; init.ts ensures admin-service role via service account

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/699


## [0.1.0-alpha.202605121209.44813356] - 2026-05-12

- 🔧 Chores & Improvements: Bump package versions across apps/libs/tests to 0.1.0-alpha.202605121209.44813356
- 🔧 Chores & Improvements: Update Keycloak config endpoints to localhost:8445 (issuer/tokenUrl/authorizationUrl/jwksUrl)
- 🔧 Chores & Improvements: Add backend ensureProxySigningIdp() helper to support proxy-smart-signing IdP startup (handles missing admin creds)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/697


## [0.1.0-beta.202605121120.bc164c98] - 2026-05-12

- 🔧 Chores & Improvements: Bump versions across apps/libs/tests to 0.1.0-beta.202605121120.bc164c98
- 🔧 Chores & Improvements: Update Keycloak configuration URLs to localhost:8445 (issuer, tokenUrl, authorizationUrl, jwksUrl)
- 🔧 Chores & Improvements: Add ensureProxySigningIdp() helper to initialize proxy-smart-signing IdP during startup (handles missing admin creds)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/696


## [0.1.0-alpha.202605092005.e8c13449] - 2026-05-09

- 🔧 Chores & Improvements: Version bump to 0.1.0-alpha.202605092005.e8c13449 across multiple packages/apps
- 🔧 Chores & Improvements: Backend auth logic updated to treat all private_key_jwt usage as federated-jwt with proxy validation and re-signing; updated comments and global usage terms

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/692


## [0.1.0-alpha.202605091906.cb646698] - 2026-05-09

- 🔧 Chores & Improvements: Version bump from 0.1.0-beta to 0.1.0-alpha across multiple apps/packages
- ✨ Features: UI enhancements for smart flow cards in AuthFlowsManager (imports and state)
- 🔧 Chores & Improvements: Backend refactor to introduce a unified read-resource tool replacing multiple GET route tools; update MCP endpoint tool list and tool registration flow to use the unified read tool

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/691


## [0.1.0-alpha.202605091845.ecad3533] - 2026-05-09

- 🔧 Chores & Improvements: CI: swap SSH-based HTTP probing for Docker healthcheck in Keycloak readiness; add explicit healthy status check and clearer timeout error logs
- 🔧 Chores & Improvements: Update version bumps across apps, packages, and tests to 0.1.0-alpha.202605091845.ecad3533
- 🐛 Bug Fixes: Improve Keycloak readiness messages with clearer success/failure logs

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/690


## [0.1.0-alpha.202605091737.e7dae71a] - 2026-05-09

- 🔧 Chores & Improvements: Update CI deploy-beta health check to use HTTP/1.0 to prevent keep-alive hang
- 🔧 Chores & Improvements: Version bumps across apps/packages to 0.1.0-alpha.202605091737.e7dae71a
- 🔧 Chores & Improvements: Minor CI log formatting tweaks in deploy-beta workflow
- 🔧 Chores & Improvements: Version bumps across multiple components from 0.1.0-alpha.202605091133.d4798d2e to 0.1.0-beta.202605091527.c7e4e0f2 (note: includes apps, packages, and testing/e2e)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/689


## [0.1.0-beta.202605091527.c7e4e0f2] - 2026-05-09

- 🔧 Chores & Improvements: CI log quote fix in deploy-beta workflow; version bumps across apps, packages, and testing/e2e to v0.1.0-beta.202605091527.c7e4e0f2

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/688


## [0.1.0-beta.202605090914.34723e6c] - 2026-05-09

- 🔧 Chores & Improvements: Version bump across packages to 0.1.0-beta.202605090914.34723e6c
- 🔧 Chores & Improvements: UI refactor in AuthFlowsManager/SmartFlowsView to use Card components (Card, CardHeader, CardContent, CardTitle) and switch from viewMode to activeTab; update imports accordingly
- 🔧 Chores & Improvements: Minor package.json updates to reflect new version across apps

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/686


## [0.1.0-alpha.202605090009.02f9e031] - 2026-05-09

- 🔧 Chores & Improvements: Version bump to 0.1.0-alpha.202605090009.02f9e031 across multiple packages
- ⚠️ Breaking Changes: Update to authentication flow
  - Switch client-auth determination from client-jwt/none to federated-jwt for certain JWKS-based flows
  - Adjust JWKS handling for federated-jwt and backend-service scenarios
  - Add proxy-signing flow notes: federated-jwt path via proxy's signing identity
  - Introduce jwt.credential metadata for federated-jwt in client registrations
- 🔧 Chores & Improvements: Minor comments and documentation updates

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/683


## [0.1.0-alpha.202605082250.e9054b2a] - 2026-05-09

- 🔧 Chores & Improvements: Version bump to 0.1.0-alpha.202605082250.e9054b2a across multiple packages
- ⚠️ Breaking Changes: Rename Keycloak realm-export.json field from hideOnLoginPage to hideOnLogin

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/682


## [0.1.0-alpha.202605082226.dc9f9827] - 2026-05-08

- 🔧 Chores & Improvements: Version bumps across multiple packages/apps and testing config (no functional changes)
- 🔧 Chores & Improvements: Dockerfile.keycloak tweak to enforce http-relative-path constraint, enable --optimized build, and include cimd, token-exchange, client-auth-federated features; start with optimized and realm import

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/681


## [0.1.0-beta.202605082149.73713843] - 2026-05-08

- 🔧 Chores & Improvements: CI/CD and build optimizations
  - Dockerfile.keycloak: add http-relative-path constraint and --optimized flag; include features cimd, token-exchange, client-auth-federated; set path /auth to avoid feature-dropping rebuilds; start with optimized and realm import
  - Version bumps across apps/packages/testing/eslint-config to 0.1.0-beta.202605082149.73713843

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/680


## [0.1.0-alpha.202605081814.6aaf417a] - 2026-05-08

- 🔧 Chores & Improvements: Version bump to 0.1.0-alpha.202605081814.6aaf417a; introduce backend client assertion types and error handling; add assertion resolution and validation flows; enhance OAuth path to validate private_key_jwt assertions; minor test updates for new validation APIs

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/676


## [0.1.0-alpha.202605081332.adff1b56] - 2026-05-08

- 🔧 Chores & Improvements: Bump version to 0.1.0-alpha.202605081332.adff1b56 across multiple packages
- ⚠️ Breaking Changes: Backend: refine isBackendServicesRequest logic to enforce client_credentials flow for backend services with proper client_assertion checks
- 🐛 Bug Fixes: Backend: add tests for new edge cases (authorization_code reject, missing grant_type, wrong client_assertion_type, missing client_assertion)
- 🔧 Chores & Improvements: Minor code comments/docs added for backend-services.ts clarification

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/675


## [0.1.0-alpha.202605081235.d2514947] - 2026-05-08

- 🔧 Chores & Improvements: Bump version to 0.1.0-alpha.202605081235.d2514947; add eager runtime config loading on server init with Keycloak client credentials (loadRuntimeConfig) and error fallback.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/674


## [0.1.0-alpha.202605081215.8e6b1dd5] - 2026-05-08

- ✨ Features: None
- 🐛 Bug Fixes: None
- 📚 Documentation: None
- 🔧 Chores & Improvements:
  - CI/CD: Replace direct Keycloak realm checks with backend health status checks via /status; improved logging and error messages when unhealthy
  - Versioning: Standardize version bumps to new alpha tag 0.1.0-alpha.202605081201.5d503150 across multiple packages
- ⚠️ Breaking Changes: None

Note: No user-facing feature or breaking changes detected; changes are primarily CI improvements and version updates.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/673


## [0.1.0-alpha.202605081120.3cb9cd33] - 2026-05-08

- 🔧 Chores & Improvements: Update version strings across apps/packages to 0.1.0-alpha.202605081120.3cb9cd33
- 🔧 Chores & Improvements: Backend: add requestedScope to TokenContext, sanitize/store it; include in token context and introspection flow
- 🔧 Chores & Improvements: Backend OAuth: persist and reflect granular requestedScope in scopes via filterScopes (preserves user-specific scopes vs wildcards)
- 🔧 Chores & Improvements: ESLint config and related package.jsons updated for new alpha version
- ⚠️ Breaking Changes: None detected

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/672


## [0.1.0-alpha.202605081112.6bd7ebb8] - 2026-05-08

- ✨ Features: SMART v2 scope expansion and wildcard delegation
  - Introduced expandScopesToWildcards and integrated into authorize-interceptor to convert granular scopes to wildcard forms (e.g., user/*.read) with de-duplication and empty-input handling.
  - Added SMART v2 scope regex, isScopeGranted logic, and filterScopes to enforce granted scopes against requested SMART v2 scopes.
  - Token enricher supported new scope flow via input.requestedScope with filterScopes; fallback path preserved.

- 🐛 Bug Fixes: Improved SMART v2 scope handling and compatibility
  - Updated scope matching to support v2 operations (1-5 chars from cruds) and upmapping to v1 read/write via aliases.
  - Removed legacy fallbacks that granted read-by-id or search via any v2 scope.

- 📚 Documentation: CI/CD and config notes
  - Metadata/config: OpenID responses include client_id_metadata_document_supported; CIMD metadata test added to validate discovery endpoints.

- 🔧 Chores & Improvements: Version bumps and test coverage
  - Global version bumps across multiple packages/apps; added tests for new scope expansion and delegation logic.
  - Minor test/import cleanups to align with new expandScopesToWildcards.

- ⚠️ Breaking Changes: None detected in user-facing behavior.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/671


## [0.1.0-alpha.202605081100.bf771161] - 2026-05-08

- ✨ Features
  - SMART v2 scope expansion: add expandScopesToWildcards to convert granular scopes (e.g., user/Patient.read) to wildcard forms (user/*.read) and wire into authorize interceptor with de-duplication and empty input handling
  - SMART v2 scope delegation: introduce regex and impact logic to enforce granted scopes against requested SMART v2 scopes; token enricher uses requestedScope with filterScopes when available

- 🔧 Chores & Improvements
  - Bump global version across multiple packages/apps (0.1.0-alpha.202605081100.bf771161)
  - Minor test updates and imports adjustments to cover new scope expansion behavior

- ⚠️ Breaking Changes
  - None detected

- 📚 Documentation
  - None

- 🐛 Bug Fixes
  - None detected

If nothing meaningful beyond version bumps and minor UX tweak, would be: - 🔧 Chores & Improvements: Internal updates and maintenance

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/670


## [0.1.0-alpha.202605071424.5b35f4d6] - 2026-05-08

- ✨ Features
  - SMART v2 scope delegation support: add SMART_V2_SCOPE_RE, isScopeGranted logic (wildcard and alias handling), and filterScopes to enforce granted scopes against requested SMART v2 scopes.
  - Token enricher enhancement: prefer input.requestedScope with filterScopes when available; fallback to smart_scope path.

- 🐛 Bug Fixes
  - OpenID config responses: advertise client_id_metadata_document_supported: true in both discovery and config sections.
  - Improve login UX: Keycloak template tweak in error.ftl to show "Back to application" path when loginRestartFlowUrl is unavailable; remove old back-to-login flow.

- 📚 Documentation
  - Introduce CIMD metadata test file to validate discovery endpoint returns client_id_metadata_document_supported and proxy endpoints.

- 🔧 Chores & Improvements
  - Version bumps: update to 0.1.0-alpha.202605071418.acaba93 across multiple packages/apps.
  - Minor Freemarker comment/UX tweak in login error template.

- ⚠️ Breaking Changes
  - None detected in this release.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/668


## [0.1.0-alpha.202605062242.b30c5006] - 2026-05-07

- 🔧 Chores & Improvements: Bump versions across apps/libs to 0.1.0-alpha.202605062242.b30c5006
- 🔧 Chores & Improvements: API config updates in backend (renamed policies domains and updated CIMD config fields)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/667


## [0.1.0-alpha.202605062212.19f7b90d] - 2026-05-06

- 🔧 Chores & Improvements: Rename and normalize SMART launch context to patient_context/encounter_context; update token top-level claims and per-token context storage (TokenContextStore); adjust IAL/consent checks to reference patient instead of smart_patient; normalize fhir_user to fhirUser in introspection.

- 🔧 Chores & Improvements: Rename interfaces/types from smart_patient/smart_encounter to patient/encounter; update IAL config descriptions and tests to reflect patient claim verification and fallback paths.

- 🔧 Chores & Improvements: Update token context enrichment to derive per-token context from TokenContextStore; adjust introspection enricher to normalize fhir_user to fhirUser; remove KC-based approaches.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/666


## [0.1.0-alpha.202605062203.d6c04537] - 2026-05-06

- 🔧 Chores & Improvements: Version bump across frontend apps, backend tooling, ESLint config, packages, and tests

- 🐛 Bug Fixes: TokenContextStore gains security-focused constants and input validation; oauth route passes introspectingClientId to tokenContextStore.get for tighter binding

- 🐛 Bug Fixes: Tests extended to cover input validation, client binding, and PHI redaction; TTL/exp handling adjusted

- 📚 Documentation: Minor test data tweaks to align with new TTL/exp handling

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/665


## [0.1.0-alpha.202605061525.60d3a1a0] - 2026-05-06

- 🔧 Chores & Improvements: Version bumps to 0.1.0-alpha.202605061525.60d3a1a0 across multiple apps/libs
- 🔧 Chores & Improvements: Add backend token-context-store (TokenContextStore, interfaces) and unit tests
- 🔧 Chores & Improvements: Persist token launch context by JTI into token-context-store for SMART STU 2.2 introspection
- 🔧 Chores & Improvements: Integrate minimal oauth route updates to store context when jti and data exist

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/664


## [0.1.0-alpha.202605061443.968d6bdd] - 2026-05-06

- 🔧 Chores & Improvements: Version bump to 0.1.0-alpha.202605061443.968d6bdd across multiple packages/apps
- ⚠️ Breaking Changes: None detected
- 🐛 Bug Fixes: None detected
- 📚 Documentation: Keycloak realm-export.json: add introspection.token.claim: "true" for two clients
- ✨ Features: None detected

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/663


## [0.1.0-alpha.202605061427.fa5b001e] - 2026-05-06

- 🔧 Chores & Improvements: Bump versions across apps/packages to 0.1.0-alpha.202605061427.fa5b001e
- ✨ Features: Add introspection enrichment to derive patient from fhirUser when patient is missing (with scope-aware fallback)
- 🔧 Chores & Improvements: Minor code addition in introspection-enricher.ts to include scope field and new fallback behavior

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/662


## [0.1.0-alpha.202605042315.546a45f7] - 2026-05-06

- 🔧 Chores & Improvements: Version bump across all apps/packages to 0.1.0-alpha.202605042315.546a45f7; minor logic/schema tweaks for backend smart-apps (isPublicClient handling; publicClient description); tighten Keycloak endpoints in docker-compose.beta.yml; minor doc/comment updates and formatting

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/661


## [0.1.0-alpha.202605042239.042641ea] - 2026-05-04

- ✨ Features: Stabilized patient selection flow with robust selector based on data-testid, improving test reliability
- 🔧 Chores & Improvements: Minor UI/UX test accessibility improvements (data-testid additions for PatientRow and submit button)
- 🔧 Chores & Improvements: Version bumps across apps, packages, eslint config, and testing to 0.1.0-alpha.202605042239.042641ea

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/660


## [0.1.0-alpha.202605042113.61bf4e35] - 2026-05-04

- 🔧 Chores & Improvements: Version bump across multiple packages
- 🔧 Chores & Improvements: Backend session resolver now uses admin.getAccessToken() and updated test mock to include getAccessToken
- 🔧 Chores & Improvements: Test suite updated to mock AdminClient with getAccessToken() for new auth flow

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/659


## [0.1.0-alpha.202605042106.ee673668] - 2026-05-04

- ✨ Features: Auto-select patient on Patient Picker page during OAuth flow; increased retry attempts (maxAttempts 3 → 5) for interstitial handling
- 🔧 Chores & Improvements: Version bumps across multiple packages from beta to alpha; UI refactor: BackendServicesSettings.tsx removed; minor UI tweaks in SmartConfigManager (icon imports, tab layout)
- 🔧 Chores & Improvements: Backend/Keycloak: enhanced direct session lookup in kc-session-resolver and updated session resolution flow; admin Keycloak config schema updated to remove frontend URL endpoints; related docs/tests adjusted for fast-path behavior

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/658


## [0.1.0-beta.202605041920.0a9225e5] - 2026-05-04

- ✨ Features
  - 🧪 Introduced Kubernetes Admin client factory and dependency injection for admin interactions in kc-session-resolver (-admin factory, DI-based admin client retrieval, optional adminClientFactory parameter)  
  - 🧰 Session handling enhancements: add session expiration handling in patient-picker (SessionExpiredError, onSessionExpired callback, automatic redirect and UI for "Session Expired")

- 🔧 Chores & Improvements
  - 🔧 Refactor: move admin client creation to kc-admin-factory and update tests to mock via factory; update imports and typing accordingly
  - 🔧 Minor UI/logic tweaks in patient-picker (icon/log/icon usage adjustments, code cleanliness)
  - 🔧 Version bumps across packages (0.1.0-alpha and related beta tag) to reflect pre-release changes
  - 🔍 Logging improvements in kc-session-resolver (additional warnings/info about client not found, page scans, and session matches)

- ⚠️ Breaking Changes
  - None detected for end users; internal DI changes to admin client retrieval and test structure

- 📚 Documentation
  - None identified

If you want a shorter version or a different grouping, tell me.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/657


## [0.1.0-alpha.202605041920.0a9225e5] - 2026-05-04

- ✨ Features
  - Admin client integration via dependency injection: introduce AdminClientFactory and DI-based admin client retrieval in kc-session-resolver.ts (with default factory and updated usage). 
  - Session management: add session expiration handling in fhir-client.ts and propagate session expiry through PatientList; UI supports “Session Expired” and automatic redirect after expiry.

- 🔧 Chores & Improvements
  - Version bumps across multiple packages to 0.1.0-alpha.202605041233.3ec8a557 (and related alpha bumps).
  - Logging enhancements in kc-session-resolver.ts (warnings/info when client not found, start of scans, session match, and additional debug traces).
  - UI/UX tweaks in patient-picker (icon and minor import/logic adjustments).

- ⚠️ Breaking Changes
  - None detected. (If admins client now provided via DI, ensure DI wiring is updated in consuming modules.)

- 📚 Documentation
  - None detected.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/656


## [0.1.0-alpha.202605041846.e4c9b30c] - 2026-05-04

- ✨ Features
  - Introduce AdminClientFactory and dependency-injected admin client retrieval in kc-session-resolver.ts; new kc-admin-factory.ts to create/authenticate admin client (getAdminClient).

- 🔧 Chores & Improvements
  - Refactor to use adminClientFactory for DI; update tests to inject admin client via DI.
  - Bump versions across multiple packages to 0.1.0-alpha.202605041233.3ec8a557 / 0.1.0-alpha.202605040015.fa874161 as part of pre-release prep.
  - Add and enhance session expiration handling in patient-picker: introduce SessionExpiredError, propagate onSessionExpired, and UI/state handling for automatic redirect and “Session Expired” notice.

- 🐛 Bug Fixes
  - Session expiration flow improvements and related UI/logic adjustments.
  - Logging enhancements in kc-session-resolver.ts for better visibility when client is not found, scans start, and session matches occur.

- 📚 Documentation
  - None substantial beyond internal DI and test strategy notes (implicit in code changes).

- ⚠️ Breaking Changes
  - None identified for end users. Internal API changes to admin client retrieval via DI.

If you want a shorter version, I can trim further.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/655


## [0.1.0-alpha.202605041233.3ec8a557] - 2026-05-04

- ✨ Features
  - Session management: add session expiration handling in patient-picker with SessionExpiredError, onSessionExpired callback, and automatic redirect + UI for “Session Expired”.

- 🔧 Chores & Improvements
  - Version bumps: align versions across multiple packages/apps.
  - Minor UI/logic tweaks in patient-picker (icon and hook usage refinements).
  - Backend logging enhancements: add warnings/info when client not found, start scans, and log session match events for kc-session-resolver.
  - Keycloak: update realm permissions in realm-export.json (view-users, query-users, manage-users, ensure manage-realm).

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/653


## [0.1.0-alpha.202605041031.b5f9cef6] - 2026-05-04

- ✨ Features
  - Minor log message enhancements and expanded diagnostics in backend kc-session-resolver.ts (warnings/info when client not found, page scans, session match; added debug traces)

- ⚠️ Breaking Changes
  - No breaking changes

- 🔧 Chores & Improvements
  - Version bumps across multiple packages/apps to 0.1.0-alpha.202605041031.b5f9cef6
  - Updated Keycloak realm-export.json permissions (add view-users, query-users, manage-users; ensure manage-realm)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/652


## [0.1.0-alpha.202605032340.faa198e5] - 2026-05-04

- 🔧 Chores & Improvements: Bump version to 0.1.0-alpha.202605032340.faa198e5 across multiple apps/packages (consent-app, dtr-app, patient-picker, patient-portal, patient-portal/package, smart-dicom-template, ui, eslint-config, auth, testing/e2e)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/651


## [0.1.0-alpha.202605032311.11fc5699] - 2026-05-03

- ✨ Features
  - UI/back-end: add favicon link in index.html
  - Auth: fallback in callback-handler to resolve patient from session.fhirUser when auto-resolve fails

- 🔧 Chores & Improvements
  - Auth: update TS config to exclude test files from compilation
  - Auth: added new test file for callback-handler (patient picker gate) with fallback scenarios

- ⚠️ Breaking Changes
  - (none)

- 📚 Documentation
  - (none)

- 🐛 Bug Fixes
  - KC-session-resolver: store session.fhirUser on session during auto-resolve

Note: Version bumps across multiple packages applied (0.1.0-beta... to 0.1.0-alpha...).

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/650


## [0.1.0-alpha.202605032256.b5a9856f] - 2026-05-03

- ✨ Features
  - Patient picker: initialize on mount with loadPage(0) and improved resource type casting
  - FHIR client: refactored to session-validated /auth/patient-search flow with getSearchUrl and fetchBundle
  - Backend: added /patient-search OAuth-protected endpoint logic (session validation and aud parsing) to proxy to FHIR server

- 🔧 Chores & Improvements
  - Version bumps across multiple packages to 0.1.0-alpha.202605032256.b5a9856f
  - Fix CSS import source paths to local node_modules for shared UI across several apps
  - Update docs: Admin UI and Patient Picker docs; update docs/index.md with new features and Shared UI Library notes

- 📚 Documentation
  - Admin UI and Patient Picker docs added; docs/index.md updated with feature entries and Shared UI Library notes

- ⚠️ Breaking Changes
  - None detected

- 🐛 Bug Fixes
  - CSS path fixes to ensure local module imports work across apps

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/649


## [0.1.0-alpha.202605032155.b401b02a] - 2026-05-03

- ✨ Features: Global alias migration to @proxy-smart/shared-ui across apps/libs; updated UI component imports (Button, Card, Tabs, etc.) and docs/assets to reflect new shared-ui package. 
- 🔧 Chores & Improvements: Dependency alignment and version bumps to alpha 0.1.0-alpha.202605032155.*; updates to bun.lock and test/import references to match new UI alias.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/648


## [0.1.0-alpha.202605032120.8346c70b] - 2026-05-03

- ✨ Features
  - Patient Picker: add pagination state and listPatients fetch; fhir-client now exposes listPatients with offset-based pagination and Bundle type
  - Backend auth: auto-inject proxy SMART callback URI into redirectUris to support proxy interception

- 🔧 Chores & Improvements
  - CI: add new build steps for smart-compliance-tests (Build Patient Picker (static), Copy Apps to Backend)
  - Docker: copy shared config into image; restrict docker-workspaces subset; copy config/ into image
  - Version bumps across multiple packages/apps/libs to 0.1.0-alpha.x (then prep for beta)

- ⚠️ Breaking Changes
  - Consent-app and DTR-app refactors to SmartAppShell; removal of previous header/auth flow wiring (affects auth flow usage)

- 📚 Documentation
  - (No explicit documentation changes detected)

- 🐛 Bug Fixes
  - (No user-facing bug fixes detected)

Note: Merges, metadata-only updates, and non-meaningful “update” commits are skipped.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/647


## [0.1.0-beta.202605032049.bd54d5fb] - 2026-05-03

- ✨ Features
  - Add listPatients with offset-based pagination in fhir-client and expose in UI PatientPicker (with pagination state and fetch listPatients)

- 🔧 Chores & Improvements
  - Bump all package.json versions from alpha to beta across apps, libs, and testing
  - Add shared Vite config copy in Dockerfile
  - Copy config/ into Docker image
  - Restrict docker-workspaces to a smaller subset (remove shared-ui, patient-portal, etc.)
  - Backend auth: auto-inject proxy SMART callback URI into redirectUris to support proxy interception

- ⚠️ Breaking Changes
  - None detected

- 📚 Documentation
  - None detected

- 🔧 Other
  - Version bumps for Consent, DTR, Patient Picker tests/apps

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/646


## [0.1.0-alpha.202605031909.22b57f72] - 2026-05-03

- ✨ Features: None detected

- 🐛 Bug Fixes: None detected

- 📚 Documentation: None detected

- 🔧 Chores & Improvements:
  - Bump all package.json versions to 0.1.0-alpha.202605031909.22b57f72 across multiple apps/packages
  - Add/update devDeps in root: @tailwindcss/vite and @vitejs/plugin-react-swc
  - Replace shared UI references: switch imports from @proxy-smart/shared-ui to @proxy-smart/shared-ui across apps
  - Rewire app configuration imports to reference config/ instead of shared-ui paths
  - Update deployment/test workflow logic: adjust stage mappings (alpha now dev-only), e2e/test inputs, and targeted deployment steps

- ⚠️ Breaking Changes: None detected

If you intended more granular grouping, I can adjust.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/644


## [0.1.0-alpha.202605031824.bbd27301] - 2026-05-03

- 🔧 Chores & Improvements: Update shared UI package references to forked version and adjust imports (several apps), plus rewire configuration paths and app config imports
- 🔧 Chores & Improvements: Update deployment/test workflows for alpha/dev handling (alpha becomes dev-only) and adjust e2e/test inputs to run locally/dev for alpha

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/643


## [0.1.0-alpha.202605031820.02615011] - 2026-05-03

- ✨ Features
  - Patient picker: add aud parameter support and propagate through UI, config, and FHIR fetch usage; require aud in App.tsx and pass to PatientList
  - Picker params: extend to return aud; validation now requires session, code, and aud
  - Backend: forward aud through OAuth flow to picker; smart-templates render with provided FHIR base URL and fetch against it
- 🔧 Chores & Improvements
  - Refactor: fhir-client.ts to create reader per base URL
  - Types: LaunchSession augmented with aud field
- 📚 Documentation
  - (No explicit docs changes detected)
- ⚠️ Breaking Changes
  - (No breaking changes detected)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/642


## [0.1.0-alpha.202605031802.6d2b954a] - 2026-05-03

- ✨ Features: 
  - Patient picker now supports aud parameter propagation through UI, config, and FHIR fetch usage; App.tsx and PatientList.tsx updated to pass and utilize fhirBaseUrl. 
  - Picker params now return aud; validation requires session, code, and aud.
  - OAuth flow updated to forward aud to picker; smart-templates render with provided FHIR base URL.

- 🔧 Chores & Improvements:
  - Refactor: fhir-client.ts updated to create reader per base URL; Types.LaunchSession augmented with aud.

Note: Version bump included across repo.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/641


## [0.1.0-alpha.202605031756.2732f9a0] - 2026-05-03

- ✨ Features:
  - Patient picker: add aud parameter support and propagate through UI, config, and FHIR fetch usage
  - Picker params: return aud; require session, code, and aud for validation
  - Backend: forward aud through OAuth flow to picker; smart-templates render with provided FHIR base
  - Types: LaunchSession augmented with aud field

- 🔧 Chores & Improvements:
  - Refactor: fhir-client.ts to create reader per base URL
  - App wiring: PatientList.tsx updated to accept fhirBaseUrl and use it for searches
  - App wiring: Patient picker App.tsx updated to require aud and pass to PatientList

- ⚠️ Breaking Changes:
  - None detected

- 📚 Documentation:
  - None detected

- 🐛 Bug Fixes:
  - None detected

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/640


## [0.1.0-beta.202605031718.19041127] - 2026-05-03

- ⚠️ Breaking Changes
  - None detected

- ✨ Features
  - Patient picker: add aud parameter support and propagate through UI, config, and FHIR fetch usage
  - Picker: extended to return aud

- 🐛 Bug Fixes
  - None detected

- 🔧 Chores & Improvements
  - App.tsx now requires aud and passes it to PatientList; PatientList.tsx accepts fhirBaseUrl and uses it for searches
  - fhir-client.ts refactored to create a reader per base URL
  - Backend OAuth flow now forwards aud to picker
  - Smart-templates render with provided FHIR base and fetch against it
  - Types: LaunchSession augmented with aud field
  - Version bump across repo

- 📚 Documentation
  - None detected

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/639


## [0.1.0-beta.202605031618.8061482e] - 2026-05-03

- ✨ Features: 
  - UI: Manage externalAudiences in AccessControlSettings (state and add/remove flows)
  - Backend config: support externalAudiences in runtime config and config getters; OAuth audience validation updated for external audiences and subdomain wildcard

- 🐛 Bug Fixes:
  - Backend: OAuth audience validation updated to accommodate external audiences and wildcards

- 🔧 Chores & Improvements:
  - Dockerfile: include packages/auth in build and workspace pruning; copy auth package into build contexts; propagate auth in backend-build and openapi-gen stages
  - Version bumps: bump multiple apps/packages from alpha to beta

- 📚 Documentation:
  - Schemas: SmartAccessControlConfig now includes externalAudiences with description

- ⚠️ Breaking Changes:
  - (none)

- Note: Excludes update/merge/metadata commits per guidelines.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/636


## [0.1.0-beta.202605031204.060ce013] - 2026-05-03

- ✨ Features: Add SMART launch context handling enhancements, including in-memory launch-context-store with TTL and Redis hint, and SMART client config cache with TTL and invalidation utilities
- ✨ Features: Enrichment improvements to resolve patientFacing flag for fhirUser (true/false/undefined)
- 🔧 Chores & Improvements: Admin UI/API updates to support fhirUser and patientFacing in smart apps schema; cache invalidation on update
- 🔧 Chores & Improvements: OAuth callback updates to include SmartCallbackQuery schema and integrate launch-context-store and smart client in routes
- 🧪 Features (testing): EHR launch tests note about pre-registered codes and context sourcing from signed launch code via POST /auth/launch

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/634


## [0.1.0-beta.202605030722.9169611c] - 2026-05-03

- 🔧 Chores & Improvements: Bump version fields across all packages to 0.1.0-beta.202605030722.9169611c; minor backend comment tweaks and JWKS handling clarifications (inline JWKS/PEM alg detection).

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/631


## [0.1.0-beta.202605021852.b4e1d881] - 2026-05-02

- ✨ Features: Persist SHL sessions with SQLite, fix expiration, hide app store in shared view (quotentiroler)
- 🔧 Chores & Improvements: Update all outdated packages (quotentiroler)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/628


## [0.1.0-alpha.202605021846.96e0e538] - 2026-05-02

- ✨ Features: 
  - Add URL shortening opt-in for SHL QR flows (shortenUrl and maxUses support in frontend, payload, and backend; API schema updated)
  - Dynamic CORS origins support derived from Keycloak webOrigins with 5-minute cache; isOriginAllowed uses merged static+dynamic origins

- 🔧 Chores & Improvements:
  - Wire refreshCorsOrigins() across app init and admin/user flows to keep origins up to date
  - Minor workflow and docker-compose tweak removing maxhealth.tech from allowed CORS origins
  - Integrate new cors-origins module across app factory, init, and routes (admin smart-apps, auth client-registration)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/626


## [0.1.0-alpha.202605021839.15271362] - 2026-05-02

- 🔧 Chores & Improvements: Introduce dynamic CORS origins from Keycloak webOrigins with 5-minute cache; replace static CORS_ORIGINS logic with isOriginAllowed based on merged static+dynamic origins; wire refreshCorsOrigins() into app init and admin/user flows; import/use new cors-origins module across app factory, init, and routes (admin smart-apps, auth client-registration); minor workflow/docker-compose tweak removing maxhealth.tech from allowed origins.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/625


## [0.1.0-alpha.202605021830.ca96449b] - 2026-05-02

- 🔧 Chores & Improvements: Update CORS origins to include maxhealth.tech in beta deployment (deploy-beta.yml, docker-compose.beta.yml)
- 🐛 Bug Fixes: Improve viewer app selection logic:
  - Default value now "__none__" when none chosen
  - Empty string maps to "__none__" on change
  - Include only enabled apps with non-empty clientId and render items by clientId

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/623


## [0.0.9-alpha.202605021737.9eb9882b] - 2026-05-02

- 🔧 Chores & Improvements: Bump version to 0.0.9-alpha.202605021737.9eb9882b across packages/apps
- 🐛 Bug Fixes: Patient-portal DicomViewer.tsx fix — open in app when viewerApp is present and always show "open in app" label using viewerApp.name

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/622


## [0.0.9-alpha.202605021730.c2652a64] - 2026-05-02

- 🔧 Chores & Improvements: Version bump to 0.0.9-alpha.202605021730.c2652a64 across packages
- 🔧 Chores & Improvements: Update ignore rules to allow DICOM files under deploy/dicom
- ✨ Features: Add Keycloak realm client "dicom-viewer" with OpenID Connect settings and scopes
- ✨ Features: Include new binary deploy/dicom/CTImage.dcm

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/621


## [0.0.9-alpha.202605021709.cf0c5f80] - 2026-05-02

- ✨ Features: Version bump to 0.0.9-alpha.202605021709.cf0c5f80 across multiple packages; updated repository URLs and homepage references
- 🔧 Chores & Improvements: Deploy-beta workflow improvement for DICOM copy logic (copy all .dcm when directory exists and contains .dcm); seed-dicom.sh handles empty directory
- 🔧 Chores & Improvements: OAuth /aud validation refactor to use faster prefix checks and MCP endpoint path, avoiding expensive server checks

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/620


## [0.0.9-alpha.202605011807.e7d41bb1] - 2026-05-02

- ✨ Features: 
  - Add DICOM Viewer multi-server support hooks, including new ChartRenderer and lazy-loaded integration in HealthChartsCard
  - Implement server-scoped DICOMweb client with serverId plumbing across ImagingStudyCard, DicomViewer, and Dicomweb routes
  - DicomServers UI enhancements: new AUTH_TYPES constants, DicomServerDetails/Overview, extended DicomServerCard, lazy-loaded HealthChartsCard, onViewDetails with serverId propagation
  - DicomServersManager refactor to lazy-load cards, add details/overview components, and improve server/client wiring
  - SHL flow enhancement: optional shortUrl via URL shortener; SHL returns shortUrl when available
  - DICOM viewer app wiring improvements to associate with serverId

- 🔧 Chores & Improvements:
  - Updated DICOM server thumbnail wiring to include serverId
  - General lazy-loading and wiring optimizations across DICOM components

Note: No breaking changes detected; no documentation or bug-fix items identified in provided diffs.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/619


## [0.0.9-alpha.202605011803.e740003b] - 2026-05-01

- 🔧 Chores & Improvements: Version bumps across multiple apps/configs (0.0.9-beta → 0.0.9-alpha) and 0.0.9-alpha → 0.0.9-beta.  
- 🐛 Bug Fixes: Harden JWKS handling in backend to support isBackendService or client-jwt for jwksUri/jwksString, and ensure jwksString/jwksUri are included when publicKey/jwksString/jwksUri are present in body for backend services.  
- 🔧 Chores & Improvements: Align client-registration and backend authentication flows to use client-secret where appropriate; minor JWKS handling adjustments.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/618


## [0.0.9-alpha.202605011334.786d5900] - 2026-05-01

- ✨ Features
  - Add per-process EHR Launch support: default fallback, new launch code config (launchSecret, launchCodeTtlSeconds), and new launch-code.ts with payload/context and JWT signing/verification. Includes updated OAuth routes/schemas and EhrLaunchRequest/Response types. (backend; tests for EHR Launch flow)

- 🔧 Chores & Improvements
  - Bump version strings across multiple packages to 0.0.9-alpha.202605011334.786d5900 (and related prior bumps in 0.0.9-alpha.202605011236.25453c95 / df545ab1) ensuring consistency across consent-app, dtr-app, patient-portal, smart-dicom-template, ui, eslint-config, testing/e2e, and generated package.
  - Switch Keycloak authentication: backend/admin now uses client_secret instead of client-jwt for Keycloak integration; backend/auth adjusted accordingly; Keycloak realm-export updated. Added secret for AI Assistant Agent.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/616


## [0.0.9-alpha.202605011236.25453c95] - 2026-05-01

- ✨ Features
  - Introduce per-process EHR Launch code support: new launch code config (launchSecret, launchCodeTtlSeconds), LaunchCodePayload/Context, JWT signing/verification, and EHR Launch 2.2.0 schema/types.
  - Add service-account admin

- 🐛 Bug Fixes
  - Adjust Keycloak authentication flow: switch from client_jwt to client-secret (backend/admin and backend/auth) and update tests accordingly.

- 🔧 Chores & Improvements
  - Bump version strings across multiple packages to 0.0.9-alpha.202605011236.25453c95.
  - Update OAuth routes/schemas to include EhrLaunchRequest/Response types and related signing/verification imports.
  - Update Keycloak realm-export.json to reflect clientAuthenticatorType change and add AI Assistant Agent secret; remove tokenEndpointUrl.

Notes:
- Excludes update/merge/metadata commits per guidelines.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/615


## [0.0.9-alpha.202604302305.da2c1b18] - 2026-05-01

- 🔧 Chores & Improvements: Internal maintenance and refactoring across admin smart-apps, backend-services auth, oauth, and tests
- 🐛 Bug Fixes: JWKS update logic now auto-sets jwtClientAuthentication.tokenEndpointUrl; ensure proper ClientMetadata cache handling
- ✨ Features: Added ClientMetadata cache type and updated caches to store ClientMetadata; new warning log for non-backend-services requests containing client_assertion; backend services detection handler path
- 📚 Documentation: Keycloak realm-export updated with jwtClientAuthentication.tokenEndpointUrl entry
- ⚠️ Breaking Changes: None identified

Note: No non-meaningful or purely update/merge commits included.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/614


## [0.0.9-alpha.202604302300.35715d6b] - 2026-04-30

- ✨ Features
  - ShlView.tsx: enhanced error UI for expired SHL with new icons and translations; additional lucide-react icons imported.
- 🐛 Bug Fixes
  - Backend: refined CORS origin logic to allow dicomweb paths directly and whitelist otherwise.
  - Keycloak-config: improved error handling with try/catch and handleAdminError.
  - auth/backend-services: added JWT replay protection.
- 🔧 Chores & Improvements
  - Bump and synchronize versions across multiple packages/apps/configs.
  - Minor consistency: updated type annotation in app-factory.ts.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/613


## [0.0.9-beta.202604302110.bc07682c] - 2026-04-30

- 🔧 Chores & Improvements: Internal updates and maintenance

- ✨ Features:
  - DTR/Consent/Portal UI: enhanced error UI for expired SHL with new icons and translations; updated icon set usage.

- 🐛 Bug Fixes:
  - Backend:
    - CORS: refined origin logic to allow dicomweb paths directly and otherwise whitelist origins.
    - Keycloak-config: improved error handling by wrapping in try/catch and using handleAdminError.
    - auth/backend-services: added JWT replay protection.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/612


## [0.0.9-alpha.202604301738.a2ee7edc] - 2026-04-30

- 🔧 Chores & Improvements: Bump all package.json versions to 0.0.9-alpha.202604301738.a2ee7edc across apps, UI, backend, and testing
- 🔧 Chores & Improvements: Make updatedScopes immutable in backend/admin smart-apps.ts
- 📚 Documentation: Add JsonObject/JsonValue types in sanitize-openapi.ts for OpenAPI parsing

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/610


## [0.0.9-alpha.202604301056.b2972881] - 2026-04-30

- ✨ Features: Frontend UI for BackendServicesSettings (URL management) with load/save flow and error handling
- 🔧 Chores & Improvements: Adjust SmartConfigManager to support BackendServicesSettings and upgrade Tabs grid; minor UI import tweaks (Globe icon)
- 🔧 Chores & Improvements: Extend admin API to support POST for admin calls
- 🔧 Chores & Improvements: Backend: add Keycloak frontend URL endpoints and types (GET /frontend-url, related request/response schemas)
- 🔧 Chores & Improvements: Backend: enhance frontend-url retrieval logic via Keycloak admin client with proper error handling (401/404)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/609


## [0.0.9-beta.202604300242.fd141e34] - 2026-04-30

- 🔧 Chores & Improvements: Dependency bumps and alignment
  - Bump versions to 0.0.9-beta.202604300242.fd141e34 across apps/packages
  - Add Vue 3 dependency (vue ^3.5.32) in bun.lock and root package.json; align related spread
  - Remove stray @vue/server-renderer references from root and bun.lock
  - Ensure vue dependency appears where previously missing in bun.lock/root package.json

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/607


## [0.0.9-alpha.202604300208.b08206e4] - 2026-04-30

- ✨ Features
  - Backend: JWKS handling improvements with JwkKey interface and widened getClientJwks/JWKS types for better flexibility

- 🔧 Chores & Improvements
  - CI/CD: Bump Bun to 1.3.13 across actions and Dockerfiles (base, builder, runner) and update related images
  - Code quality: minor TypeScript formatting and comments for JWKS handling

- ⚠️ Breaking Changes
  - None

- 📚 Documentation
  - None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/605


## [0.0.9-alpha.202604300118.38a52ce6] - 2026-04-30

- 🔧 Chores & Improvements: Improve OAuth token parsing by adding a custom body parser for application/x-www-form-urlencoded (URLSearchParams) to fix form-parser bug with base64url JWTs
- ✨ Features: Add integration tests for form body parsing and JWT handling (preserve client_assertion_type when client_assertion is a real RS384 JWT)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/604


## [0.0.9-alpha.202604300054.7d016d52] - 2026-04-30

- 🔧 Chores & Improvements: Improve OAuth token endpoint to correctly parse application/x-www-form-urlencoded bodies using URLSearchParams; add integration tests validating form body parsing and preservation of client_assertion_type for RS384 JWTs.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/603


## [0.0.9-alpha.202604300020.0341d81f] - 2026-04-30

- 🔧 Chores & Improvements: Improve OAuth token parsing by adding a custom body parser for application/x-www-form-urlencoded using URLSearchParams; update tests to cover form body parsing and client_assertion preservation with RS384 JWTs

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/602


## [0.0.9-alpha.202604291854.5d6050bc] - 2026-04-30

- ✨ Features
  - UI: RegisteredScopes component and SMART scope badges/UI integrated into ScopeManager
  - Backend: SMART scopes feature with CRUD endpoints and admin routes
  - Backend: Extended realm export to include SMART v2 scopes and related UI/config support

- 🐛 Bug Fixes
  - Backend: Replace jwks-rsa with built-in crypto for JWK→PEM conversion; add createPublicKey usage

- 🔧 Chores & Improvements
  - Tests: Scope backend config mocking scoped via Proxy; suppress logger in tests
  - Minor UI/code imports: ScopeManager imports and translation/hooks adjustments
  - Version/CI: Version bump across packages

- ⚠️ Breaking Changes
  - None detected

- 📚 Documentation
  - None detected

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/601


## [0.0.9-alpha.202604291410.81639e41] - 2026-04-29

- ✨ Features
  - 🧪 Auto-PR: Merge develop → test

- 🐛 Bug Fixes
  - Backend: Replace jwks-rsa with built-in crypto for JWK→PEM conversion; add createPublicKey usage and PEM export
  - UI: Minor UI tweaks (Undo2 icon import in HealthcareUserEditForm; PendingIdP* types and related updates)

- 🔧 Chores & Improvements
  - Version bump across multiple packages for 0.0.9-alpha.202604291402.356eaf91
  - Scope/Smart scopes: integrate RegisteredScopes into ScopeManager and admin smart-scopes support
  - Backend: extend realm export to include SMART v2 scopes
  - Tests: scope backend config mocking via Proxy; new backend test scaffolding for token flows

- 📚 Documentation
  - (No explicit docs changes identified)

- ⚠️ Breaking Changes
  - (No breaking changes detected)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/600


## [0.0.9-alpha.202604291402.356eaf91] - 2026-04-29

- 🔧 Chores & Improvements: CI/CD and maintenance across multiple packages
  - Minor UI updates: added Undo2 icon import and pending IdP operation types; export and integrate PendingIdPOperation in HealthcareUserEditForm/UsersManager
  - Backend: replace jwks-rsa with built-in crypto for JWK→PEM conversion; add createPublicKey usage and PEM export
  - Tests: introduce backend-services test suite with RSA keys, JWKS mock, and fetch mocking to cover token flow

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/599


## [0.0.9-alpha.202604282343.fd4ad718] - 2026-04-29

- 🔧 Chores & Improvements: Replace jwks-rsa usage with built-in crypto for JWK→PEM conversion in verifyJwtSignature; add createPublicKey import and support for PEM export
- 🧪 Features: Added backend tests for JWT/token flow with RSA keys and JWKS mock (backend/test/backend-services.test.ts)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/598


## [0.0.9-alpha.202604282337.e7f0fd37] - 2026-04-28

- ✨ Features: 
  - UI/admin: Support federated identities and IdP linking/unlinking; added federatedIdentities and onLinkIdP/onUnlink props.
  - Admin/identity providers: Fetch and attach parallel userCounts to providers.

- 🔧 Chores & Improvements:
  - Metrics/logging: Introduced UTC-based sparse hourly bucketing and in-memory event utilities; added monitoring thresholds.
  - General: Version bumps across multiple apps/components to 0.0.9-alpha.202604282337.e7f0fd37.

- 🚧 Documentation:
  - (No explicit docs changes detected.)

- ⚠️ Breaking Changes:
  - (No breaking changes detected.)

- 🐛 Bug Fixes:
  - (No specific user-facing bug fixes detected.)

Note: Only changes since last release included; merge/update commits omitted.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/597


## [0.0.9-alpha.202604280055.22eda139] - 2026-04-28

- ✨ Features: Added federated identities support in UI admin forms with IdP linking/unlinking capabilities; IdP responses now include user counts and fetched in parallel. 
- 🔧 Chores & Improvements: Refactored hourly metrics bucketing to UTC-based sparse buckets; introduced in-memory event utilities and monitoring thresholds for enhanced observability. 
- 🔧 Chores & Improvements: Version bumps across multiple apps to 0.0.9-alpha → 0.0.9-beta in preparation for release. 
- ⚠️ Breaking Changes: None detected.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/596


## [0.0.9-alpha.202604272029.bb4d43c9] - 2026-04-27

- 🧪 ⚠️ Breaking Changes: Runtime config now only syncs displayName with name; removed building of HTML badge/logo in realm displayNameHtml (affects KC realm export and display). Plain text displayName maintained.
- 🔧 Chores & Improvements: Added proxy-smart brand.css and integrated into theme styles for login; new CSS to render a heart icon and customize realm name visuals.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/594


## [0.0.9-alpha.202604272012.f4f1f7b3] - 2026-04-27

- 🔧 Chores & Improvements: Remove service-account fallback flow; always use caller's Bearer token and drop service-account cache and admin logic. Update RBAC enforcement documentation to reflect direct token-based checks.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/593


## [0.0.9-alpha.202604272007.ad815d0a] - 2026-04-27

- 🔧 Chores & Improvements: Version bumps across multiple packages to 0.0.9-alpha.202604271326.1163fe78
- 🔧 Chores & Improvements: .dockerignore adjustments to preserve Keycloak themes directory while excluding other data; realm-export files remain unignored
- ✨ Features: UI: BrandSettings exports new theme option "proxy-smart"
- 🔧 Chores & Improvements: Various package.json updates to align with new alpha version

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/592


## [0.0.9-alpha.202604271402.ef62ac9b] - 2026-04-27

- ✨ Features: UI option added — BrandSettings now exports a new theme option "proxy-smart".
- 🔧 Chores & Improvements: Adjusted .dockerignore to preserve Keycloak themes directory while excluding other Keycloak data; updated multiple package.json files to align with new alpha version.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/591


## [0.0.9-alpha.202604260219.72c2f545] - 2026-04-27

- ✨ Features: Custom Keycloak login theme support
  - Add custom login theme files (proxy-smart), IdP icons infrastructure (idp-icons.css, social-providers.ftl), and theme.properties wiring for login styles.

- 🔧 Chores & Improvements: Version bumps and packaging updates
  - Bump versions across multiple packages/apps (consent-app, dtr-app, patient-portal, eslint-config, smart-dicom-template, ui, testing/e2e) to alpha with timestamped tag.

- ⚠️ Breaking Changes: None detected

Note: No user-facing changes beyond branding/theme customization and version updates.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/590


## [0.0.9-alpha.202604260157.83fc33d8] - 2026-04-26

- 🔧 Chores & Improvements: CI workflow tightened to run feature-branch tests only on dev/develop and alpha flows; prevent direct pushes to main/test/beta to avoid deployment race; alpha deploy via Northflank auto-deploy on push
- 🔧 Chores & Improvements: Version bumps standardized to 0.0.9-alpha.202604260157.83fc33d8 across multiple packages (consent-app, dtr-app, patient-portal, ui, patient-portal package, eslint-config, testing/e2e, and several apps/templates)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/589


## [0.0.9-alpha.202604260114.bfb2c188] - 2026-04-26

- 🔧 Chores & Improvements: CI workflow cache key rename and new “Install Inferno Gems” step; remove DB setup cache-conditional logic
- 🔧 Chores & Improvements: Bump versions across all packages (consent-app, dtr-app, patient-portal and nested package.jsons; eslint-config; testing/e2e) to 0.0.9-alpha.202604260114.bfb2c188

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/588


## [0.0.9-alpha.202604260015.56fd77e4] - 2026-04-26

- 🔧 Chores & Improvements: Remove Inferno PostgreSQL service and associated health config; pin Inferno version to v0.6.4 with notes on compatibility and future migration; clarify Redis usage for Sidekiq (dedicated service)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/587


## [0.0.9-alpha.202604252254.403d4d46] - 2026-04-26

- 🔧 Chores & Improvements: Version bumps across packages to 0.0.9-alpha.202604252202.6b15be32; general typings hardening and null-safety improvements; safer optional chaining; broader/stricter typing in UI, backend, Keycloak, and DICOM routes; ESLint no-explicit-any raised to error; minor refactors in app discovery and organization representations.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/586


## [0.0.9-alpha.202604252202.6b15be32] - 2026-04-25

- 🔧 Chores & Improvements: Version bumps across multiple packages; minor typings tightening and null-safety refinements
  - UI: strengthen Dicom server add/update types and import paths
  - Backend: broaden types, safer optional chaining, and refactors in auth, org-branding, runtime-config, smart-scope-mappers, and admin routes
  - Keycloak: stricter typing on token payloads/responses and adjusted error handling
  - Dicom/DICOM routes: tightened parameter handling types
  - ESLint: elevate no-explicit-any to error
  - Misc: small refactors in app discovery and organization representations

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/585


## [0.0.8-alpha.202604251656.4c9a01c0] - 2026-04-25

- 🔧 Chores & Improvements: Add onOpenDetail callbacks to Dashboard, ImagingStudyCard, and GenomicsCard to enable opening detailed views (passed through from Dashboard to card components).

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/583


## [0.0.8-alpha.202604251649.1dd04e7c] - 2026-04-25

- ⚠️ Breaking Changes: None detected

- 🔧 Chores & Improvements:
  - Dependency and version bumps across multiple apps (consent-app, dtr-app, ui, etc.).
  - Refactor: usePerson hook now uses fetchPerson with updated dependency handling.

- 🔧 Chores & Improvements (CI/CD/config):
  - Dockerfile: removed copying mcp-server-templates.json from backend build stage.

- 🐛 Bug Fixes:
  - Minor hook refactor to streamline token fetch flow (fetchPerson exposed for refetch).

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/582


## [0.0.8-beta.202604251600.c1abef92] - 2026-04-25

- 🔧 Chores & Improvements: Refactor usePerson hook to fetch via fetchPerson and expose refetch; update dependency references to reflect new fetchPerson usage
- 🔧 Chores & Improvements: Downgrade Vue devDependencies from 3.5.33 to 3.5.32 in bun.lock and package.json
- 🔧 Chores & Improvements: Bump consent-app and dtr-app versions to 202604251600

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/581


## [0.0.8-alpha.202604251600.c1abef92] - 2026-04-25

- 🔧 Chores & Improvements: Version bump to 0.0.8-alpha.202604251600.c1abef92 across multiple packages (consent-app, dtr-app, patient-portal, patient-portal/package, smart-dicom-template, ui, eslint-config, testing/e2e)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/580


## [0.0.8-alpha.202604251402.0ddf9508] - 2026-04-25

- 🔧 Chores & Improvements: Major ESLint configuration refactor with shared base and React/UI-specific configs; update root config to delegate to base with ignores; add eslint-config scaffolding and shared UI lint config
- 🔧 Chores & Improvements: Dependency and version bumps to 0.0.8-alpha.202604251402.0ddf9508 across app packages (tailwind, lucide-react, shadcn, etc.)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/579


## [0.0.8-alpha.202604251357.feaf2389] - 2026-04-25

- 🔧 Chores & Improvements: Version bump to 0.0.8-alpha.202604251357.feaf2389 across packages
- 🔧 Chores & Improvements: Remove unused imports (UI: SmartAppType in useSmartAppForm.ts; Backend: LanguageModel in ai.ts)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/578


## [0.0.8-alpha.202604241730.a780750b] - 2026-04-25

- 🔧 Chores & Improvements: UI refactor of MCP configuration (MCP ServersManager replaced with MCP Endpoint Settings under AI Tools; navigation label updated to "MCP Endpoint")
- 🔧 Chores & Improvements: Large UI removals impacting MCP-related components (McpServersManager, McpServersTab, SkillsTab, and associated dialogs/components) and cascading form changes
- 🔧 Chores & Improvements: Backend/admin/API cleanup removing MCP servers management routes, admin schemas, and MCP registry client components

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/577


## [0.0.8-alpha.202604241234.d7c3bcdc] - 2026-04-24

- 🔧 Chores & Improvements: Update version strings to 0.0.8-alpha.202604241234.d7c3bcdc across apps/tests; UI enhancements introducing Select components for DICOM authentication in Add/Edit dialogs; added DicomStatsCards component and its usage in DicomServersManager; minor import adjustments and icon set changes.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/576


## [0.0.8-alpha.202604240023.ea1d899c] - 2026-04-24

- 🔧 Chores & Improvements: Remove automatic migration of client JWT auth to client-secret; simplify clientSecret fetch to directly retrieve internal clientId/id without migration logic; update header comment accordingly

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/575


## [0.0.8-alpha.202604240004.e4134a02] - 2026-04-24

- ✨ Features: Version bump to 0.0.8-alpha.202604240004.e4134a02 across multiple packages
- 🔧 Chores & Improvements: Backend migration logic to move Keycloak client from client-jwt to client-secret during secret fetch (preserves JWKS attributes and logs migration)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/574


## [0.0.8-alpha.202604232317.25238204] - 2026-04-24

- ✨ Features: Introduced LayerContext and useLayerZIndex for dynamic z-index management across UI: Dialog, DropdownMenu, Select, and Tooltip now render above the current modal layer; portaled children wrapped with LayerContext.Provider to apply correct z-index
- 🔧 Chores & Improvements: Updated exports and propagated z-index handling; applied dynamic z-index across UI components

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/573


## [0.0.8-alpha.202604231532.b15a39b6] - 2026-04-23

- ✨ Features
  - Backend: add new backend-services.ts for private_key_jwt handling and integrate into OAuth flow; detect and process Backend Services token requests at proxy layer
  - Keycloak realm export: configure inferno-backend-services client to use client-secret authentication with internal proxy secret

- 🔧 Chores & Improvements
  - Backend: adjust FHIR proxy headers to drop origin and CORS-related headers; preserve others and set accept header
  - Minor: ensure token responses are cache-controlled (no-store) and log metrics for backend services flow

Note: No breaking changes detected; no documentation, bug fixes, or updates beyond these groups.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/572


## [0.0.8-alpha.202604231527.b066b983] - 2026-04-23

- ⚠️ Breaking Changes: No user-facing breaking changes detected.

- 🔧 Chores & Improvements: Version bumps across UI, consent-app, dtr-app, patient-portal, smart-dicom-template, and testing/e2e to 0.0.8-alpha.202604231527.b066b983.

- 🔧 Chores & Improvements: Inferno OAuth script updated to enable use_discovery: true in backend_services auth info.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/571


## [0.0.8-alpha.202604231310.dd1cc2cd] - 2026-04-23

- 🔧 Chores & Improvements: Bump version to 0.0.8-alpha.202604231310.dd1cc2cd
- 🔧 Chores & Improvements: Update CORS origins in beta environments to include http://localhost:4567 across workflows, docker compose, testing setup, and multiple apps (consent-app, dtr-app, patient-portal, smart-dicom-template, ui)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/570


## [0.0.8-alpha.202604231226.b0a9083d] - 2026-04-23

- ✨ Features
  - Consent app: add fire-and-forget email notification on access request creation via notifyAccessRequest; ignore failures.

- 🔧 Chores & Improvements
  - Shared UI: export change to StatCard to expose colorMap.
  - FHIR client/common: introduce createAuthFetch wrapper; refactor to use shared UI createSmartAuth; centralize backend notification API stubs.
  - Smart-auth/config: per-app refactor to use shared createSmartAuth; derive fhirBaseUrl; export smartAuth and fhirBaseUrl for apps.
  - TS config & Vite: consolidate to shared smart-ui config; apps extend via shared presets (smart-app/tsconfig, smart-node/tsconfig, shared Vite config).
  - Monitoring: scaffold generic create-monitoring-service.ts to standardize SSE.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/569


## [0.0.8-alpha.202604230400.3110b99a] - 2026-04-23

- 🔧 Chores & Improvements: Contracted shared UI/config setup and refactors
  - Consolidated TS config and Vite settings to shared smart-ui presets; apps extend via shared presets
  - Refactored smart-auth/config to use shared createSmartAuth and derive fhirBaseUrl; centralized exports for apps
  - FHIR client/common updated to use createAuthFetch wrapper; removed custom auth error handling; centralized backend notification stubs
  - Backend: added email backend with Resend (conditional), new consent-notify API route and admin/email wiring; updated token utilities
  - Monitoring services: scaffolded generic create-monitoring-service.ts for standardized SSE implementations
  - Consent app: add fire-and-forget email notification on access request creation via notifyAccessRequest; ignore failures

Note: Skipped non-substantive/metadata updates and merges per guidelines.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/568


## [0.0.7-alpha.202604221318.ab938c2d] - 2026-04-23

- ✨ Features: 
  - Consent app: fire-and-forget email notification on access request creation via notifyAccessRequest (ignore failures)
  - Backend: email backend with Resend (conditional on API key); new consent-notify API route and admin/email wiring

- 🔧 Chores & Improvements:
  - FHIR client/common: introduce createAuthFetch wrapper; refactor to use shared UI createSmartAuth; centralize backend notification API stubs; remove custom auth error handling
  - Smart-auth/config: per-app refactor to use shared createSmartAuth and derive fhirBaseUrl; export smartAuth and fhirBaseUrl
  - TS config and Vite: consolidate to shared smart-ui config; apps extend via shared presets (smart-app tsconfig, smart-node tsconfig, shared Vite config)
  - Monitoring services: scaffold generic create-monitoring-service.ts to standardize SSE

- ⚠️ Breaking Changes: None detected

Note: No update/merge/metadata commits included.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/566


## [0.0.7-alpha.202604220949.46abe258] - 2026-04-22

- ⚠️ Breaking Changes: ModalStackProvider integration and dynamic z-index handling require updates to app root usage and UI layering
- 🔧 Chores & Improvements: Introduce ModalStackProvider and useModalLayer with shared-ui exports; wire modal layer into apps
- ✨ Features: Dynamic z-index support for dialogs via useModalLayer on Dialog/Overlay/Content
- 📚 Documentation: N/A
- 🐛 Bug Fixes: N/A

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/565


## [0.0.7-alpha.202604220939.1e50f6cf] - 2026-04-22

- ✨ Features: 
  - Introduced MedicalTimeline component and view mode switch (cards/timeline) in patient portal.
  - SHL DICOMweb mode support: add and route SHL DICOMweb handling and token support.

- 🔧 Chores & Improvements:
  - Refined ImagingStudyCard rendering to show thumbnails/series more aggressively.
  - SHL backend scaffolding for DICOMweb proxy (buildDicomAuthHeader, SHL DICOMweb proxy handler scaffolding).
  - Backend/frontend build-test workflows: disable Copilot Self-Heal steps.

- 🐛 Bug Fixes:
  - SHL DICOMweb mode integration updates and routing adjustments.
  - Updated DICOM proxy target in backend/shl.ts to use dicomServer.baseUrl.

Notes:
- This release focuses on new SHL integration groundwork, UI enhancements for patient portal timeline, and workflow adjustments. No breaking changes reported.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/564


## [0.0.7-alpha.202604212352.98581bd0] - 2026-04-22

- ✨ Features: Introduce ServersManager with unified FHIR and DICOM sub-managers, including new DicomServersManager, full CRUD dialogs (AddDicomServerDialog, EditDicomServerDialog), and DicomServerCard; consolidate navigation to reflect new Servers tab.
- 🔧 Chores & Improvements: Backend support for DICOM servers via new admin routes, runtime config integration, and dicom-servers schema with auth/header handling; update dicomweb proxy utilities to align with new structure; wire server admin routes into runtime config loading.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/561


## [0.0.7-alpha.202604212241.3c476a12] - 2026-04-21

- 🔧 Chores & Improvements: AuditTimeline now uses base/monitoring paths without config.proxyPrefix
- 🔧 Chores & Improvements: Backend SHL updated with a FHIR proxy handler including session token validation, expiration handling, and per-session patient scope
- 📚 Documentation: DTR app manifest and config broadened OAuth scopes to include user/Claim.cud and user/QuestionnaireResponse.cud
- 🔧 Chores & Improvements: Patient portal - propagate onSaved callbacks to DocumentImport and PatientScribe; add onSaved handler plumbing
- 🔧 Chores & Improvements: Patient portal - RecordDetailModal extended with ORIGINAL_SNAPSHOT_EXT and logic to store original snapshot when pending review
- 🔧 Chores & Improvements: Patient portal - ResourceReviewCard now filters out non-useful FHIR validation warnings (narrative, text.div, etc.)
- 🔧 Chores & Improvements: Patient portal - RecordEditModal adds ORIGINAL_SNAPSHOT_EXT export and snapshot handling comments/logic for discard/revert

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/558


## [0.0.7-alpha.202604210210.f96ec187] - 2026-04-21

- ✨ Features
  - Backend SHL: introduce SHL FHIR proxy handler with session token validation, expiration handling, and per-session patient scope

- 🐛 Bug Fixes
  - AuditTimeline: remove proxyPrefix from proxy URL construction; now base/monitoring/... without config.proxyPrefix
  - Patient portal: ResourceReviewCard adds warning filtering to suppress non-useful FHIR validation warnings (narrative, text.div, etc.) for patients
  - Patient portal: propagate onSaved callbacks to DocumentImport and PatientScribe components; add onSaved handler plumbing
  - Patient portal: RecordDetailModal extended with ORIGINAL_SNAPSHOT_EXT constant and logic to store original snapshot when marking as pending review
  - Patient portal: RecordEditModal new ORIGINAL_SNAPSHOT_EXT export and snapshot handling comments/logic (prepares for discard/revert)

- 📚 Documentation
  - DTR app manifest and config: broaden OAuth scopes to include user/Claim.cud and user/QuestionnaireResponse.cud

- 🔧 Chores & Improvements
  - (Internal maintenance related to diff/structure and scaffolding)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/556


## [0.0.6-alpha.202604210100.3c8bee72] - 2026-04-21

- ✨ Features: 
  - AccessControlSettings component added (new UI feature)
  - UI: Tabs-focused layout enhancements including ConsentSettings and AccessControlSettings integration

- 🔧 Chores & Improvements:
  - UI/UX refactors: simplify headers and tabs, remove Settings tab from ConsentMonitoringDashboard, and extend layouts to accommodate new settings
  - HealthcareUsersManager: support external add-user control via props and internal state fallback
  - SmartAppsManager and SmartConfigManager updated to import and integrate new settings components
  - index.css updated with shared UI styles import

- ⚠️ Breaking Changes: 
  - None detected

- 🐛 Bug Fixes:
  - None detected

- 📚 Documentation:
  - None detected

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/552


## [0.0.6-beta.202604202357.6b2a26b6] - 2026-04-21

- 🔧 Chores & Improvements: UI cleanup in OAuthMonitoringDashboard (switch header from BarChart icon to Tabs-based layout; remove BarChart icon import and usage; retain Activity, Play, Pause, Refresh icons)  
- 🔧 Chores & Improvements: Import shared UI styles in index.css

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/550


## [0.0.6-alpha.202604202357.6b2a26b6] - 2026-04-21

- 🔧 Chores & Improvements: sync package versions
- 🐛 Bug Fixes: disable DICOM viewer in SHL read-only mode (patient-portal)
- 🔧 Chores & Improvements: update beta/alpha version metadata (internal CI)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/547


## [0.0.6-alpha.202604202302.cb01af88] - 2026-04-20

- 🔧 Chores & Improvements: Remove SHL Viewer; prune related assets and build stages. Update dist copy logic to exclude SHL viewer outputs.
- ✨ Features: Introduce SHL viewing path and SHL viewer client (parse/decrypt flow), with SHL-aware UI adjustments (header adaptation, skip SMART auth in SHL mode), and dashboard support for readOnly and patientId override in SHL mode.
- 📚 Documentation: N/A
- 🐛 Bug Fixes: N/A
- ⚠️ Breaking Changes: N/A

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/546


## [0.0.6-beta.202604202126.e4fc0fec] - 2026-04-20

- ✨ Features: SHL viewing path added
  - New ShlView component and SHL viewer client (SHL parse/decrypt flow) in patient-portal
  - UI adaptations for SHL mode (header title/icon, skip SMART auth in SHL)
  - Dashboard support for readOnly mode and overridden patientId in SHL mode
  - Introduced shl-viewer-client.ts library

- 🔧 Chores & Improvements: Version bump across apps and tooling to 0.0.6-beta.202604202126.e4fc0fec

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/543


## [0.0.6-alpha.202604201916.8352fc45] - 2026-04-20

- ✨ Features: Extend SHL viewer and API capabilities
  - SHL viewer: add MedicationRequest and Procedure support; expose MedicationRequest in fhir-client exports; include prescriptions and procedures fields.
  - SHL viewer: include MedicationRequests in search flow with updated imports and types.
  - SHL API: broaden token scope to include patient/*.read (not just openid).

Note: No breaking changes detected; no docs or CI/CD updates present.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/537


## [0.0.6-alpha.202604201606.827800ce] - 2026-04-20

- ⚠️ Breaking Changes: None detected

- ✨ Features (new functionality)
  - SHL viewer: load patient first and fetch related lookups with allSettled; coerce missing relations to empty arrays

- 🧰 Chores & Improvements
  - SHL API route: improve resilience by handling token/upstream fetch errors and returning appropriate 503/502 statuses with logs
  - Admin backend: map appType to effectiveClientType and store appType in client_type during update
  - Minor JSON structure: adapt to versioning and enhanced error handling

- 🔧 CI/CD & Misc
  - Version bump from 0.0.6-beta... to 0.0.6-alpha... across apps and testing package

Note: No merge or purely update-only commits included.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/535


## [0.0.6-alpha.202604201519.35972f5c] - 2026-04-20

- 🔧 Chores & Improvements: Improve patient ID extraction from token with fallback to fhirUser Patient reference; updated error message accordingly. Preserve ttl/expiresAt and session token logic.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/533


## [0.0.6-alpha.202604201505.7ad141e9] - 2026-04-20

- ✨ Features
  - SHL FHIR Proxy: add hide: true to route metadata to avoid OpenAPI duplicate operationIds

- 🔧 Chores & Improvements
  - Job context fix: derive test_stage from branch context with complex default mapping (no longer from env.TEST_STAGE)
  - UI/UX refactor: overhaul Tabs components to ResponsiveTabsList; adjust styling and container padding across UI sections
  - FHIR UI: improve overview tab padding/spacing for consistency
  - ServerOverview: remove outer padding for cleaner layout
  - shared-ui: improve data attribute handling for orientation in Tabs

- ⚠️ Breaking Changes
  - None detected

- 📚 Documentation
  - Backend SHL API route comment updated to reflect proxy architecture and token handling

Notes:
- Update commits were skipped per guidelines; only meaningful user/developer-facing changes included.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/530


## [0.0.6-alpha.202604201435.54b6d9dc] - 2026-04-20

- ✨ Features
  - Share/expires functionality: add expiry-related labels and UI to create share links with expiry options (1h/4h/24h/72h). (Localization, UI, and partial backend notes)

- 🔧 Chores & Improvements
  - UI/UX refinements: update tab components to responsive tabs, adjust padding/margins and container styling across UI sections, and improve data attribute handling for orientation.
  - Token naming and environment usage updates in workflows: rename input from app-id to client-id; switch tests to read test stage from env.TEST_STAGE.
  - Documentation tweaks: notes on proxy architecture and token handling.

- ⚠️ Breaking Changes
  - None detected in user-facing behavior.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/528


## [0.0.6-alpha.202604201217.57a94fb9] - 2026-04-20

- ✨ Features: Introduce expiry options for shared links (labels include “Link expires after” with 1h/4h/24h/72h) and add expiry select UI to ShareQRDialog
- 🔧 Chores & Improvements: UI refactor of tab components (ResponsiveTabsList usage and styling tweaks across DoorManagement and FHIR UI), adjust TabsContent padding, and data attribute handling for orientation
- 🔧 Chores & Improvements: Update environment and workflow references (token input rename: app-id -> client-id; read test stage from env.TEST_STAGE)
- 🔧 Chores & Improvements: Minor backend/documentation notes about proxy architecture and token handling

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/526


## [0.0.6-alpha.202604200357.a4a5d108] - 2026-04-20

- 🔧 Chores & Improvements: UI/UX refinements to Tabs rendering and spacing across DoorManagement and FhirServersManager; updated Tabs components for responsive behavior and adjusted padding/spacing
- 📚 Documentation: Localization updates to expiry-related labels and translation links; minor docs note on proxy pattern and token handling
- ✨ Features: Expiry options added for share links (1h/4h/24h/72h) with expiry UI in ShareQRDialog
- ⚠️ Breaking Changes: None
- 🐛 Bug Fixes: None identified

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/525


## [0.0.6-alpha.202604200309.7ff7534a] - 2026-04-20

- ✨ Features: Add expiry options for shared links (1h/4h/24h/72h) with expiry label translations and UI, including ShareQRDialog updates.
- 🔧 Chores & Improvements: UI refactors for Tabs components (ResponsiveTabsList usage, styling adjustments across DoorManagement and FHIR UI), padding/spacing improvements in overview tabs, and data attribute handling for tab orientation. Also rename GitHub Actions token input from app-id to client-id and adjust test stage env usage.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/524


## [0.0.6-alpha.202604200231.7ea48bc5] - 2026-04-20

- ✨ Features: Add expiry options for share links (UI and translations) with predefined durations (1h/4h/24h/72h)
- 🔧 Chores & Improvements: UI cleanup in ShareQRDialog.tsx (remove unused React import, integrate expiry Select)
- 🔧 Chores & Improvements: Documentation notes and backend route comment adjustments related to proxy architecture and token handling
- ⚠️ Breaking Changes: None
- 🐛 Bug Fixes: None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/522


## [0.0.6-alpha.202604200101.06f68dac] - 2026-04-20

- ✨ Features: Add expiry options for share links (labels and UI) with predefined durations (1h/4h/24h/72h)
- 🔧 Chores & Improvements: UI cleanup (remove unused React import) and state tracking for expiryMinutes; updated localization for expiry labels
- 🔧 Chores & Improvements: Backend docs note about proxy architecture and token handling (no behavior changes)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/520


## [0.0.6-alpha.202604200037.e0f1ab7f] - 2026-04-20

- 🧪 ✨ Features: UI for Smart App form extended with new Access Token Lifespan section and related fields; defaults adjusted for tokenExchangeEnabled (now false)
- 🔧 🗂️ Chores & Improvements: Backend exposure/initialization of new SmartApp fields (consentRequired, fullScopeAllowed, clientSessionIdleTimeout, clientSessionMaxLifespan, backchannelLogoutUrl, frontChannelLogoutUrl)
- 🔧 🗂️ Chores & Improvements: Token Exchange API removed from SHL backend
- ⚠️ Breaking Changes: (none detected)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/517


## [0.0.6-alpha.202604192104.9250dba6] - 2026-04-20

- ✨ Features: Add Access Token Lifespan section and related fields to Smart App form; expose new fields in admin smart apps route/types (consentRequired, fullScopeAllowed, clientSessionIdleTimeout, clientSessionMaxLifespan, backchannelLogoutUrl, frontChannelLogoutUrl)
- 🐛 Bug Fixes: Token Exchange UI default now false (instead of true)
- 🔧 Chores & Improvements: UI defaults updated for token exchange and form initialization
- ⚠️ Breaking Changes: None
- 📚 Documentation: None

If no meaningful changes beyond maintenance, output would be: - 🔧 Chores & Improvements: Internal updates and maintenance

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/515


## [0.0.6-alpha.202604192100.56d6dcbb] - 2026-04-19

- ✨ Features: Add token exchange toggle to SMART app edit modal (admin-ui)
- 🔧 Chores & Improvements: Sync package versions
- 🔧 Chores & Improvements: Update beta/alpha version references (CI/CD)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/512


## [0.0.6-alpha.202604191731.193c395c] - 2026-04-19

- 🔧 Chores & Improvements: Align alpha version across all packages/deps
  - Bump version strings from 0.0.6-beta... to 0.0.6-alpha.202604191731.193c395c
  - Minor backend change: added audience: shlClientId to exchangeForShlToken request (shl.ts)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/510


## [0.0.6-alpha.202604191644.c881cf1e] - 2026-04-19

- 🔧 Chores & Improvements: Rename admin backend attribute keys for token exchange settings and align with standard.token.exchange.enabled; update emitted flag naming. Minor consistency fixes across UI/backend and version bumps across projects.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/507


## [0.0.6-alpha.202604191635.1ccdb876] - 2026-04-19

- ✨ Features: Enable CIMD and token-exchange features by default in Keycloak Dockerfile; update docker-compose to run with features=cimd,token-exchange; production start retained with realm import.
- 🔧 Chores & Improvements: Version bumps across multiple packages from beta to alpha pre-release.
- ⚠️ Breaking Changes: None detected.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/504


## [0.0.6-alpha.202604191312.42324489] - 2026-04-19

- 🔧 Chores & Improvements: Mask client secrets in smart-apps route responses (hide plaintext with **********; add masking note in comments) across multiple apps/tests
- 🔧 Chores & Improvements: Miscellaneous minor comment tweaks

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/502


## [0.0.6-alpha.202604191222.8f195a17] - 2026-04-19

- 🔧 Chores & Improvements: Harden error handling and pre-checks for insecure/private origins in FhirServersManager; treat as secure for http/private/invalid origins
- 🔧 Chores & Improvements: Propagate and store client secrets for confidential SMART apps clients during create/update paths

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/499


## [0.0.6-alpha.202604191155.f011c012] - 2026-04-19

- 🔧 Chores & Improvements: Switch to uv tool install for openapi-ts-fetch==0.2.0 and update PATH; adjust API client generation to use backend/dist/openapi.json for UI API client generation.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/497


## [0.0.6-alpha.202604191148.b00a1b9d] - 2026-04-19

- 🔧 Chores & Improvements: Adjusted API client generation workflow
  - Use uv tool from external image to install openapi-ts-fetch@0.2.0
  - Continue copying openapi.json from openapi-gen
  - Generate TypeScript API client into apps/ui/src/lib/api-client

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/495


## [0.0.6-alpha.202604191138.475af2a3] - 2026-04-19

- ✨ Features: 
  - UI overhaul: migrate Tabs to ResponsiveTabsList across multiple components for better responsiveness.
  - Added shared UI components: FilterToolbar and FilterToolbarItem; new responsive-tabs-list.tsx; new page-header.tsx; export entries updated in shared-ui.

- 🔧 Chores & Improvements:
  - OpenAPI client generation switch to openapi-ts-fetch for both apps.
  - Version bumps across multiple apps from beta to alpha.

- ⚠️ Breaking Changes:
  - None identified.

Note: Update-only commits and merges were ignored per guidance.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/493


## [0.0.6-alpha.202604191042.7739f830] - 2026-04-19

- ✨ Features: 
  - UI refresh: migrate Tabs to ResponsiveTabsList across multiple components.
  - Added shared UI components: FilterToolbar, FilterToolbarItem, responsive-tabs-list, and page-header; updated shared-ui exports.

- 🔧 Chores & Improvements:
  - OpenAPI client generation switched to openapi-ts-fetch; install and use it for both apps.
  - Broad version bumps across apps from beta to alpha (0.0.6-alpha.202604191042.7739f830).
  - UI layout tweaks: grid-to-responsive-flex adjustments in AdminAuditDashboard, EventLogTab, ConsentMonitoringDashboard, OAuthMonitoringDashboard, FhirServersManager, HealthcareUsersManager, SmartAppsManager, UsersAnd…

- ⚠️ Breaking Changes: 
  - (None detected)

- 📚 Documentation:
  - (None detected)

Note: Merges, pure updates, and non-meaningful metadata commits skipped.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/491


## [0.0.6-alpha.202604191007.71942d74] - 2026-04-19

- 🔧 Chores & Improvements: Version bump to 0.0.6-alpha.202604191007.71942d74 across apps and test package
- 🔧 Chores & Improvements: Updated header comment in runtime-template.ts (Proxy Smart Backend -> OpenAPI TypeScript Fetch Client Runtime); license note adjusted to reflect openapi-ts-fetch generation

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/488


## [0.0.6-alpha.202604190956.a2d9d108] - 2026-04-19

- 🔧 Chores & Improvements: Adjust base path handling and summary guard
  - base_path default set to "" in generate-ts-fetch-client.py and runtime-template.ts; supports override via Configuration.basePath
  - summarize_diff.py adds guard to skip summary if diff length <= commit message length, with logging

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/486


## [0.0.6-alpha.202604181646.b547f57e] - 2026-04-19

- 🔧 Chores & Improvements: CI/CD enhancements for patient portal build and API client generation
  - GitHub Actions: add step to build the Patient Portal in frontend workflow; set TAILWIND_DISABLE_LIGHTNINGCSS and build from apps/patient-portal
  - Docker: generate API clients for patient-portal in api-client-gen stage; mount generated client into patient-portal and run extra CLI generation with tag --tags shl
  - Dockerfile: reuse generated patient-portal API client in build stage
  - package.json: broaden generate commands to include UI and patient-portal clients for generate:clients and generate:ui commands

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/485


## [0.0.6-alpha.202604181619.5f44b1d4] - 2026-04-18

- ✨ Features
  - SHL integration: introduce new SHL client and switch ShareQRDialog to use it; register and expose SHL API route in backend and OpenAPI; add createShl wrapper.

- 🔧 Chores & Improvements
  - CI workflow: optimize Bun setup and backend build by gating behind target; refactor to reduce rebuilds for deployed target.
  - Script updates: enhance generate-ts-fetch-client.py to support optional tag filtering and collect model dependencies (improved generation logic).

- ⚠️ Breaking Changes
  - ShareQRDialog: updates to post SHL requests directly to /api/shl (base URL) replacing previous proxy path.

- 📚 Documentation
  - Translation: minor text change for translation.json "retry" label (adds trailing period).

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/484


## [0.0.6-beta.202604181414.b7d82445] - 2026-04-18

- 🔧 Chores & Improvements: Version bump to 0.0.6-beta.202604181414.b7d82445 across apps/packages
- 🔧 Chores & Improvements: Minor type guard/formatter adjustment in HealthChartsCard.tsx to handle null values with inferred types and ?? ""

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/482


## [0.0.6-alpha.202604181019.5ab998ef] - 2026-04-18

- 🔧 Chores & Improvements: Migrate UI components to shared-ui (Table, ScrollArea, Separator, DropdownMenu, Progress, Toaster, etc.) and update imports across apps; add shared-ui index exports and Toaster theming support; extend ThemedToasterProps type

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/480


## [0.0.6-alpha.202604181004.43ff3043] - 2026-04-18

- ✨ Features: 
  - AuditTimeline now supports ConsentEvent and AccessEvent; Audit UI passes patientId to AuditTimeline and PatientDetail supplies patientId.
  - New REST route: GET /monitoring/consent/patients/:patientId/access-log

- 🐛 Bug Fixes: 
  - Propagate user identity (userId, username) through consent audit entries and metrics logging; ensure user identity is extracted from token in consent services and FHIR proxy routes.

- 🔧 Chores & Improvements:
  - FHIR proxy and consent components updated to include userId and username in proxied data and events.
  - HealthChartsCard refactor removed large charting block and related imports/metrics (cleanup).

- 📚 Documentation: 
  - (No explicit documentation changes detected beyond structural/type changes)

- ⚠️ Breaking Changes: 
  - (None detected)

Note: Skipped update/merge/metadata commits per guidelines.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/479


## [0.0.6-alpha.202604180955.fdfc0a3f] - 2026-04-18

- ✨ Features
  - HealthChartsCard: groundwork for overhaul with new metrics rendering (BP, HR) and metric definitions
  - SHL_EXCHANGE_CLIENT_SECRET added as optional in beta and deployment workflows; secret wiring to jobs and API calls

- 🐛 Bug Fixes
  - Favicon route fix; minor UI tweaks for consistency (min-width, text truncation, responsive metric select)

- 🔧 Chores & Improvements
  - GenomicsCard: major UI layout refactor; variants grid rework; two-column layout on desktop; combined rendering of Diagnostic Implications and Pharmacogenomics
  - PatientBanner: UI polish (larger avatar, updated name/DOB row, age formatting, two-row metadata)
  - Shared UI: Card overflow fix
  - Version bumps: beta → alpha tag updates across multiple apps/packages
  - Backend/DevOps: SHL client in docker-compose; Keycloak realm export updated; minor DTR/Consent UI layout tweak; favicon adjustments

- ⚠️ Breaking Changes
  - None detected

- 📚 Documentation
  - Minor UI/content tweaks (no substantive docs changes)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/478


## [0.0.6-alpha.202604180907.c75786d7] - 2026-04-18

- 🔧 Chores & Improvements: Treat .tgz and .tar.gz as binary in .gitattributes (binary attribute added)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/477


## [0.0.6-alpha.202604180840.844c7653] - 2026-04-18

- ✨ Features: Add loginTheme support across frontend, backend, and branding schema; propagate loginTheme in runtime config to brand config and realm on save
- 🔧 Chores & Improvements: Minor UI refinements and responsive tweaks across multiple components (layout overflow, text alignment, responsive grids, scrollable modals); minor type guard improvements
- 📚 Documentation: (none)
- 🐛 Bug Fixes: (none)
- ⚠️ Breaking Changes: (none)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/476


## [0.0.6-alpha.202604180734.a1740e57] - 2026-04-18

- 🔧 Chores & Improvements: Add shl-viewer as a new workspace entry in Docker build; update workspace configuration and bun install to include shl-viewer

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/475


## [0.0.6-beta.202604180719.b66f4933] - 2026-04-18

- 🔧 Chores & Improvements: Maintenance and CI/CD updates (auto-PR merge pipeline; no user-facing changes)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/474


## [0.0.6-alpha.202604180532.28cb6a09] - 2026-04-18

- 🔧 Chores & Improvements: Version bumps across apps/libs to 0.0.6-alpha.202604180532.28cb6a09
- ✨ Features: Add deleteResource capability in patient-portal lib/fhir-client.ts for DELETE operations
- ✨ Features: UI Dashboard now refreshes on deletions via onResourceDeleted
- ✨ Features: Patient portal RecordDetailModal header receives Trash/Delete icon (Trash2) and supports resource deletion
- 📚 Documentation: i18n translations added for delete/cancel in German, English, Spanish, French, Italian (patient-portal locales)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/471


## [0.0.6-alpha.202604180503.f0670f25] - 2026-04-18

- 🔧 Chores & Improvements: Remove 4-hour Copilot Auto-Fix cron; keep workflow_dispatch
- 🔧 Chores & Improvements: Bump version seeds to alpha.202604180503.f0670f25 across multiple apps/packages
- 🔧 Chores & Improvements: Add qrcode.react dependency to apps/patient-portal
- 🔧 Chores & Improvements: Extend smart-apps API schema and CreateSmartAppRequest with tokenExchangeEnabled, accessTokenLifespan, and audienceClients; align backend routes/schemas

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/470


## [0.0.6-alpha.202604180451.1176fee1] - 2026-04-18

- 🔧 Chores & Improvements: Version bump to 0.0.6-alpha.202604180451.1176fee1 across multiple packages/apps
- 🐛 Bug Fixes: Improve practitioner name derivation in CareTeamCard.tsx (use pr.name length check with fallback to "Unknown Practitioner")

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/469


## [0.0.6-alpha.202604180443.7013097d] - 2026-04-18

- 🔧 Chores & Improvements: Bump version refs to 0.0.6-alpha.202604180443.7013097d across apps and typings
- 🧪 Features: Extend PortalFhirResource union to include Coverage and Encounter in patient-portal (type update)
- 🔧 Chores & Improvements: UI copy/edit - update backend feature card title/description from “AI-Native: MCP + CDS Hooks” to “AI-Native: MCP + Tools” and adjust descriptive text
- 🧰 Chores & Improvements: Remove details table block from backend/public/index.html (tech stack section)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/468


## [0.0.6-alpha.202604180422.93c8eed5] - 2026-04-18

- ✨ Features: 
  - New React components under patient-portal (CareTeamCard, CoverageCard, DiagnosticReportsCard, EncountersCard, PrescriptionsDevicesCards) for enhanced patient UI and data display
  - fhir-client.ts extended exports to include Coverage and Encounter types; scaffolding for searchCoverage (base R4)
  - Dashboard.tsx updated to integrate new cards and search types (Coverage, Encounters, Practitioners, Organizations)

- 🔧 Chores & Improvements:
  - UI and data-model integration updates across manifest and dashboard to support new cards and types

Note: No breaking changes detected; no documentation or bug fixes in this set.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/467


## [0.0.6-alpha.202604180410.39488c8b] - 2026-04-18

- ✨ Features
  - Extend patient portal frontend: add blood type search/display, bloodType state, and Blood Type badge in PatientBanner.
  - FHIR client: add searchBloodType for ABO/Rh observations.

- 🐛 Bug Fixes
  - CI workflow: enable self-heal for test failures, attach logs, and deduplicate by label.

- 🔧 Chores & Improvements
  - Frontend: update homepage hero button to "View App Store" linking to /apps.
  - Seed data: insert example ABO/Rh blood type Observations into seed bundle.
  - Minor wiring: adjust dashboard results handling to include blood type observations.
  - Documentation: add Copilot Cloud Agent instructions doc with architecture and file map.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/466


## [0.0.6-alpha.202604180328.85225af7] - 2026-04-18

- ✨ Features: 
  - Extend patient portal: blood type search and display in Dashboard; blood type badge in PatientBanner with Droplets icon
  - FHIR client: add searchBloodType to query ABO/Rh observations (codes 882-1, 10331-7)
  - Seed data: insert example ABO/Rh blood type Observations into seed bundle

- 🔧 Chores & Improvements:
  - CI/CD: enhance smart-compliance-tests workflow to auto-create/update failure issues, attach logs, and deduplicate by label
  - Minor wiring: adjust dashboard results handling to include blood type observations

- 📚 Documentation:
  - Add Copilot Cloud Agent instructions doc with architecture and file map

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/464


## [0.0.6-alpha.202604180310.d6e29899] - 2026-04-18

- 🔧 Chores & Improvements: Replace placeholder admin service secret with hard-coded backend admin service client secret in realm-export.json

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/463


## [0.0.6-alpha.202604180303.9b2a78b2] - 2026-04-18

- 🔧 Chores & Improvements: Sync brand name with Keycloak realm displayName and displayNameHtml; extend runtime config save to push displayName updates when brand name exists.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/462


## [0.0.6-alpha.202604180259.058ad1c6] - 2026-04-18

- ✨ Features: None
- 🐛 Bug Fixes: 
  - Deploy: capture HTTP response body during seed POST flow; log non-200 responses (with body trimmed to 500 chars)
  - Keycloak: replace env-var password substitutions with fixed defaults in realm export (TEST_USER_PASSWORD, ADMIN_PASSWORD, DOCTOR_PASSWORD)
- 📚 Documentation: None
- 🔧 Chores & Improvements: Structural updates to seed data model (Person/Patient resources) in deploy/fhir-seed-bundle.json
- ⚠️ Breaking Changes: None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/461


## [0.0.6-alpha.202604180241.81e79f6a] - 2026-04-18

- 🔧 Chores & Improvements: CI: add dynamic Inferno version resolution and caching; conditional Inferno setup based on cache; cache keys depend on resolved tag and Ruby 3.3

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/459



- 🔧 Chores & Improvements: Replace environment-variable passwords with fixed defaults in keycloak/realm-export.json for TEST_USER_PASSWORD, ADMIN_PASSWORD, and DOCTOR_PASSWORD (DevT3st!Pass, DevAdm!n2024, DevD0c!2024)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/460


## [0.0.6-alpha.202604180230.a3897f94] - 2026-04-18

- 🔧 Chores & Improvements: CI: dynamic Inferno version resolution and version-aware caching; conditional Inferno setup based on cache miss

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/458


## [0.0.6-beta.202604180218.57e2229a] - 2026-04-18

- 🔧 Chores & Improvements: CI caching and version-aware setup for Inferno
  - Add dynamic Inferno version resolution and caching in CI
  - Implement cache for Inferno directory and bundler libs keyed by resolved tag and Ruby 3.3
  - Conditional Inferno setup: skip if cache hit; fetch latest tag for non-main and shallow clone behavior for main

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/457


## [0.0.6-alpha.202604180218.57e2229a] - 2026-04-18

- ✨ Features: Enhanced observability for OAuth flow and error handling
  - Improved error logging with per-message snippets and remote request details for failing requests (headers/body, with redaction of sensitive content).
  - Expanded OAuth token endpoint logging: content-type, granular body fields (grant_type, client_id, redirect_uri, presence checks); groundwork for deeper request tracing.
  - Backend logger: support for LOG_LEVEL environment override and default behavior tuned to LOG_LEVEL.

- 🔧 Chores & Improvements: CI/CD and testing enhancements
  - Deploy-beta workflow: build inspection adjusted (load: true; remove docker pull line; use create/export for inspection).
  - Smart compliance tests: added LOG_LEVEL usage for debugging; added conditional Dump Service Logs to emit auth-related backend/Keycloak logs.

Note: No breaking changes detected; no documentation or unrelated updates included.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/456


## [0.0.6-alpha.202604180155.3106a944] - 2026-04-18

- ✨ Features: Enhanced observability for OAuth/token flows
  - Improved error logging with per-message snippets and remote request details (headers/body) for failing requests; sensitive body content redacted while preserving parameter names.
  - Expanded OAuth token endpoint logging to include content-type and granular body fields (grant_type, client_id, redirect_uri) with presence checks; groundwork for more detailed request tracing.
  - Improved backend logger: support for LOG_LEVEL env override; base log level respects LOG_LEVEL if set, otherwise defaults to production/dev.

- 🔧 Chores & Improvements: CI/CD and deployment refinements
  - Deploy-beta workflow: added load: true for backend image build; retained localhost-bundle check, removed a docker pull step (relying on create/export for inspection).

- 🧪 Tests & Diagnostics: Enhanced test instrumentation
  - Smart compliance tests: added LOG_LEVEL-based debugging and a Dump Service Logs step to emit auth-related backend/Keycloak logs (conditional on target).

- ⚠️ Breaking Changes: None detected

- 📚 Documentation: None detected

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/455


## [0.0.6-alpha.202604180145.dac6c923] - 2026-04-18

- 🔧 Chores & Improvements: CI/CD and maintenance
  - Create non-root app user in Dockerfile and adjust user/group creation; ensure /app ownership and non-root user remains app (uid/gid 1001)
  - Bump versions across multiple package.jsons to reflect new alpha pre-release tag (0.0.6-alpha.202604180138.af208ce5 and related beta-to-alpha transitions)
  - Ensure ORTHANC_PASSWORD secret is declared and passed into deployment workflow and container environment in beta deployment flow

Note: Merges, updates, and metadata-only commits are omitted.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/454


## [0.0.6-beta.202604180108.f3484054] - 2026-04-18

- 🔧 Chores & Improvements: Dockerfile: switch to groupadd/useradd, preserve /app ownership; non-root user remains app (uid/gid 1001). 
- 🔧 Chores & Improvements: Bump version strings across package.jsons to 0.0.6-beta.202604180108.f3484054.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/452


## [0.0.6-beta.202604180039.bfa7d5fd] - 2026-04-18

- 🔧 Chores & Improvements: CI/testing updates
  - use 'bun run test --run' for frontend tests in CI (vitest instead of bun test)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/450


## [0.0.6-beta.202604180021.d4903bc7] - 2026-04-18

- 🐛 Bug Fixes
  - Security and input handling: added URL/SSRF validation to block internal/private endpoints and sanitize inputs; hardened error handling.

- 🔧 Chores & Improvements
  - Rate limiting: introduce in-memory rate limiter and rateLimit middleware for backend/frontend/admin routes; per-key sliding window with periodic cleanup.
  - Security hardening: run services as non-root user in Dockerfiles; remove sensitive secrets from CI workflows.
  - Admin/auth enhancements: enforce admin token validation on admin/config/test/shutdown paths; updated REST endpoints to require admin authentication; improved error messaging.
  - URL validation: added SSRF/URL guards across MCP/server and FHIR server routes.
  - Dependency and wiring tweaks: update package versions, adjust wiring for health/healing logic, and minor build outputs adjustments.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/447



- 🔧 Chores & Improvements: Add build-args to beta backend Docker build to inject VITE_ENCRYPTION_SECRET from GitHub Secrets; preserves two image tags and existing cache settings

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/448


## [0.0.6-alpha.202604180021.d4903bc7] - 2026-04-18

- ✨ Features
  - Add in-memory rate limiter for Elysia with per-key storage, sliding window, periodic cleanup, and configurable parameters
  - Add URL validation utilities to block SSRF by disallowing private/internal IPv4 ranges and problematic hostnames

- 🔧 Chores & Improvements
  - Enforce admin token validation for admin routes and harden admin authentication flow
  - Improve backend security: run services under non-root app user in Dockerfiles
  - Input sanitization and error sanitization enhancements in backend error handling
  - REST endpoints updated to require admin authentication for config/test/shutdown flows; improved error messaging
  - Minor wiring tweaks to support health/healing logic

- 🔒 Security (implicit under Chores & Improvements)
  - SSRF/URL validation guards across MCP/server and FHIR server routes; block or sanitize internal URLs
  - Remove OPENAI_API_KEY from workflows and env wiring across actions

- 📚 Documentation
  - (No explicit docs changes detected)

- ⚠️ Breaking Changes
  - (None detected)

Note: Only meaningful changes are included; update/merge/metadata commits are excluded.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/446


## [0.0.6-alpha.202604172152.bd4ad527] - 2026-04-18

- 🔧 Chores & Improvements: Remove OPENAI_API_KEY from GitHub Actions secrets and Env wiring; update package versions to new alpha tag and bump undici deps
- 🔧 Chores & Improvements: Introduce rate limiting and improve input/error sanitization across backend/frontend/admin routes
- 🔧 Chores & Improvements: Enforce admin token validation for admin routes; add validateAdminToken helper
- 🔧 Chores & Improvements: Add SSRF/URL validation guards in MCP/server and FHIR server routes
- 🔧 Chores & Improvements: Run services under non-root app user in Dockerfiles
- 🐛 Bug Fixes: Require admin authentication for config/test/shutdown REST endpoints; improve error messaging
- 📚 Documentation: (No explicit docs changes)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/445


## [0.0.6-alpha.202604172135.de7d1b11] - 2026-04-17

- 🔧 Chores & Improvements: Privacy and security enhancements
  - Remove OPENAI_API_KEY from multiple GitHub Actions secrets and Env wiring.
  - Enforce admin token validation for admin routes; add validateAdminToken helper.
  - Run services under non-root app user in Dockerfiles.
  - REST endpoints now require admin authentication for config/test/shutdown flows; improved error messaging.
  - Add SSRF/URL validation guards in MCP/server and FHIR server routes; block/sanitize internal URLs.
  - Introduce/retain rate limiting in backend/frontend/admin routes (rateLimit middleware for auth and AI routes).
  - Add input sanitization and error sanitization in backend error handling.
  - Minor frontend/backend wiring tweaks to support new healing/health logic (build/heal steps, outputs).

- 📚 Documentation: N/A

- ✨ Features: N/A

- 🐛 Bug Fixes: N/A

- ⚠️ Breaking Changes: N/A

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/444


## [0.0.6-alpha.202604172127.ece20b21] - 2026-04-17

- 🔧 Chores & Improvements: Version bumps across multiple apps to 0.0.6-alpha.202604172127.ece20b21 (update metadata only)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/443


## [0.0.6-alpha.202604172109.0469354b] - 2026-04-17

- 🔧 Chores & Improvements: Global version bumps across multiple packages to 0.0.6-alpha
- 🔧 Chores & Improvements: Remove MONO_MODE from backend config; MCP_ENDPOINT_ENABLED defaults to enabled; update/downgrade references in docs and infra
- ✨ Features: Update MCP UI copy to reflect default MCP endpoint enabled
- 📚 Documentation: Add new docs covering AI Tools, Identity Providers, Launch Context, Organizations, User Federation, deployment, environment variables, oauth-authentication, fhir-proxy, patient-api
- 🔧 Chores & Improvements: Production-like environment adjustments in infra and related config/docs
- ⚠️ Breaking Changes: MONO_MODE removal affects defaults and configuration (implicit breaking change)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/442


## [0.0.6-alpha.202604172056.45e770a6] - 2026-04-17

- 🔧 Chores & Improvements: Internal maintenance and metadata updates across apps and testing packages

- 🐛 Bug Fixes: Align DTR and return typings for Questionnaire responses to DTR types; ensure idempotent upsert/registration for Keycloak Declarative User Profile

- 📚 Documentation: Extend admin-ui navigation with new sub-tabs; update monitoring, scope-management docs, and reflect new declarative user-profile attributes in realm export

- ⚠️ Breaking Changes: None detected

- ✨ Features: Back-end: add required custom user-profile attribute declarations and ensure registration/upsert logic for Keycloak Declarative User Profile

Notes:
- Skipped: update-only commits, merge commits, and metadata-only changes.
- Grouped related changes to DTR typings, user-profile handling, and documentation updates.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/441


## [0.0.6-alpha.202604172046.f7c12859] - 2026-04-17

- 🔧 Chores & Improvements: Remove local FHIR client typing/imports and delegate formatHumanName to shared-ui; simplify fhir-client.ts

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/440


## [0.0.6-alpha.202604172031.e2101724] - 2026-04-17

- 🔧 Chores & Improvements: Type changes for FHIR resources
  - FhirResource alias renamed to DynamicFhirResource in RecordDetailModal.tsx and RecordEditModal.tsx with updated imports.
  - Introduced PortalFhirResource union (IpsFhirResource | GenomicsFhirResource | Observation | DocumentReference) and upgraded AnyFhirResource to a dynamic portal resource type.
  - Ips-display-helpers.tsx updated to use PortalFhirResource for AnyResource; getInterpretationFlag relaxed for observation data.
- 🔧 Chores & Improvements: Build/lockfile updates
  - Bun.lock hashes updated for hl7.fhir.uv.genomics-reporting-generated and ips-generated.
- ✨ Features: None
- 🐛 Bug Fixes: None
- 📚 Documentation: None
- ⚠️ Breaking Changes: None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/438



- 🔧 Chores & Improvements: Update dependency locks and generated tarballs for new pre-release (0.0.6-alpha.202604172031.e2101724)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/439


## [0.0.6-alpha.202604171955.f543cb6e] - 2026-04-17

- 🔧 Chores & Improvements: Refined FHIR resource typing and dynamic portal resource handling
  - Introduced PortalFhirResource union (IpsFhirResource | GenomicsFhirResource | Observation | DocumentReference) and updated AnyFhirResource to dynamic portal resource type.
  - Updated FhirResource alias to DynamicFhirResource in RecordDetailModal.tsx and RecordEditModal.tsx with corresponding import changes.
  - Ips-display-helpers.tsx now uses PortalFhirResource for AnyResource; loosened getInterpretationFlag type for observation data.
  - Binary diffs for Genomics and IPS TGZs updated; Bun.lock hashes updated.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/437


## [0.0.6-alpha.202604171952.a7930959] - 2026-04-17

- ✨ Features
  - Monitoring: New MonitoringDashboard UI scaffold with analytics and charts (MonitoringDashboard.tsx).

- 🔧 Chores & Improvements
  - FHIR client typing: Extended core FHIR clients with DTR/PAS types and exports; major typing refactor.
  - UI/UX improvements: Reworked card backgrounds (opacity tweaks) and layout adjustments; introduced centralized LoadingButton across many dialogs and dashboards; replaced redundant in-component buttons with LoadingButton and new SearchInput component.
  - Admin/backend scaffolding: Added new admin route and schemas for client policies to support CIMD; updated CIMD-related metadata handling and HTML scaffolding.
  - Version bumps: Updated multiple apps/packages to 0.0.6-alpha.202604171839.cb1b0696 and related variants.

- ⚠️ Breaking Changes
  - None identified.

- 📚 Documentation
  - None identified.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/436


## [0.0.6-alpha.202604171937.8e4540cb] - 2026-04-17

- ✨ Features: 
  - Monitoring: Added new MonitoringDashboard UI with full scaffolding (types, charts, analytics).
- 🔧 Chores & Improvements:
  - Core: Extended FHIR clients with DTR/PAS types and exports; major typing refactor in fhir-client.ts.
  - UI: Replaced empty-state blocks with reusable EmptyState components; introduced centralized LoadingButton across multiple UI modules; added SearchInput usage in dashboards.
  - Backend/CI: Enabled CIMD in Keycloak build and startup; updated docker configurations; bumped versions across apps/packages to 0.0.6-alpha.202604171839.cb1b0696 and related.
  - Admin: Added admin route/schemas for client-policies to support CIMD.
- 📚 Documentation:
  - UI/UX tweaks: adjusted paddings, sizes, and minor layout refinements across several dashboards and dialogs.
  - Public HTML: updated styling scaffold to reflect app presence.
- ⚠️ Breaking Changes:
  - None detected.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/435


## [0.0.6-alpha.202604171933.12fa631a] - 2026-04-17

- ✨ Features
  - Monitoring: New MonitoringDashboard UI scaffolding with types, charts, and analytics (UI core monitoring experience)

- 🔧 Chores & Improvements
  - Core: FHIR clients extended with DTR/PAS types and exports (major typing refactor)
  - UI/UX: Replaced empty-state blocks with reusable EmptyState component across multiple components; introduced centralized LoadingButton and SearchInput for consistent loading states and search functionality; UI paddings and sizes adjusted in various dashboards
  - Admin/Backend: Added new admin route and schemas to support CIMD client policies; CIMD enabled in Keycloak build and startup (kc.sh features) with updated Docker configurations
  - Versioning: Version bumps across multiple apps/packages to 0.0.6-alpha.202604171839.cb1b0696 / 0.0.6-alpha.202604171933.12fa631a

- 📚 Documentation
  - (No user-facing docs changes detected)

- ⚠️ Breaking Changes
  - (None detected)

Notes:
- Update commits without meaningful user-facing changes have been skipped.
- Merge/metadata-only commits skipped.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/434


## [0.0.6-alpha.202604171930.9e5cf48d] - 2026-04-17

- ✨ Features
  - Monitoring: Added MonitoringDashboard UI scaffolding with full analytics components (types, charts, monitoring analytics).
  - 🧪 Automated CI/CD: CIMD-enabled Keycloak build and startup workflow (kc.sh build --features=cimd) with updated docker configurations.

- 🔧 Chores & Improvements
  - FHIR client: Major refactor exposing extended DTR/PAS types and exports in fhir-client.ts.
  - UI/UX: Replaced multiple in-component buttons and loaders with centralized LoadingButton for consistency across dialogs and dashboards; introduced centralized LoadingButton usage and new SearchInput component across several modules.
  - UI polish: Replaced empty-state blocks with reusable EmptyState components; adjusted paddings and layout tweaks.
  - Metadata & versioning: Version bumps across multiple apps/packages to 0.0.6-alpha.202604171839.cb1b0696 (and related commits).

- 🗂️ Documentation
  - Backend/public app HTML styling updates to reflect app presence.

Note: No breaking changes or user-facing API changes identified beyond UI refactors and CIMD enablement.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/433


## [0.0.6-alpha.202604171904.9e0b06b8] - 2026-04-17

- ✨ Features
  - Core: Expanded FHIR client typing and exports to support DTR/PAS types (major refactor).
  - Monitoring: Added new MonitoringDashboard UI scaffold with charts and analytics.

- 🔧 Chores & Improvements
  - UI/UX: Replace empty-state blocks with reusable EmptyState components; adjust paddings and sizes across multiple dashboards and dialogs.
  - UI: Centralized loading states using LoadingButton across numerous components; introduced new SearchInput utility and migrated dialogs/forms to use it.
  - Admin/backend: Introduced admin route and schemas for CIMD client policies; enable CIMD in Keycloak build and startup; updated Docker/HTML scaffolding to reflect app presence.
  - Versioning: Bump multiple apps/packages to 0.0.6-alpha.202604171839.cb1b0696 / 202604171904.9e0b06b8 (per release).

- 🐛 Bug Fixes
  - A number of UI components updated to fix spacing, imports, and layout tweaks while preserving functionality.

- ⚠️ Breaking Changes
  - None detected in user-visible changes beyond internal refactors.

If any further grouping or emphasis is desired, I can adjust.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/432


## [0.0.6-alpha.202604171839.cb1b0696] - 2026-04-17

- ✨ Features
  - CIMD: Enable in Keycloak build/startup (kc.sh build --features=cimd) and corresponding docker-compose/Dockerfile updates.
  - UI/UX: Introduced centralized LoadingButton across dialogs/forms/dashboards; replaced inline loaders and spinners.
  - UI/UX: Replaced many in-component buttons with LoadingButton, supporting loading state and status text.
  - UI/UX: Introduced SearchInput component in multiple dashboards.

- 🔧 Chores & Improvements
  - UI/UX: Replaced inline icons/Loader2 with LoadingButton across modules; preserved disabled logic.
  - UI/UX: Added/updated LoadingButton usage in numerous components (e.g., dialogs, dashboards, forms).
  - UI/UX: UI refinements across several screens (empty-state improvements, paddings/sizes).
  - MCP metadata: Added client_registration_types_supported for CIMD and DCR; minor metadata route adjustments.
  - Backend/Frontend: HTML styling scaffold updates to reflect app presence.

- 📚 Documentation
  - Version bumps across apps/packages to 0.0.6-alpha.202604171839.cb1b0696.

- ⚠️ Breaking Changes
  - None detected.

Notes:
- No update-only, merge, or metadata commits included beyond the version bump; changes focused on feature adoption (CIMD enablement) and UI/UX improvements.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/431


## [0.0.6-alpha.202604171751.36bdde82] - 2026-04-17

- 🔧 Chores & Improvements: General UI responsiveness improvements across AdminApp, Patient Portal, and shared UI components (layout/padding adjustments, responsive typography, and improved wrapping on small screens)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/430


## [0.0.6-alpha.202604171740.60503a70] - 2026-04-17

- ✨ Features
  - Responsive UI enhancements across admin panels and patient portal components (smaller screens: tighter paddings, wrapping layouts, and scrollable tab containers).

- 🐛 Bug Fixes
  - Improve readability and layout stability on small screens by adjusting avatar/text truncation, header spacing, and action row wrapping.

- 🔧 Chores & Improvements
  - UI layout refinements: padding, alignment, and responsive behavior improvements across multiple components (Dashboard, AppHeader, PatientBanner, etc.).

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/429


## [0.0.6-alpha.202604171724.b96bc9d1] - 2026-04-17

- 🔧 Chores & Improvements: Bump version from 0.0.6-beta to 0.0.6-alpha across apps/packages; add App Store page HTML scaffold in backend/public/apps/index.html for App Store template styling and language.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/428


## [0.0.6-alpha.202604171701.d8ce01a0] - 2026-04-17

- 🔧 Chores & Improvements: Version bump to 0.0.6-alpha.202604171701.d8ce01a0 across multiple apps/packages
- 🔧 Chores & Improvements: Added App Store page HTML scaffold (backend/public/apps/index.html) with language and styling groundwork

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/427


## [0.0.6-alpha.202604171652.bfc0f3a4] - 2026-04-17

- 🔧 Chores & Improvements: Version bump to 0.0.6-alpha.202604171652.bfc0f3a4 across packages
- 🔧 Chores & Improvements: Minor code adjustment in patient-portal (alias AnyFhirResource to AnyResource in ips-display-helpers.tsx)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/426


## [0.0.5-beta.202604171638.2b948412] - 2026-04-17

- 🔧 Chores & Improvements: Version bump to 0.0.5-beta.202604171638.2b948412 across multiple apps/packages
- 🔧 Chores & Improvements: Enhancement in patient-portal fhir-client.ts to support polymorphic fields by broadening AnyFhirResource type (Resource & Record<string, any>)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/424


## [0.0.5-alpha.202604171601.38ae67c2] - 2026-04-17

- ✨ Features: Version bump to 0.0.5-alpha.202604171601.38ae67c2 across multiple apps/packages (consent-app, dtr-app, patient-portal, smart-dicom-template, ui, testing/e2e) indicating pre-release readiness. Updated bun.lock to reflect new alpha versions.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/422


## [0.0.5-alpha.202604171542.4f5f6b30] - 2026-04-17

- 🔧 Chores & Improvements: Internal type tightening and imports across UI and client code
  - Strengthened type safety for status/priority-related fields (e.g., SubscriberRelationshipCode, PublicationStatus, QuestionnaireAnswersStatusCode) and applied type-satisfies in multiple components (CoverageCard, QuestionnaireBrowser/Renderer, SmartFormsQuestionnaireRenderer, fhir-client, pas-builder, questionnaire-populate)
  - Updated legacy priority code to "routine" in Claim.status

Note: No user-facing features or breaking changes detected.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/421


## [0.0.5-alpha.202604170523.033834ca] - 2026-04-17

- ✨ Features: Internationalization groundwork
  - Added i18n initialization and language-switching support across Patient Portal and related components.
  - Introduced language switching UI and translation keys integration.

- 🔧 Chores & Improvements: Dependency and UI tweaks
  - Added i18next-related dependencies to Patient Portal.
  - UI refinements for compact StatCard and AI Agents statistics (smaller icons, tighter spacing, right-aligned monospaced numbers, adjusted subtitles).

- 🔧 Chores & Improvements: Build and lockfile updates
  - Updated bun.lock with version bumps and new i18n dependencies reflected in patient-portal.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/420


## [0.0.5-beta.202604170514.a417a1fe] - 2026-04-17

- ✨ Features: 
  - Patient Portal: add internationalization dependencies (i18next, i18next-browser-languagedetector, i18next-http-backend) and react-i18next for localization

- 🔧 Chores & Improvements:
  - UI tweaks:
    - RecordEditModal: narrow type for updated resource
    - SmartAppsStatistics: adjust AI Agents StatCard icon text size and spacing
    - stat-card: compact card layout improvements (padding, inner layout, truncation handling); right-aligned, monospaced numbers; subtitle positioning/size adjustments

- ⚠️ Breaking Changes: None

- 📚 Documentation: None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/419


## [0.0.5-alpha.202604170514.a417a1fe] - 2026-04-17

- ✨ Features: Added RecordEditModal component with editable fields for multiple resource types and integration with updateResource; wrapped App and Toaster with TooltipProvider; Dashboard now refreshes on resource updates via onResourceUpdated callback.
- 🔧 Chores & Improvements: Extend RecordDetailModal with edit capabilities (Pencil icon, updated imports/types); introduce updateResource function in fhir-client for PUT updates with error handling.  
- 🐛 Bug Fixes: UI adjustments to PatientBanner and related modals to support birth sex and gender identity/pronouns extensions; align seed data and display labels to new sleep-related metric (Hours of Sleep) and corresponding IDs.  
- 📚 Documentation: (None)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/418


## [0.0.5-alpha.202604170510.0b6481f5] - 2026-04-17

- ✨ Features: Add RecordEditModal component and related UI to edit multiple resource types; extend UI to support birth sex, gender identity, and pronouns via new FHIR extensions.
- 🔧 Chores & Improvements: Wrap app and toaster with TooltipProvider; refresh Dashboard data on resource updates; implement updateResource in fhir-client for PUT with error handling.
- 🐛 Bug Fixes: Update seed data and metrics mapping to reflect sleep-related metrics (replacing height/CM with hours of sleep) and align IDs/values accordingly.
- 📚 Documentation: (None)
- ⚠️ Breaking Changes: (None)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/417


## [0.0.5-alpha.202604170503.5151028d] - 2026-04-17

- 🔧 Chores & Improvements: Internal updates and maintenance
- 🐛 Bug Fixes: Hide redundant gender identity badge when it matches admin gender

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/416


## [0.0.5-alpha.202604170333.ed8297ff] - 2026-04-17

- 🔧 Chores & Improvements: Version bump to 0.0.5-alpha.202604170333.ed8297ff across multiple packages; align lockfiles and dependencies
- 📚 Documentation: Add new package hl7.fhir.uv.ips-generated to patient-portal
- 🐛 Bug Fixes: Update IPS-generated value sets and status codes usage across patient-portal components (GenomicsCard, ImagingStudyCard, Dashboard, RecordDetailModal, fhir-client, ips-display-helpers) to match new UV Ips codes
- ⚠️ Breaking Changes: Update type imports/casts to new UV Ips codes (potential integration impact)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/414


## [0.0.5-alpha.202604170317.c528b329] - 2026-04-17

- 🔧 Chores & Improvements: Version bumps across apps to 0.0.5-alpha.202604170317.c528b329
- 🔧 Chores & Improvements: Update dependencies and lockfiles to reference new alpha version
- 🐛 Bug Fixes: Align ImagingStudy status typing with FHIR R4 and adjust ImagingStudy status retrieval
- 🐛 Bug Fixes: Replace DiagnosticReportStatus code import with new alias (DiagnosticReportStatusUvIpsCode) in GenomicsCard and fhir-client

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/413


## [0.0.5-alpha.202604170307.f3dce54b] - 2026-04-17

- 🔧 Chores & Improvements: Bump version fields across all apps to 0.0.5-alpha.202604170307.f3dce54b; update backend E2E tests to reference dynamic config.name in routes/constants.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/412


## [0.0.5-alpha.202604170209.6880bd72] - 2026-04-17

- 🔧 Chores & Improvements: Version bumps across multiple packages to 0.0.5-alpha.202604170209.6880bd72; updated binary tarballs for key apps/libs (dtr-app, patient-portal, smart-dicom-template, HL7 tarballs).

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/411


## [0.0.5-alpha.202604170157.133d8548] - 2026-04-17

- 🔧 Chores & Improvements: Add GitHub Actions workflow "Copilot Auto-Fix (TDD)" with scheduling, inputs, permissions, concurrency, and auto-fix pipeline
- 🔧 Chores & Improvements: Bump version strings from beta to alpha across apps/tests (0.0.5-beta... to 0.0.5-alpha...)
- 🐛 Bug Fixes: Replace generated type import with a standard FHIR remittance-outcome code type alias in PaRequestList.tsx

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/410


## [0.0.5-alpha.202604162216.5f5379a7] - 2026-04-17

- 🔧 Chores & Improvements: Version string updates across multiple apps (bun.lock) to 0.0.5-alpha.202604162200.7d5af0e2 (consent-app, dtr-app, patient-portal, smart-dicom-template, UI, and others)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/409


## [0.0.5-alpha.202604162200.7d5af0e2] - 2026-04-16

- ✨ Features
  - Expanded UI: PaReviewSubmit now displays DOB, gender, and birth sex using US Core demographics; PatientBanner initializes and shows Birth Sex with improved tooltip.
  - 🧪 Added new US Core packages: patient-extensions and questionnaire-extensions.
  - 📚 Documentation / metadata: QuestionnaireBrowser now renders metadata badges (Signature, CQL, Modular) via new getQuestionnaireMetadata.
  - 🔧 Chores & Improvements: Updated ImagingStudy imports in DICOM template components to use hl7.fhir.uv.ips-generated types.
- ⚠️ Breaking Changes
  - None detected
- 🐛 Bug Fixes
  - None detected
- 💡 Chores (internal)
  - Version bump from 0.0.5-beta to 0.0.5-alpha across multiple apps

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/408


## [0.0.5-alpha.202604161742.aaf0299e] - 2026-04-16

- ✨ Features:
  - Expanded DTR UI: PaReviewSubmit now uses US Core demographics to display DOB, gender, and birth sex; PatientBanner initializes and shows Birth Sex with tooltip enhancements.
  - QuestionnaireBrowser: renders additional metadata badges (Signature, CQL, Modular) using new getQuestionnaireMetadata.
  - Added new US Core patient extensions package (patient-extensions.ts) and questionnaireExtensions (questionnaire-extensions.ts).

- 🔧 Chores & Improvements:
  - Bumped pre-release versions to 0.0.5-alpha.202604161742.aaf0299e across multiple apps.
  - Updated imports for ImagingStudy in DICOM template components to use hl7.fhir.uv.ips-generated types.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/407


## [0.0.5-alpha.202604161440.af9f8d53] - 2026-04-16

- 🔧 Chores & Improvements: Bump pre-release versions from beta to alpha across multiple packages
- 📚 Documentation: Update TypeScript type aliases and IPS value set references to align with new FHIR IPS codes
- 🔧 Chores & Improvements: Minor code adjustments to status code typings (DiagnosticReportStatusCode, ImagingStudyStatusCode)
- ⚠️ Breaking Changes: Updated IPS value sets and related types may affect integrations relying on older codes
- 🔧 Chores & Improvements: Binary artifacts and assets re-generated (tgz) and updated in lockfile
- ⚠️ Breaking Changes: Asset generation changes may impact downstream asset consumption

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/406


## [0.0.5-alpha.202604160405.a434e8e3] - 2026-04-16

- ✨ Features
  - Version bump to 0.0.5-alpha.202604160405.a434e8e3 across apps (consent-app, dtr-app, patient-portal, smart-dicom-template, ui, e2e) and root package.json

- 🔧 Chores & Improvements
  - Dependency: babelfhir-ts updated from 1.3.8 to 1.3.10 in root package and bun.lock

- 🛠️ Bug Fixes / Refactors
  - DTR PA Request: OUTCOME_STATUS_MAP key type updated from RemittanceOutcomeCode to ClaimProcessingCodesCode
  - QuestionnaireRenderer: removed import of DTRStdQuestionnaireItem; use generic item type in get

- ⚠️ Breaking Changes
  - None identified

- 📚 Documentation
  - None identified

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/405


## [0.0.5-alpha.202604160348.25f9e5ab] - 2026-04-16

- 🔧 Chores & Improvements: Version bumps across all packages for alpha release
- ✨ Features: Added DocumentsCard component and integrated document/documentReference rendering and cross-linking in patient-portal (DocumentsCard usage, DocumentReference context linkage)
- 🐛 Bug Fixes: Minor type and code adjustments (DTR metrics casting, questionnaire input parameter type, tsconfig isolatedModules/types)
- 🔧 Chores & Improvements: Update imports and state handling for DocumentsCard and related document references in Dashboard and RecordDetailModal

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/404


## [0.0.5-beta.202604160334.ca7dae83] - 2026-04-16

- ✨ Features: 
  - Introduced DocumentsCard component (DocumentsCard.tsx) to render DocumentReference resources.
  - Dashboard now uses DocumentsCard and includes documents state; DocumentsCard/documents integrated into types.
  - DocumentImport now saves resource references and attaches them to DocumentReference.context.related; collects saved resource IDs.
  - RecordDetailModal updated to import Link2, expose documents prop, and cross-reference usage for document linkage.

- 🔧 Chores & Improvements:
  - General version bump across multiple packages to 0.0.5-beta.202604160334.ca7dae83.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/403


## [0.0.5-alpha.202604160313.bf090bfc] - 2026-04-16

- ✨ Features: None
- 🐛 Bug Fixes:
  - fix(consent-app): replace missing TaskIntentCode import with Task["intent"] (quotentiroler)
- 📚 Documentation: 
  - docs: update CHANGELOG.md for PR #400
- 🔧 Chores & Improvements:
  - chore(testing): update alpha SMART compliance report
  - update version to 0.0.5-alpha.202604160313.bf090bfc (alpha) [skip ci]
- ⚠️ Breaking Changes: None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/401


## [0.0.5-alpha.202604160240.90c9ae50] - 2026-04-16

- 🔧 Chores & Improvements: CI workflow updated to manual CI via workflow_dispatch with per-branch concurrency; version bumps across apps from beta to alpha; bun.lock updates.

- ✨ Features: 
  - Patient portal: Type-safe IPS value-set updates, new ips-display-helpers.tsx with type exports and RecordName component; ImagingStudy status checks updated to ImagingStudyStatusUvIps; verification status logic added in RecordDetailModal.
  - FHIR client: Added strict type checks for clinical codes in search conditions and searchAllergies queries.
  - E2E tests: Added acceptance for Keycloak consent grant in login flows; new test scripts for beta project.
  
- 🔧 Chores & Improvements (CI/CD and tests): Testing config: Playwright target default updated; E2E env target default updated from alpha to beta for E2E targets.

- ⚠️ Breaking Changes: None detected.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/400


## [0.0.5-beta.202604160211.102adcda] - 2026-04-16

- 🔧 Chores & Improvements: Bump to 0.0.5-beta.202604160211.102adcda across apps; add new dependency hl7.fhir.uv.smart-app-launch-generated; update bun.lock with version and dependency alignment

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/399


## [0.0.5-alpha.202604160155.0d91a611] - 2026-04-16

- 🔧 Chores & Improvements: CI/CD and version bumps across multiple apps to 0.0.5-alpha.202604160155.0d91a611
- ✨ Features: DTR UI enhancements including PR list/status mapping, extended imports/types, and new UI state for filters (publisher/status) with Filter component
- 🔧 Chores & Improvements: DTR client/fhir refactor — migrate entity methods to new client paths (pAS* → practitioner/coverage/serviceRequest) with type casts
- ✨ Features: DTR metrics added
- 📚 Documentation: (none)
- 🐛 Bug Fixes: (none)
- ⚠️ Breaking Changes: (none)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/396


## [0.0.5-alpha.202604160124.af7d2b79] - 2026-04-16

- ✨ Features: DTR integration enhancements
  - Switch to dtr-generated FHIR types across core UI (App.tsx, Dashboard, PatientBanner)
  - Expanded questionnaire handling with DTR-specific imports and new extensions utilities
  - Updated questionnaire populate flow to support DTR parameters
  - Added new lib: dtr-extensions.ts; updated fhir-client.ts to reference dtr-generated types
  - Minor UI/logic updates in QuestionnaireRenderer.tsx to align with DTR changes

- 🔧 Chores & Improvements: Repository-wide version bump to alpha"

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/395


## [0.0.5-alpha.202604152114.2fc91380] - 2026-04-16

- 🔧 Chores & Improvements: CI updates for e2e-consent-tests and test orchestration
- 🔧 Chores & Improvements: Dependency updates to use babelfhir-ts client-r4 in consent app
- 🔧 Chores & Improvements: Dependency and asset housekeeping (bun.lock bump, updated tgz assets)
- 🔧 Chores & Improvements: Updated smart-auth import and FHIR client writers usage
- 📚 Documentation: (None)
- ✨ Features: (None)
- 🐛 Bug Fixes: (None)
- ⚠️ Breaking Changes: (None)

If no meaningful changes beyond maintenance, return:
- 🔧 Chores & Improvements: Internal updates and maintenance

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/394


## [0.0.5-alpha.202604152103.e8069208] - 2026-04-15

- 🔧 Chores & Improvements: CI: rename install step and add separate Playwright browsers install; version bumps across apps and testing package.json from beta to alpha
- 🔧 Chores & Improvements: Testing: E2E package.json version bump
- ✨ Features: Smart DICOM: add Cornerstone lazy init (cornerstone-init.ts) and ensureCornerstoneInit() usage to initialize Cornerstone and set OAuth token on WADO-RS requests

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/393


## [0.0.5-alpha.202604152049.bc89605a] - 2026-04-15

- ✨ Features: Add Cornerstone lazy init (cornerstone-init.ts; ensureCornerstoneInit usage to initialize Cornerstone and set OAuth token on WADO-RS requests)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/392


## [0.0.5-alpha.202604152034.0c3c9092] - 2026-04-15

- 🔧 Chores & Improvements: CI/CD and test strategy enhancements
  - Add e2e consent Playwright workflow and integrate e2e-consent-tests into testing strategy with parallel execution and status propagation
  - Bump versions from alpha to beta across multiple apps and testing package
  - Enable Keycloak Organizations on realm startup (idempotent) and update realm export to include organizationsEnabled

Note: No user-facing breaking changes detected.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/391


## [0.0.5-beta.202604151909.07673e90] - 2026-04-15

- 🔧 Chores & Improvements: Fix recurring package.json merge conflicts on develop→test PRs
- 📚 Documentation: Update SMART compliance reports (alpha/beta/dev) [skip ci]

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/389



- 🔧 Chores & Improvements: Enable Keycloak Organizations on startup and ensure realm export includes organizationsEnabled: true
  - Add ensureOrganizationsEnabled() on startup
  - Authenticate admin and enable organizationsEnabled when possible
  - Updated realm export to persist organizationsEnabled setting

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/390


## [0.0.5-beta.202604151830.cce514f1] - 2026-04-15

- ✨ Features: 
  - Add organizations module (UI) including OrgAddForm, OrgBrandingTab, OrgTable, OrgMembersDialog, OrgStatisticsCards, OrgBrandConfig, OrgBrandConfigResponse; extended admin routes to support per-org branding/config and organizations.
  - Extend API models to include organizationId/organizationIds payloads; add CreateOrganizationRequest and related Organization types.

- 🔧 Chores & Improvements:
  - Bump Keycloak image/version references and update CI/CD assets to new alpha tag.
  - Align UI and API clients with new Organization-related models (shared Organization type, updated payloads and validations).
  - Update generated models, runtime schemas, and validation logic to support newly introduced Organization entities.

Notes:
- No breaking changes detected.
- No user-facing API removals identified beyond new organization-branding features.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/387


## [0.0.5-alpha.202604151618.09324581] - 2026-04-15

- ✨ Features: 
  - UI/dashboard: added HealthChartsCard component for vitals/labs charting; ImagingStudyCard layout tweaks (full-width container)
  - HealthChartsCard.tsx added for extensive charting (Recharts)

- 🔧 Chores & Improvements:
  - CI/CD: Beta deployment workflow seeds DICOM into Orthanc (seed-dicom.sh added and made executable; copies CTImage.dcm; creates dicom dir); attempts runtime seeding if Orthanc IP resolvable
  - Version bumps across multiple apps to 0.0.5-alpha.202604151601.1dba7fb1
  - UI/consent/dtr/patient-portal/smart-dicom-template/ui updates to reflect new version
  - patient-portal: added recharts dependency

- 🧪 Bug Fixes (minor):
  - E2E test: patient-portal imaging-pipeline test updated OAuth client_id from patient-portal to inferno-test-client

- 📚 Documentation:
  - (None)

- ⚠️ Breaking Changes:
  - (None)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/386


## [0.0.5-alpha.202604151504.df46b9f0] - 2026-04-15

- 🔧 Chores & Improvements: Version bump across all packages to 0.0.5-alpha.202604151504.df46b9f0
- 🔧 Chores & Improvements: UI refresh logic added (useCallback, refreshKey, refreshData) in patient-portal Dashboard
- 🔧 Chores & Improvements: refreshData triggered on close for DocumentImport and PatientScribe
- 🔧 Chores & Improvements: useEffect dependency updated to include refreshKey

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/385


## [0.0.5-alpha.202604151036.3c3941a0] - 2026-04-15

- 🔧 Chores & Improvements: Simplify base URL handling for patient-portal (use config.proxyBase for importDocument and scribeFromText)
- 🔧 Chores & Improvements: Streamline Keycloak realm-export.json by keeping only realm-admin client in realm-management permissions

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/384


## [0.0.5-beta.202604150924.45a4b086] - 2026-04-15

- ✨ Features
  - Added PatientScribe feature (frontend UI in Patient Portal; backend Scribe support with new API route /api/patient-scribe and generateFromText flow)

- 🔧 Chores & Improvements
  - UI/UX: minor Pie component label formatting fix to handle undefined percent
  - Backend: remove meta.tag from extracted resources in doc-import.ts
  - Version bumps across multiple apps and testing packages

- ⚠️ Breaking Changes
  - None detected

- 📚 Documentation
  - None

- 🐛 Bug Fixes
  - None detected

If you want stricter grouping or want to exclude version bumps, say the word.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/382


## [0.0.5-beta.202604142134.629fe5cd] - 2026-04-14

- ✨ Features: Introduced strict capabilities checks across UI and backend, including SetStrictCapabilities API/types, UI toggle in FhirServersManager, and persistence/enforcement of strictCapability statements. Added monitoring dashboards/services (auth/email) and new AdminAudit/Email/Auth monitoring models and routes. Expanded OpenAPI typings and health/status models to support monitoring features.
- 🔧 Chores & Improvements: Version bumps across multiple apps/tests; updated Admin/OpenAPI client references; added new logger hooks for backend monitoring; refreshed health-related models and system status representations. 
- 📚 Documentation: (none)
- ⚠️ Breaking Changes: (none detected)
- 🐛 Bug Fixes: (none detected)

If you need stricter grouping or fewer categories, I can adjust.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/380


## [0.0.5-alpha.202604141522.6c31e760] - 2026-04-14

- 🔧 Chores & Improvements: Remove readOnlyForUsers config flag and related write-blocking feature; update FHIR proxy and tests to reflect scope/role-based filtering only
- 🧪 Features: Add FHIR capabilities feature (parsing, server capabilities model, and admin route) with proxy checks for capability support
- 📚 Documentation: README adds Scalability section with Keycloak-based details
- 🔧 Chores & Improvements: Extend fhir-capabilities exports/utilities and tests; wire new route into app factory
- 🐛 Bug Fixes: Harden searchFlags handling in fhir-client to gracefully handle unsupported Flag searches
- 🔧 Chores & Improvements: Version bumps across apps/tests and minor test/utility updates to accommodate new capability checks

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/377


## [0.0.5-alpha.202604140601.c4e1fb8a] - 2026-04-14

- 🔧 Chores & Improvements: CI/CD modernization with widespread GitHub Actions upgrades (checkout, tokens, core actions, Python setup) across pipelines
- 🔧 Chores & Improvements: Restrict workflow triggers to backend/lib/shared-ui/apps/Dockerfiles/keycloak/package.json/testing/keycam and workflow file changes; preserve existing main push with tags

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/376


## [0.0.5-beta.202604140505.378c2cf1] - 2026-04-14

- 🔧 Chores & Improvements: CI/CD simplifications for beta workflow
  - Remove separate frontend image build; beta now builds only backend and Keycloak
  - Dropped frontend image variable in beta deployments; adjust .env.beta wiring
  - Dockerfile: consolidate multi-stage build; remove UI-specific ARGs; set UI base path to /webapp/
  - Dockerfile.mono removed; CI uses Dockerfile for mono image
  - docker-compose: prod config now excludes separate frontend service; single-container front-end approach
  - Infra: update backend image source to use Dockerfile (not Dockerfile.mono) for mono container
  - package.json: simplify docker:mono script to use default Dockerfile

Note: No user-facing feature changes detected; only maintenance/CI improvements.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/374


## [0.0.5-alpha.202604140457.1f5d7b71] - 2026-04-14

- ✨ Features
  - Backend: Keycloak startup behavior improved with reachability checks and a friendly downtime page; uptime is now included in degraded status responses. 
  - Health: /health endpoint updated to be a liveness probe always returning 200 with subsystem statuses; degraded when issues exist but unhealthy state removed.

- 🐛 Bug Fixes
  - Health/status logic: refine overall health computation to ignore not_configured components and treat Keycloak not_configured as non-blocking; preserve degraded state if any configured component is degraded.
  - Proxy memory/Java options: adjust resource limits and JVM flags for proxy-smart-hapi-fhir-beta to optimize performance.

- 🔧 Chores & Improvements
  - CI/CD: pre-push hooks updated to preserve merge commits during rebase; CI rebase prep for develop/test branches.
  - Admin/UI refactor: reorganized Admin Tabs imports and paths due to rename/move of admin-tabs module; updated exports accordingly.
  - Versioning: bump versions across workspace packages to 0.0.5-alpha.202604140457.1f5d7b71.

- 📚 Documentation
  - Changelog note added for 0.0.5-alpha pre-release with mention of meaningful changes and Admin UI export breaking change.

- ⚠️ Breaking Changes
  - AdminTabs export removed from shared-ui; access via new app-local path after module rename.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/371


## [0.0.5-alpha.202604140433.915ebd9f] - 2026-04-14

- ✨ Features
  - Admin UI: API/structure refactor for admin tabs; updated import paths and exposure to app-local scope (da65e5d8)
- 🐛 Bug Fixes
  - Health: refine health derivation to treat not_configured statuses as non-blocking; keep degraded on configured outages (915ebd9f)
  - Health: adapt /health endpoint to be a liveness probe with 200 and payloads reflecting subsystem health; 503 removed for health, degraded on error (e10f674)
- 🔧 Chores & Improvements
  - CI/CD: pre-push hooks to use --rebase=merges to preserve merges during rebases (0fa2524e)
  - CI/CD: pre-push CI syncs to rebase local branches against origin (0d65ecaa)
  - Resource limits: adjust proxy-smart-hapi-fhir-beta memory/Java options (increase, then later reduce to 768m with tuned JVM settings) (744725a1, 746b438e)
  - Health: minor health calculation tweaks to exclude not_configured components from overall healthy status (915ebd9f)
- 📚 Documentation
  - N/A
- ⚠️ Breaking Changes
  - AdminTabs export moved: AdminTab and ADMIN_TABS removed from shared-ui index; now provided via app-local path after rename (da65e5d8)

If no meaningful user-facing changes, would output a chore-only line; here there are several user-facing/maintainer-focused updates.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/370


## [0.0.5-alpha.202604140357.b70b6a3c] - 2026-04-14

- ✨ Features: Introduced shared hook useSmartAuth (with SmartAppState, SmartAuthLike, UseSmartAuthOptions) and integrated startAuth/onAuthenticated flow across apps; updated AppHeader/Button/Spinner and re-exported useSmartAuth from shared-ui.
- 🐛 Bug Fixes: Handle “state mismatch” errors across apps robustly—clear token, reset URL, show friendly message, and mark session as expired; preserve existing error handling for auth callback failures.
- 🔧 Chores & Improvements: Improve admin utils to explicitly update user fields (firstName, lastName, email, enabled, emailVerified) and merge existing user attributes on updates rather than wholesale replacement.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/369


## [0.0.5-alpha.202604140338.9e4b2b09] - 2026-04-14

- ⚠️ Breaking Changes
  - None detected

- ✨ Features
  - None detected

- 🐛 Bug Fixes
  - State mismatch error handling across apps: on auth callback failures, now clear token, reset URL, show friendly message, and mark session as expired.

- 🔧 Chores & Improvements
  - Admin utilities: expand setUserAttribute updates to include explicit fields (firstName, lastName, email, enabled, emailVerified).
  - Healthcare users: improve PUT handling to merge existing attributes with updates instead of wholesale replacement; preserve existing attributes when not provided and handle correct array/string merging.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/368


## [0.0.5-beta.202604140206.9147fc91] - 2026-04-14

- 🔧 Chores & Improvements: Update healthcheck to use HTTP/1.0 and extend timeout (10s) for more reliable readiness checks

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/365



- 🔧 Chores & Improvements: Refine user attribute handling and merge logic
  - Expand setUserAttribute updates to include explicit fields (firstName, lastName, email, enabled, emailVerified)
  - For healthcare-users, change PUT handling to merge existing attributes with incoming data (preserve existing attrs when not provided; handle arrays/strings correctly) instead of wholesale replacement

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/367


## [0.0.5-alpha.202604140101.5ffd0475] - 2026-04-14

- ✨ Features: add alpha fallback when beta backend is down (lb_policy first)
- 🐛 Bug Fixes: wait for keycloak before canary; accept 503 as valid health response
- 🔧 Chores & Improvements: update version to 0.0.5-alpha.202604140101.5ffd0475
- 📚 Documentation: update CHANGELOG.md for PR #362
- 📚 Documentation: update CHANGELOG.md for PR #361
- ⚠️ Breaking Changes: none
- 🔧 Chores & Improvements: sync package versions after rebase
- 🔧 Chores & Improvements: update dev/beta SMART compliance reports (maintenance tasks)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/363


## [0.0.5-beta.202604140029.1e628bdb] - 2026-04-14

- 🐛 Bug Fixes: Publish canary port and host curl check (quotentiroler)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/361



- ✨ Features: Add alpha fallback when beta backend is down (lb_policy first)
- 🔧 Chores & Improvements: Sync package versions after rebase
- 🔧 Chores & Improvements: Update beta SMART compliance reports (dev/beta) 
- 🔧 Chores & Improvements: Update version to 0.0.5-beta.202604140029.1e628bdb

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/362


## [0.0.5-alpha.202604132116.231c33d9] - 2026-04-13

- 🔧 Chores & Improvements: Added aud/resource validation in /authorize for SMART App Launch; expands AuthorizationQuery with aud, resource, and launch fields and per-version endpoint checks

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/359


## [0.0.5-alpha.202604131823.7abd63e1] - 2026-04-13

- 🔧 Chores & Improvements: Update versioning and documentation references
  - Bump version to 0.0.5-alpha.202604131823.7abd63e1
  - Update CHANGELOG.md for PR #357

- ⚠️ Breaking Changes: None

- ✨ Features: None

- 🐛 Bug Fixes: None

- 📚 Documentation: None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/358


## [0.0.5-alpha.202604131802.68b7ac1e] - 2026-04-13

- 🔧 Chores & Improvements: Sync package versions after rebase
- 🔧 Chores & Improvements: Start infra services before canary; dump logs on failure
- 📚 Documentation: Update CHANGELOG.md for PR #356

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/357


## [0.0.5-alpha.202604131748.f8c77aab] - 2026-04-13

- ✨ Features: Introduces expectedIssuer getter for OpenID issuer validation; lazy JWKS handling with runtime-config-aware client and caching; dynamic reinitialization on JWKS URI changes
- 🔧 Chores & Improvements: Test utilities updated to use a no-op logger proxy to safely isolate tests; ensured docker network for canary starts only if proxy-smart-beta-network exists to prevent issues after prune/full stop
- ⚠️ Breaking Changes: None
- 📚 Documentation: None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/356


## [0.0.5-alpha.202604131657.d291256d] - 2026-04-13

- 🔧 Chores & Improvements: Update GitHub Actions caching scope for beta backend image (cache-from/cache-to) from beta-backend to beta-backend-v2

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/354


## [0.0.5-alpha.202604131634.3494abfa] - 2026-04-13

- ✨ Features: 
  - Introduced OpenDataLoader-based PDF extraction path (PDF to Markdown via @opendataloader/pdf)
  - Added PDF extraction types and engine plumbing (PdfEngine, PdfExtractResult)

- 🔧 Chores & Improvements:
  - Dockerfiles updated to install Java 21 JRE across backend and mono/prod stages; clarifying Java 21 requirement for @opendataloader/pdf
  - Backend build and package adjustments:
    - Refined build command usage for backend (target handling and removing external sharp reference)
    - Replaced zerox dependency with @opendataloader/pdf in backend package.json
  - Updated document-import flows to pass engine through admin and API routes to use the new PDF extraction path

- ⚠️ Breaking Changes: None detected

- 📚 Documentation: None detected

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/353


## [0.0.5-alpha.202604131611.0165ae0c] - 2026-04-13

- 🔧 Chores & Improvements: Minor string escaping update in deploy-beta workflow (no logic changes)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/352


## [0.0.5-alpha.202604131601.650eb30a] - 2026-04-13

- 🔧 Chores & Improvements: Add health checks across services and Docker Compose, including health-based readiness for Caddy reverse_proxy entries and a new healthcheck script
- 🔧 Chores & Improvements: Implement blue/green canary deployment flow with separate canary container and pre-swap validation
- 🔧 Chores & Improvements: Update beta deploy workflow to use canary flow and Bun-based backend health check on port 8445

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/351


## [0.0.5-alpha.202604131554.90d89c8d] - 2026-04-13

- 🔧 Chores & Improvements: Beta deploy workflow updated to blue/green canary flow with separate canary container and pre-swap validation on port 9445
- 🔧 Chores & Improvements: docker-compose.beta.yml now includes backend healthcheck on port 8445 using Bun for /health, plus standard healthcheck settings

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/350


## [0.0.5-alpha.202604131547.1bf214db] - 2026-04-13

- 🔧 Chores & Improvements: Exclude external dependency (sharp) from bundling in build process (bun build --external sharp) to reduce bundle size and avoid bundling issues.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/349


## [0.0.5-alpha.202604131524.f9c8fc5d] - 2026-04-13

- 🔧 Chores & Improvements: CI optimizations (skip SMTP config when already set, reduce Keycloak wait)

- 📚 Documentation: Update CHANGELOG for PR #347

- 🔧 Chores & Improvements: Update version references to 0.0.5-alpha.202604131524.f9c8fc5d

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/348


## [0.0.5-alpha.202604131404.221b9263] - 2026-04-13

- 🔧 Chores & Improvements: CI/CD housekeeping and maintenance (Docker pruning, SMART compliance report updates)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/347


## [0.0.5-alpha.202604131352.a13c604e] - 2026-04-13

- 🔧 Chores & Improvements: PACS status pre-check on mount and enhanced status handling across UI and backend
  - Dashboard.tsx: add PACS status check on mount; store pacsAvailable state; integrate non-blocking check in data load flow
  - DicomUpload.tsx: extend status handling with PACS pre-check; new PacsStatus type usage; added ServerOff icon; new UploadStep "checking"/"unavailable"; initial step set to "checking"
  - dicomweb.ts: introduce PacsStatus type; implement checkPacsStatus() calling /status; improve STOW error handling with connection/refusal details
  - backend dicomweb routes: enhanced error logging for connection/refused scenarios; friendlier messages; minor status handling improvements

- ⚠️ Breaking Changes: None identified

- ✨ Features: PACS availability status integration and pre-checks

- 🐛 Bug Fixes: Improved error messaging for upstream/DICOMweb issues

- 📚 Documentation: None identified

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/346


## [0.0.5-alpha.202604131345.23848337] - 2026-04-13

- 🔧 Chores & Improvements: PACS status pre-check on mount integrated into dashboard and upload flow; enhanced PacsStatus typing and status handling across dicomweb.ts and UI components
- 🐛 Bug Fixes: Improved error logging for backend dicomweb routes to include connection/refusal details and friendlier messages
- ⚠️ Breaking Changes: None detected
- 📚 Documentation: None detected
- ✨ Features: Added PACS status check flow (including new UploadStep states and non-blocking availability check)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/345


## [0.0.5-alpha.202604131328.38a77534] - 2026-04-13

- ✨ Features: patient DICOM upload via Orthanc PACS (beta)
- 🔧 Chores & Improvements: update dev SMART compliance report
- 🔧 Chores & Improvements: preserve line endings in version.js to avoid dirty tree on Windows

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/344


## [0.0.5-alpha.202604131315.6d98337c] - 2026-04-13

- ⚠️ Breaking Changes: None
- ✨ Features: None
- 🐛 Bug Fixes: In pre-push hook, discard potential no-op file rewrites from line endings by running git checkout -- . before exiting to keep the tree clean
- 📚 Documentation: None
- 🔧 Chores & Improvements: None

Note: Only one meaningful change detected; grouped as a bug fix.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/343


## [0.0.5-alpha.202604131159.af43b3e2] - 2026-04-13

- ✨ Features: PDF document import pipeline (OCR → AI → FHIR validation + patient portal review UI)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/342


## [0.0.5-alpha.202604130310.7e87e126] - 2026-04-13

- ✨ Features: add FHIR sample data seeding on beta deploy
- 🐛 Bug Fixes: none
- 📚 Documentation: update CHANGELOG.md for PR #340
- 🔧 Chores & Improvements: update SMART compliance reports (beta/dev/test) [skip ci], update version to 0.0.5-alpha.202604130310.7e87e126 [skip ci]
- ⚠️ Breaking Changes: none

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/341


## [0.0.5-alpha.202604130118.674918ed] - 2026-04-13

- 🔧 Chores & Improvements: Update beta/alpha SMART compliance reports and testing tooling
- 🐛 Bug Fixes: Deploy health check uses correct Keycloak management port (9000)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/340


## [0.0.5-alpha.202604130043.6db4bfd4] - 2026-04-13

- 🔧 Chores & Improvements: Dynamic Keycloak IP resolution for beta deploy workflow; replaces hard-coded localhost with KC_BASE, adds guard for unresolved IP, and updates health check/token endpoints accordingly

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/339


## [0.0.5-beta.202604122030.b73417f0] - 2026-04-13

- ✨ Features: expose GET routes as tools with readOnlyHint; add admin toggle (quotentiroler)
- 🐛 Bug Fixes: none
- 📚 Documentation: none
- 🔧 Chores & Improvements: update beta SMART compliance reports (CI skip) across testing/dev; update version to 0.0.5-beta.202604122030.b73417f0
- ⚠️ Breaking Changes: none

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/337



- ✨ Features: Expose GET routes as tools with readOnlyHint; add admin toggle
- 🐛 Bug Fixes: ExposeResourcesAsTools to test configs and readOnly to RAG tool
- 🔧 Chores & Improvements: Sync package versions after rebase; update beta SMART compliance reports; update dev/beta SMART reports
- 📚 Documentation: Update CHANGELOG.md for PR #337

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/338


## [0.0.5-beta.202604122004.5a4c4b6d] - 2026-04-12

- ✨ Features: Auto-configure Keycloak SMTP on startup if RESEND_API_KEY is set (backend)
- 🔧 Chores & Improvements: CI/CD and testing housekeeping (beta SMART compliance reports)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/335


## [0.0.5-alpha.202604122004.5a4c4b6d] - 2026-04-12

- 🔧 Chores & Improvements: Use first supported server for endpoints; SMART_CONFIG_URL and BASE_FHIR_URL now derive from the first supported server (fallback remains if none exist)

- 🔧 Chores & Improvements: Bump pre-release version to 0.0.5-beta.202604121818.799a8983 across apps and e2e package

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/334


## [0.0.5-alpha.202604121912.0eb1a789] - 2026-04-12

- 🔧 Chores & Improvements: Select first supported server for endpoints; derive SMART_CONFIG_URL and BASE_FHIR_URL from that server (fallback to empty/null if none). This refines endpoint configuration behavior.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/333


## [0.0.5-beta.202604121818.799a8983] - 2026-04-12

- ✨ Features: enable forgot-password with Resend SMTP (quotentiroler)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/331



- 🔧 Chores & Improvements: Bump pre-release version to 0.0.5-beta.202604121818.799a8983 across all apps and e2e package (no code changes)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/332


## [0.0.5-alpha.202604121808.dc78aff2] - 2026-04-12

- 🔧 Chores & Improvements: Refactor UI into focused modules (SmartAppAddForm, SmartProxyOverview)
- 🔧 Chores & Improvements: Sync package versions after rebase
- 📚 Documentation: Update CHANGELOG.md for PR #328

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/329


## [0.0.5-alpha.202604121755.3e5e8666] - 2026-04-12

- 🔧 Chores & Improvements: Major refactor of AdminAuditDashboard into modular structure
  - Replaced monolithic AdminAuditDashboard.tsx with modular component set under AdminAuditDashboard/
  - Added core component and tab subcomponents: OverviewTab, EventLogTab, AnalyticsTab, FailuresTab
  - Introduced helpers.ts (ACTION_ICONS, actionColor, statusColor) and index export
  - Updated imports to use new subcomponents and services

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/328


## [0.0.5-alpha.202604121738.ec363779] - 2026-04-12

- ✨ Features: Introduced a new MCP Servers management UI with dialog-driven workflows
  - Added McpDialogs.tsx (AddServerDialog) and related dialogs module
  - Created McpServersManager with subcomponents: McpServersManager.tsx, McpServersTab.tsx, SkillsTab.tsx, and index.ts
  - Added shared types (McpServer, McpServerHealth, McpServerTool, RegistryServer, Skill, McpTemplate, McpTemplatesData) and re-export of SmartApp
  - Wire-up exports for new McpServersManager
- 🔧 Chores & Improvements: Major code refactor and UI expansion to support templates, skills, and tabbed interface

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/326


## [0.0.4-alpha.202604121402.09b13ece] - 2026-04-12

- 🔧 Chores & Improvements: Update MCP endpoint enabling logic to OR between file config and env config; endpoint 404 only when both sources disable. Tests updated accordingly.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/325


## [0.0.4-beta.202604120932.31b6b439] - 2026-04-12

- 🔧 Chores & Improvements: Update MCP endpoint enabling logic to use OR between file config and env config; endpoint now 404 only if both sources are disabled. Tests updated to reflect OR behavior and environment-variable handling.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/323



- 🔧 Chores & Improvements: Change MCP endpoint enabling logic to use OR between file config and env config; endpoint now 404 only when both sources are disabled
- 🐛 Bug Fixes: Update tests to reflect OR logic for MCP enabling; tests now expect 404 when both file-config and env-config are disabled
- 🔧 Chores & Improvements: Add environment-variable handling and test cleanup for MCP config logic

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/324


## [0.0.4-alpha.202604120909.30466170] - 2026-04-12

- ✨ Features: 
  - Backend MCP endpoint: switch to route-based tool registration (explicit MCP tool exposure)
  - Added backend test: backend/test/tool-registry-merge.test.ts for getMergedInputSchema regression (TypeBox)

- 🧪 Chores & Improvements:
  - Tests: switch config mocks to env-var-based config with explicit env setup; preserve singleton behavior
  - E2E: update package versions across apps and tests
  - Removed/cleaned Python MCP server test scaffolding and deprecated test structures

Note: No breaking changes detected.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/321


## [0.0.4-alpha.202604120851.2512256f] - 2026-04-12

- 🔧 Chores & Improvements: Version bumps across apps/tests to 0.0.4-alpha.202604120842.314f2bb8 and 0.0.4-alpha.202604112116.0c08004f
- 🔧 Chores & Improvements: Replace config mocks with env-vars-based config in tests to preserve singleton behavior
- 📚 Documentation: (No explicit docs changes)
- ⚠️ Breaking Changes: Backend MCP: refactor from registry-driven to route-based tool registration; more explicit MCP endpoint tests and removal of legacy Python MCP server test scaffolding

Note: Merge/update commits skipped; only meaningful changes included.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/320


## [0.0.4-alpha.202604112116.0c08004f] - 2026-04-12

- 🔧 Chores & Improvements: Refactor MCP backend to route-based tool registration (removing reliance on whole tool registry)
- 🔧 Chores & Improvements: Add extensive MCP endpoint integration tests (authentication, sessions, tools, protocol) via new backend/test/mcp-endpoint.test.ts
- 🗑️ Documentation / Maintenance: Remove legacy Python MCP server test scaffolding and deprecated test structure (pytest config, test utils, old test modules, and related files)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/319


## [0.0.4-alpha.202604112026.a30739f5] - 2026-04-11

- 🔧 Chores & Improvements: Refactor MCP endpoint to route-based tool registration (removes registry-driven exposure)  
- 🧪 🔧 Chores & Improvements: Large backend test suite added for MCP endpoint authentication, sessions, tools, and protocol compliance (with mocks)  
- 📚 Documentation: Removed unused Python MCP server test scaffolding and deprecated test structure (cleanup of old test config and files)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/318


## [0.0.4-alpha.202604111924.6ff9c348] - 2026-04-11

- 🔧 Chores & Improvements: Refactor MCP backend registration to route-based tool exposure (removes registry-driven dependency)
- 🔧 Chores & Improvements: Introduce extensive MCP endpoint test suite (integration tests for authentication, sessions, tools, protocol compliance)
- 🧪 🐛 Bug Fixes: Cleanup of legacy MCP server test scaffolding and deprecated test structure (removal of old Python test config and files)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/317


## [0.0.3-alpha.202604101244.fdcfb135] - 2026-04-10

- 🔧 Chores & Improvements: Update versioning to 0.0.3-alpha.202604101244.fdcfb135
- 📚 Documentation: Update CHANGELOG.md (PR #313)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/315


## [0.0.3-alpha.202604101219.41a64d4f] - 2026-04-10

- ✨ Features
  - SMART Apps: reorganized app structure and added new SMART App docs (consent-app, dtr-app, patient-portal, smart-dicom-template) with updated navigation.

- 🔧 Chores & Improvements
  - CI/CD: add permissions write for release-production workflow.
  - Monorepo path normalization: migrate UI app references from ui/ to apps/ui/ across codebase, docs, and configs.
  - Documentation: update docs sidebar and add SMART Apps docs.

- 🐛 Bug Fixes
  - Backend: expose ensurePostLogoutRedirectUris and add comprehensive tests for post-logout redirect URI behavior.

- 📚 Documentation
  - Documentation: add SMART App docs and update navigation.

- ⚠️ Breaking Changes
  - None identified.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/313


## [0.0.3-alpha.202604101213.09484d6c] - 2026-04-10

- ✨ Features
  - SMART Apps: new app sections and docs added (consent-app, dtr-app, patient-portal, smart-dicom-template) with updated navigation and docs sidebar
- 🔧 Chores & Improvements
  - Monorepo path normalization: migrate UI app references from ui/ to apps/ui/ across code, CI/CD, Dockerfiles, and configs
  - Align package versions across apps to 0.0.3-alpha.202604101133.7e6bdcf3
  - GitHub Actions: grant write permission for packages in release workflow
  - Documentation: added SMART App docs and updated docs sidebar
- 🐛 Bug Fixes
  - Backend: expose ensurePostLogoutRedirectUris and add comprehensive tests for post-logout redirect URI behavior
- 📚 Documentation
  - README: remove deprecated AI assistant table; update references to new app structure
- ⚠️ Breaking Changes
  - None identified

If you want more granular grouping or emphasis, I can adjust.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/311


## [0.0.3-alpha.202604101128.7fdbfc46] - 2026-04-10

- ✨ Features
  - None

- 🐛 Bug Fixes
  - Expose ensurePostLogoutRedirectUris helper and add tests for post-logout redirect URI behavior (creation, update, startup repair) with mocks for token validation and admin calls.

- 📚 Documentation
  - None

- 🔧 Chores & Improvements
  - CI/CD: Add GitHub Actions permissions level for packages in release-production workflow.
  - Repo/Codebase hygiene: Major workspace path refactor—rename ui/ to apps/ui/ across configs, Dockerfiles, and type/script references; update API client models to align with new app paths; adjust build and lint configurations accordingly.

- ⚠️ Breaking Changes
  - None

Note: Filtered out update/merge/metadata commits per guidelines.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/309


## [0.0.3-alpha.202604101119.fb892148] - 2026-04-10

- 🔧 Chores & Improvements: Major refactor of workspace paths and UI app references (ui/ → apps/ui/), updated CI/CD/build configs, Dockerfiles, and TypeScript configs to reflect new monorepo structure
- 🔧 Chores & Improvements: API client scaffolding moved/generated under apps/ui/lib/api-client (from ui/), enabling UI API interactions
- 🧪 Features: Expose ensurePostLogoutRedirectUris from backend init for external usage
- 🧪 Features: New tests for post-logout redirect URI behavior (creation, update, startup repair) with mocks and state tracking

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/308


## [0.0.3-alpha.202604092223.826788c7] - 2026-04-10

- 🔧 Chores & Improvements: Expose ensurePostLogoutRedirectUris in backend/init.ts and add comprehensive tests for post-logout redirect URI behavior (creation, update, startup repair) with mocks for token validation and Keycloak admin interactions

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/306



- ✨ Features: Expose ensurePostLogoutRedirectUris and add comprehensive tests for post-logout redirect URI behavior (creation, update, startup repair) with mocks.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/307


## [0.0.3-beta.202604091636.12e24ecc] - 2026-04-09

- ✨ Features: Expose ensurePostLogoutRedirectUris in backend/src/init.ts; add comprehensive tests for post-logout redirect URI behavior (creation, update, startup repair) with token validation and Keycloak mocks.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/304



- 🔧 Chores & Improvements: Expose ensurePostLogoutRedirectUris from backend/init.ts and add comprehensive tests for post-logout redirect URI behavior (creation, update, startup repair) with mocks for token validation and Keycloak interactions

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/305


## [0.0.3-alpha.202604090837.7f0be1bf] - 2026-04-09

- 🔧 Chores & Improvements: CI/CD tweaks and testing updates
  - ci: add [skip ci] to version-bump commits to prevent duplicate workflow runs
  - chore(testing): update beta SMART compliance report
  - chore(testing): update dev SMART compliance report
- 📚 Documentation: docs for DICOMweb proxy & Patient Portal Imaging
- ⚠️ Breaking Changes: none
- ✨ Features: none
- 🐛 Bug Fixes: none

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/302


## [0.0.3-alpha.202604090747.47995eb3] - 2026-04-09

- ✨ Features: add post.logout.redirect.uris for Keycloak 25+ compatibility
- 🔧 Chores & Improvements: CI/testing updates and version bumps
- 📚 Documentation: changelog entry updated for PR #300

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/301


## [0.0.3-alpha.202604090735.37497a36] - 2026-04-09

- 🔧 Chores & Improvements: internal setup and maintenance
  - fix: use internal.setOptions for dicom-image-loader auth config (quotentiroler)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/300


## [0.0.3-alpha.202604090720.61696ba9] - 2026-04-09

- ✨ Features: Add DicomViewer component with Cornerstone3D lazy init, WADO-RS auth integration, dynamic imports, and image loader token injection; extend ImagingStudyCard to support quick-view via DicomViewer
- 🔧 Chores & Improvements: Expand dicomweb.ts with helpers (getAccessToken, buildImageId, fetchSeriesImageIds) for building Cornerstone imageIds; update patient-portal package.json with new dependencies and devDependency; adjust vite.config.ts to include viteCommonjs plugin and optimizeDeps updates
- ⚠️ Breaking Changes: None detected
- 📚 Documentation: None detected
- 🐛 Bug Fixes: None detected

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/299


## [0.0.3-alpha.202604080110.a6a53b7c] - 2026-04-09

- 🔧 Chores & Improvements: Add key_ops: ["sign"] to RS384 private JWKS entries (dev and alpha)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/297


## [0.0.3-alpha.202604080058.cda7f4b7] - 2026-04-08

- ✨ Features
  - None

- 🐛 Bug Fixes
  - fix: convert Union([Literal(...)]) to UnionEnum for MCP compatibility

- 📚 Documentation
  - docs: update CHANGELOG.md for PR #295
  - docs: update CHANGELOG.md for PR #294
  - docs: update CHANGELOG.md for PR #293

- 🔧 Chores & Improvements
  - fix: introspection patient claim + backend services JWKS format
  - fix: fix dtr-app tgz (stale cache) and move PASClaimResponse to main import
  - Update version to 0.0.3-alpha.202604080058.cda7f4b7

- ⚠️ Breaking Changes
  - None

- Note: Skipped non-meaningful or duplicate commits (update, merge, metadata, CI-only).

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/296


## [0.0.3-beta.202604072243.17a845f3] - 2026-04-07

- 🔧 Chores & Improvements: CI/CD updates and maintenance (version bump in CI, testing report updates)
- 🐛 Bug Fixes: Fix dtr-app tarball cache and adjust PASClaimResponse import
- 📚 Documentation: Update CHANGELOG entry for PR #293

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/294



- ✨ Features
  - None

- 🐛 Bug Fixes
  - fix: introspection patient claim + backend services JWKS format (quotentiroler)
  - fix: fix dtr-app tgz (stale cache) and move PASClaimResponse to main import (quotentiroler)

- 📚 Documentation
  - docs: update CHANGELOG.md for PR #294
  - docs: update CHANGELOG.md for PR #293

- 🔧 Chores & Improvements
  - chore(testing): update beta/dev SMART compliance reports (proxy-smart-releaser[bot])
  - chore(testing): update version to 0.0.3-beta.202604072243.17a845f3 (beta) (github-actions[bot])

- ⚠️ Breaking Changes
  - None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/295


## [0.0.3-alpha.202604072243.17a845f3] - 2026-04-07

- ⚠️ Breaking Changes: none
- ✨ Features: none
- 🐛 Bug Fixes: none
- 📚 Documentation: none
- 🔧 Chores & Improvements: minor build/test tooling updates

Note: No user-facing changes detected beyond version bumps and internal maintenance.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/293


## [0.0.3-alpha.202604072226.d14c7f94] - 2026-04-07

- 🔧 Chores & Improvements: Regenerate FHIR tgz packages with babelfhir-ts 1.2.5; update testing reports
- 📚 Documentation: Update CHANGELOG.md for PR #291

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/292


## [0.0.3-alpha.202604072220.eb426fd8] - 2026-04-07

- 🔧 Chores & Improvements: Update dependencies and bump version strings across bun.lock and multiple packages to 202604072212.97a1f997
  - Added dependency "@vue/server-renderer" ^3.5.30
  - Updated package.json and bun.lock version tags for backend, infra, patient-portal, and ui components

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/291


## [0.0.3-alpha.202604072212.97a1f997] - 2026-04-07

- 🔧 Chores & Improvements: Drop .js from valueset imports to align with exports wildcard (quotentiroler)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/290


## [0.0.3-beta.202604072115.7fa57ae1] - 2026-04-07

- 🔧 Chores & Improvements: Internal maintenance (version metadata updates skipped; exclude noisy update commits)
- ✨ Features: None
- 🐛 Bug Fixes: fix(patient-portal): regenerate ips-generated with babelfhir-ts 1.2.5 (valuesets exports)
- 📚 Documentation: docs: update CHANGELOG.md for PR #288
- ⚠️ Breaking Changes: None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/289


## [0.0.3-alpha.202604071925.75928c50] - 2026-04-07

- 🔧 Chores & Improvements: Internal updates and maintenance
  - Minor: Update CHANGELOG for PR #287
  - Chore: Update version metadata and related release steps to alpha 0.0.3-alpha.202604071925.75928c50
  - Chore: Update dev beta/alpha SMART compliance reports (cleanup/internal)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/288


## [0.0.3-alpha.202604071628.96af1239] - 2026-04-07

- 🔧 Chores & Improvements: Remove explicit GHCR build/push workflow step for alpha; retain automatic Northflank deployment on develop pushes; reduce top-level permissions by removing write access from certain packages.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/287


## [0.0.3-alpha.202604071618.6e486c97] - 2026-04-07

- 🔧 Chores & Improvements: Copy root lib/ tarballs into Docker build context

- 📚 Documentation: Update CHANGELOG.md for PR #284

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/285


## [0.0.3-alpha.202604071545.70936f2d] - 2026-04-07

- 🔧 Chores & Improvements: CI/CD workflow enhancements
  - Add GitHub Actions steps to build and push the alpha Docker image to GHCR, extend workflow permissions (packages: write)
  - Introduce build-alpha-image job: checkout develop, login to GHCR, setup Buildx, compute image prefix, build/push mono:alpha-<version> and mono:alpha-latest, enable caching for alpha-mono

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/284


## [0.0.3-alpha.202604071536.80de429f] - 2026-04-07

- ✨ Features:  
  - Add CI/CD workflow to build and push beta Docker images to GHCR (backend and frontend) with versioned and latest tags, plus Buildx caching.  
  - Introduce GHCR-based image usage in docker-compose.beta.yml for backend, frontend, and Keycloak (default to beta-latest tags).

- 🔧 Chores & Improvements:  
  - Implement isolated dependency install layer for mono build with per-package workspace installation and cached bun install.  
  - Compute and export lowercase GHCR path (IMAGE_PREFIX) at two workflow points to ensure consistent image references.  
  - Update GitHub Actions workflow permissions to grant write access to release packaging.

- ⚠️ Breaking Changes:  
  - Switched docker-compose.beta.yml to use prebuilt GHCR images instead of local Docker builds.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/283


## [0.0.3-beta.202604070736.41e900cf] - 2026-04-07

- 🔧 Chores & Improvements: CI/CD updates
  - Add GitHub Actions workflow to build and push beta Docker images to GHCR (backend and frontend) with versioned and latest tags, plus Buildx caching
  - Update docker-compose.beta.yml to use GHCR prebuilt images via env vars (BACKEND_IMAGE, FRONTEND_IMAGE, KEYCLOAK_IMAGE) with defaults to beta-latest; remove local Docker builds for Keycloak, Backend, and Frontend

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/280



- 🔧 Chores & Improvements: Ensure IMAGE_PREFIX is always lowercase GHCR path at runtime (two build/deploy steps) and remove the old definition
- 🔧 Chores & Improvements: Update GitHub Actions to grant package write access in release-beta workflow
- ✨ Features: Add beta GitHub Actions workflow to build and push beta Docker images to GHCR (backend and frontend) with versioned and latest tags, plus Buildx caching
- 🔧 Chores & Improvements: Switch docker-compose.beta.yml to use prebuilt GHCR images (BACKEND_IMAGE, FRONTEND_IMAGE, KEYCLOAK_IMAGE) with default beta-latest tags; remove local builds for Keycloak, Backend, and Frontend

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/282


## [0.0.3-alpha.202604070736.41e900cf] - 2026-04-07

- 🐛 Bug Fixes: Health checks treat unconfigured subsystems as neutral
  - Not_configured state added for FHIR when no servers configured
  - Keycloak health: if KEYCLOAK_BASE_URL missing, report not_configured (not unhealthy)
  - Overall system health now filters out not_configured subsystems and reports healthy/degraded/unhealthy accurately
- 🔧 Chores & Improvements: Use JAVA_TOOL_OPTIONS for Keycloak build heap limit (JVM-level) instead of JAVA_OPTS_KC_BUILD

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/279


## [0.0.3-beta.202604070709.d55c0d66] - 2026-04-07

- 🔧 Chores & Improvements: Internal updates and maintenance
- ⚠️ Breaking Changes: None
- ✨ Features: None
- 🐛 Bug Fixes: None
- 📚 Documentation: None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/278


## [0.0.3-alpha.202604070601.47816146] - 2026-04-07

- ✨ Features: integrate remaining babelfhir-ts IPS/PAS types across both apps (quotentiroler)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/276


## [0.0.3-alpha.202604070519.fa24d1e7] - 2026-04-07

- ✨ Features: integrate babelfhir-ts 1.2.2 PAS/IPS types into dtr-app and patient-portal
- 🔧 Chores & Improvements: update dev SMART compliance report
- 🔧 Chores & Improvements: internal version metadata updates (CI/CD)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/275


## [0.0.3-alpha.202604070510.aa1fb797] - 2026-04-07

- ✨ Features: None
- 🐛 Bug Fixes:
  - fix: add date-fns@1.30.1 as direct backend dependency to fix Bun linker bug
- 📚 Documentation:
  - docs: update CHANGELOG.md for PR #273
- 🔧 Chores & Improvements:
  - chore(testing): update dev SMART compliance report
  - Update version to 0.0.3-alpha.202604070510.aa1fb797 (alpha)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/274


## [0.0.3-alpha.202604070454.f050a94b] - 2026-04-07

- ✨ Features: Integrate TaskStatusCode, TaskIntentCode, and BundleTypeCode across consent-app and backend (quotentiroler)
- 🔧 Chores & Improvements: Update changelog reference and version metadata
- ⚠️ Breaking Changes: None
- 📚 Documentation: None
- 🐛 Bug Fixes: None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/273


## [0.0.3-alpha.202604070450.422fa383] - 2026-04-07

- ✨ Features: use extension validators and ValueSet codes in brand-bundle (quotentiroler)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/272


## [0.0.3-alpha.202604070423.c1b1db1c] - 2026-04-07

- 🔧 Chores & Improvements: Significant dependency lockfile updates and prebuilt binary refresh
  - Substantial Bun.lock churn with widespread dependency/version updates
  - Updated prebuilt artifact: hl7.fhir.uv.smart-app-launch-generated.tgz

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/271


## [0.0.3-alpha.202603270523.8a72cdae] - 2026-03-27

- ✨ Features: add Proxy Smart logo icon to /apps page nav
- 🔧 Chores & Improvements: update beta/alpha version references for pre-release 0.0.3-alpha.202603270523.8a72cdae
- 📚 Documentation: update CHANGELOG.md for PR #269

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/270


## [0.0.3-alpha.202603270508.c9253829] - 2026-03-27

- 🐛 Bug Fixes: Show App Store only when user is signed out
- 🔧 Chores & Improvements: CI/CD and testing updates (dev SMART compliance report)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/269


## [0.0.3-alpha.202603270447.2f9c80a0] - 2026-03-27

- 🔧 Chores & Improvements: Internal maintenance and refactoring
  - Refactor(shared-ui): extract AppHeader component from app headers
  - CI/CD: Update version to 0.0.3-alpha.202603270447.2f9c80a0 (alpha)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/268


## [0.0.3-alpha.202603270441.5b5ab954] - 2026-03-27

- 🔧 Chores & Improvements: Internal maintenance updates and CI/CD housekeeping
- ✨ Features: None
- 🐛 Bug Fixes: Restore useMemo import in consent-app
- 📚 Documentation: Update CHANGELOG.md for PR #266
- ⚠️ Breaking Changes: None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/267


## [0.0.3-alpha.202603270436.f1547658] - 2026-03-27

- 🔧 Chores & Improvements: Refactor access request logic to use primitive mode helpers (modeBy, modeKey) for stable dependencies
  - Remove react useMemo import from useAccessRequests.ts
  - Guard fetchRequests with modeBy/modeKey instead of mode
  - Switch searchTasksByPatient/searchTasksByRequester to modeBy/modeKey
  - Update effect dependencies to [modeBy, modeKey] and remove direct [mode]

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/266


## [0.0.3-alpha.202603270407.6aa704dc] - 2026-03-27

- ✨ Features: expose MCP resources (GET routes) in admin endpoint config UI (quotentiroler)
- 🔧 Chores & Improvements: update beta/alpha version metadata and SMART compliance reports (ci-related)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/265


## [0.0.3-alpha.202603270356.21873b4b] - 2026-03-27

- ✨ Features: add agent scope context and Device fhirUser support (quotentiroler)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/264


## [0.0.3-alpha.202603270335.6642cc28] - 2026-03-27

- 🔧 Chores & Improvements: Consolidate OAuth & Events into a single OAuth tab; fix memory stats
- 🔧 Chores & Improvements: Update beta/dev SMART compliance reports (internal testing automation)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/263


## [0.0.3-alpha.202603270323.2babb9a9] - 2026-03-27

- ✨ Features: replace static 429 stat card with dynamic Top Error card (quotentiroler)
- 🔧 Chores & Improvements: update dev SMART compliance report (proxy-smart-releaser[bot])

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/262


## [0.0.3-alpha.202603270307.b7318334] - 2026-03-27

- 🔧 Chores & Improvements: use generated API client types instead of manual duplicates (quotentiroler)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/261


## [0.0.3-alpha.202603270233.e884c722] - 2026-03-27

- 🐛 Bug Fixes: auto-logout on monitoring 401 and improvements to E2E test stability
- 🔧 Chores & Improvements: CI/CD and versioning updates for alpha pre-release 0.0.3-alpha.202603270233.e884c722

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/260


## [0.0.3-alpha.202603270112.2b029cbe] - 2026-03-27

- ✨ Features: FHIR proxy request monitoring with 429/error tracking (quotentiroler)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/259


## [0.0.3-alpha.202603270100.b4b79f74] - 2026-03-27

- 🐛 Bug Fixes: Rate-limit avoidance for patient-portal via batch FHIR requests to reduce 429s
- 🔧 Chores & Improvements: Update version to 0.0.3-alpha.202603270100.b4b79f74 (alpha)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/258


## [0.0.3-alpha.202603270005.c4f44147] - 2026-03-27

- ✨ Features: Add E2E Playwright tests for patient-portal (70 test specs)
- 🔧 Chores & Improvements: Testing updates and internal maintenance (dev SMART compliance reports)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/257


## [0.0.3-alpha.202603262231.bcef1334] - 2026-03-27

- 🔧 Chores & Improvements: Update version to 0.0.3-alpha.202603262231.bcef1334
- ✨ Features: SMART scope protocol mapper auto-provisioning, management UI, and logout fixes (quotentiroler)
- 📚 Documentation: CHANGELOG update note (from PR #255)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/256


## [0.0.3-alpha.202603262210.ca39219f] - 2026-03-26

- 🐛 Bug Fixes: set postLogoutRedirectUri in all SMART apps (quotentiroler)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/255


## [0.0.3-alpha.202603262146.90e44e07] - 2026-03-26

- 🔧 Chores & Improvements: Internal updates and maintenance
  - Fix: use mutable token ref in MCP sessions to prevent stale auth

Note: No user-facing features, bug fixes beyond internal auth fix, or documentation changes detected.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/254


## [0.0.3-alpha.202603262109.1f1eb8d7] - 2026-03-26

- ✨ Features:
  - Add missing params schemas to admin routes for MCP tool exposure (quotentiroler)

- 🔧 Chores & Improvements:
  - CI/CI: Update version references to 0.0.3-alpha.202603262109.1f1eb8d7
  - Documentation: Update CHANGELOG with PR metadata

Note: No breaking changes, bug fixes, or documentation/content changes beyond housekeeping detected.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/253


## [0.0.3-alpha.202603262009.6c2d2717] - 2026-03-26

- ✨ Features: Add comprehensive SMART Access Control tests (scope, write blocking, role-based filtering) plus test utilities.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/252


## [0.0.3-alpha.202603261959.0eedf22a] - 2026-03-26

- ✨ Features: SMART on FHIR access control feature set
  - Adds configurable access control with scope enforcement, role-based filtering, and optional write blocking
  - Introduces SMART access control module and core types, wired into backend config
  - Adds new backend route integration for FHIR access control

- 🔧 Chores & Improvements: CI/config updates for new feature
  - Extends backend/config.ts with accessControl options (scopeEnforcement, roleBasedFiltering, readOnlyForUsers, patientScopedResources)

- 📚 Documentation: (none)

- ⚠️ Breaking Changes: (none)

- 🐛 Bug Fixes: (none)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/251


## [0.0.3-alpha.202603261915.b85b32ac] - 2026-03-26

- ✨ Features: Introduce SMART on FHIR access control
  - Add configurable accessControl settings (scopeEnforcement, roleBasedFiltering, readOnlyForUsers, patientScopedResources)
  - Implement SMART access control module with scope enforcement, role-based filtering, and optional write blocking
  - Wire config usage and logging into backend routes (FHIR)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/250


## [0.0.3-alpha.202603261227.e58ce3fa] - 2026-03-26

- 🐛 Bug Fixes: ESLint config fixes, lint error resolutions, CSS build fixes, and App Store button issue (quotentiroler)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/249


## [0.0.3-alpha.202603261153.437fd3f4] - 2026-03-26

- ✨ Features: None
- 🐛 Bug Fixes: None
- 📚 Documentation: None
- 🔧 Chores & Improvements: 
  - Refactor: remove redundancies and consolidate shared code (quotentiroler)
- ⚠️ Breaking Changes: None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/248


## [0.0.3-alpha.202603261142.f2bbdb5a] - 2026-03-26

- ✨ Features: wire IAL enforcement in FHIR proxy and complete Person link management UI
- 🔧 Chores & Improvements: internal maintenance (CI/CD and testing updates)
- 📚 Documentation: update CHANGELOG.md with PR notes

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/247


## [0.0.3-alpha.202603260616.9f8b1020] - 2026-03-26

- 🔧 Chores & Improvements: Cleanup and maintenance of deploy-beta workflow
  - Performs remote Docker prune/cleanup (images, containers, volumes, builders with 2GB kept) via SSH and outputs disk usage after cleanup

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/246


## [0.0.3-alpha.202603260600.c6b0d8d9] - 2026-03-26

- 🐛 Bug Fixes: Remove hardcoded fake data from CertificatesDialog and LaunchContextManager (quotentiroler)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/244


## [0.0.3-alpha.202603260505.b938bcb4] - 2026-03-26

- ✨ Features: Wire up real SMART capabilities in FHIR server management UI (quotentiroler)
- 🔧 Chores & Improvements: Update dev SMART compliance report
- 🔧 Chores & Improvements: Update version to 0.0.3-alpha.202603260505.b938bcb4
- 📚 Documentation: Update CHANGELOG.md for PR #242

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/243


## [0.0.3-alpha.202603260458.782b5ec9] - 2026-03-26

- 🔧 Chores & Improvements: Internal updates and maintenance
  - Refactor: replace client-side CQL engine with server-side (quotentiroler)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/242


## [0.0.3-alpha.202603260233.96d79d26] - 2026-03-26

- ✨ Features: wire up CQL engine and Smart Forms SDC renderer in DTR app (quotentiroler)

- 🔧 Chores & Improvements: update dev SMART compliance report

- 🔧 Chores & Improvements: update version to 0.0.3-beta.202603260210.50141671 (beta)
- 🔧 Chores & Improvements: update version to 0.0.3-alpha.202603260233.96d79d26 (alpha)

Note: No user-facing breaking changes, docs, or other fixes detected.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/241


## [0.0.3-alpha.202603260210.50141671] - 2026-03-26

- 🔧 Chores & Improvements: Deduplicated app configs, CSS theme, chart colors, and admin tabs into shared-ui
- 📚 Documentation: Updated CHANGELOG entry for PR #239

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/240


## [0.0.3-alpha.202603252257.1f554a11] - 2026-03-26

- ✨ Features: Register patient-portal in App Store and mono build pipeline (quotentiroler)

- 🔧 Chores & Improvements: Update dev SMART compliance report (proxy-smart-releaser[bot])
- 🔧 Chores & Improvements: Update version to 0.0.3-beta.202603252246.f07ac170 (beta) (github-actions[bot])
- 📚 Documentation: Update CHANGELOG.md for PR #238 [skip ci] (github-actions[bot])
- 🔧 Chores & Improvements: Update version to 0.0.3-alpha.202603252257.1f554a11 (alpha) (github-actions[bot])

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/239


## [0.0.3-alpha.202603252246.f07ac170] - 2026-03-25

- 🔧 Chores & Improvements: Introduced file-backed persistence for dynamically added FHIR servers
  - Add fs/path usage, PersistedServer interface, and SERVERS_JSON_PATH
  - Implement loadPersistedServers and savePersistedServers
  - Prepare groundwork for persisting servers to fhir-servers.json
- 🔧 Chores & Improvements: Standardize newline handling and update ignore rules for backend
  - Update backend/.gitignore with fhir-servers.json
  - Ensure mcp.json newline issue is fixed

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/238


## [0.0.3-alpha.202603252123.0938d55e] - 2026-03-25

- ✨ Features: Scaffold international patient portal with IPS/IPA (quotentiroler)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/237


## [0.0.3-alpha.202603252036.bae2a0a9] - 2026-03-25

- ✨ Features: surface brand logo in consent-app and dtr-app (quotentiroler)
- 🔧 Chores & Improvements: update beta and dev SMART compliance reports (proxy-smart-releaser[bot])
- 🔧 Chores & Improvements: update version to 0.0.3-alpha.202603252036.bae2a0a9 (github-actions[bot])

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/236


## [0.0.3-alpha.202603251947.f10c9f3b] - 2026-03-25

- ✨ Features: pass OPENAI_API_KEY through beta deployment pipeline (quotentiroler)
- 🔧 Chores & Improvements: update beta and dev SMART compliance reports (proxy-smart-releaser[bot])
- 🔧 Chores & Improvements: update changelog reference and version metadata (CI)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/235


## [0.0.3-alpha.202603251933.c56cbe7f] - 2026-03-25

- 🐛 Bug Fixes: Preserve bundle type on 304 response — return empty string cast to bundle type when If-None-Match matches ETag (ETag and Cache-Control behavior unchanged)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/234


## [0.0.3-alpha.202603251928.7a647e6d] - 2026-03-25

- ✨ Features: MCP resources, FHIR server delete, AI assistant fixes, IAL encoding fix; user-access branding, dynamic roles, code cleanup
- 🧪 ⚠️ Breaking Changes: (none)
- 🐛 Bug Fixes: wrap IALSettings hardcoded strings with t() for i18n
- 📚 Documentation: update CHANGELOG.md for PR #231, PR #232
- 🔧 Chores & Improvements: version bumps, CI/CD housekeeping, SMART compliance report updates, code cleanup

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/233


## [0.0.3-alpha.202603251726.4eb5bd90] - 2026-03-25

- ✨ Features: MCP resources, FHIR server delete, AI assistant fixes, IAL encoding fix
- 🔧 Chores & Improvements: user-access branding, dynamic roles, code cleanup
- 📚 Documentation: update CHANGELOG.md for PR #231
- ⚠️ Breaking Changes: none
- 🐛 Bug Fixes: (none explicit beyond features)
Note: Only changes since last release included.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/232


## [0.0.3-alpha.202603241627.cdee7ff7] - 2026-03-25

- ✨ Features: user-access branding, dynamic roles, code cleanup (quotentiroler)
- 🔧 Chores & Improvements: internal maintenance and CI/CD updates
- 📚 Documentation: changelog update for PR #230

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/231


## [0.0.3-alpha.202603240754.fe065af2] - 2026-03-24

- 🔧 Chores & Improvements: UI spacing adjustments for hero container across breakpoints; header bottom padding tweaks
- 🔧 Chores & Improvements: Added enum-like validation sets and runtime sanitization for appType (fallback to backend-service or standalone-app) in admin routes

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/230


## [0.0.2-beta.202603240700.0cadb793] - 2026-03-24

- 🔧 Chores & Improvements: Update version to 0.0.2-beta.202603240700.0cadb793 (beta)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/199



- 🔧 Chores & Improvements: CI workflow updates and versioning
  - Enable production release workflow and fix workflow_dispatch
  - Update version to 0.0.2-beta.202603240700.0cadb793 (beta)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/228


## [0.0.2-alpha.202603240346.274d844f] - 2026-03-24

- ✨ Features: Add KC_HOSTNAME_STRICT=true for beta with redirect URIs for consent/dtr apps
- 🔧 Chores & Improvements: Testing updates for beta and dev SMART compliance reports
- 🔧 Chores & Improvements: Version bumps for beta and alpha releases

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/226


## [0.0.2-alpha.202603240241.095e5351] - 2026-03-24

- ✨ Features: AI discoverability, SEO metadata, and docs navigation (quotentiroler)
- 🔧 Chores & Improvements: CI/CD and internal testing updates (beta/alpha SMART reports)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/225


## [0.0.2-alpha.202603240158.5d8c65e8] - 2026-03-24

- 🔧 Chores & Improvements: Set Vite base paths for consent-app and dtr-app to /apps/consent/ and /apps/dtr/, fixing asset 404s under beta subpaths

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/224


## [0.0.2-alpha.202603240142.79e45c32] - 2026-03-24

- ⚠️ Breaking Changes: None
- ✨ Features: None
- 🐛 Bug Fixes: None
- 📚 Documentation: None
- 🔧 Chores & Improvements: None

Note: No meaningful changes beyond maintenance/version updates.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/223


## [0.0.2-alpha.202603232114.52d8e7a0] - 2026-03-24

- ✨ Features: None
- 🐛 Bug Fixes:
  - fix: replace typeof fetch with explicit signature for Bun compatibility
- 🔧 Chores & Improvements:
  - chore: update version to 0.0.2-alpha.202603232114.52d8e7a0
- 📚 Documentation:
  - docs: update CHANGELOG.md for PR #221
- ⚠️ Breaking Changes: None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/222


## [0.0.2-alpha.202603232047.4de7c7aa] - 2026-03-23

- 🔧 Chores & Improvements: Documentation routing and assets handling updates
  - Add VitePress docs SPA fallback routes and per-file asset fallback logic
  - Rename and adjust docs API paths and route handling for /docs-api vs /docs
  - Update docs-related URL generation and static serving behavior
  - Update docker-compose beta config to allow /docs and /docs-api paths
- 🔧 Chores & Improvements: Workspace and build optimizations
  - Copy additional lib folders for consent-app and dtr-app in Dockerfile
  - Narrow workspace scope to avoid install failures (backend, ui, shared-ui, consent-app, dtr-app)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/221


## [0.0.2-beta.202603231957.d98e9bfd] - 2026-03-23

- 🔧 Chores & Improvements: Remove committed app bundles with baked localhost URLs (quotentiroler)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/219



- 🔧 Chores & Improvements: Dockerfile: copy additional lib folders for consent-app and dtr-app; adjust package.json workspaces to include only backend, ui, shared-ui, consent-app, dtr-app to avoid workspace install failures

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/220


## [0.0.2-alpha.202603231957.d98e9bfd] - 2026-03-23

- 🔧 Chores & Improvements: Expand Caddy reverse proxy support (add 3_reverse_proxy for port 8445 in docker-compose.beta.yml; extend matching to additional upstreams with the same port)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/218


## [0.0.2-alpha.202603231949.c8b88e61] - 2026-03-23

- 🔧 Chores & Improvements: Expand reverse proxy setup to include a second Caddy proxy (3_reverse_proxy) on port 8445 in docker-compose.beta.yml and extend upstream matching to cover additional upstreams with the same port

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/217


## [0.0.2-alpha.202603231939.8fee9586] - 2026-03-23

- 🔧 Chores & Improvements: Clean up Caddy path handling by removing trailing slash in backend path for fhir-servers, enabling "fhir-servers" and "fhir-servers/*" paths.

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/216


## [0.0.2-beta.202603231842.93e412a1] - 2026-03-23

- 🔧 Chores & Improvements: Fix Caddy backend path split by removing trailing slash for fhir-servers, adding explicit "fhir-servers" and "fhir-servers/*" paths

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/214



- 🔧 Chores & Improvements: Fixed Caddy path split by removing trailing slash in backend path, ensuring proper fhir-servers routing (now "fhir-servers" and "fhir-servers/*" instead of "fhir-servers/*" only).

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/215


## [0.0.2-beta.202603231648.0e8f43e2] - 2026-03-23

- 🔧 Chores & Improvements: Update beta/dev SMART compliance reports (CI skips)  
- 🔧 Chores & Improvements: Center scroll indicator correctly (quotentiroler)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/211



- ✨ Features: Add new SVG asset for backend proxy icon (proxy-smart.svg, 32x32, red)

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/212


## [0.0.2-alpha.202603231648.0e8f43e2] - 2026-03-23

- 🔧 Chores & Improvements: UI spacing tweak in backend/public/index.html (adjusted text-indent/margin-right for mono font label)
- 🔧 Chores & Improvements: Expand environment ignore patterns to cover recursive .env and local variants across all folders

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/210


## [0.0.2-alpha.202603231643.9fb5f430] - 2026-03-23

- 🔧 Chores & Improvements: Expand environment ignore patterns to recursively ignore env files (**/.env, **/.env.local, **/.env.*.local) alongside existing rules

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/209


## [0.0.2-alpha.202603231631.09cefee1] - 2026-03-23

- ✨ Features: None
- 🐛 Bug Fixes: None
- 📚 Documentation: 
  - docs: add access control and monitoring documentation
  - docs: update CHANGELOG.md for PR #207
- 🔧 Chores & Improvements: 
  - chore(testing): update dev SMART compliance report
- ⚠️ Breaking Changes: None

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/208


## [0.0.2-alpha.202603231607.00c7934f] - 2026-03-23

- 🔧 Chores & Improvements: Documentation overhaul for AI MCP integration and redesigned AI Assistant flow; UI routing and setupTools() adjustments
- 🔧 Chores & Improvements: CI/test enhancements and certification readiness for SMART 2.2.0; convert CI checks to automated adoption
- 🔧 Chores & Improvements: Version management and monorepo organization updates; root version as truth
- 🔧 Chores & Improvements: Release process update; shift from Alpha to Branch Flow with new three-stage promotion diagram and clarified automated beta/testing PR flow

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/207


## [0.0.2-alpha.202603231553.7ab93fa3] - 2026-03-23

- 🔧 Chores & Improvements: Refined tool-call handling to trigger only on exact type 'tool-call' with a present toolName; updated comment to reflect start-only behavior

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/206


## [0.0.2-alpha.202603231549.74ce61a0] - 2026-03-23

- ✨ Features
  - 🧪 Auto-PR: Merge develop → test workflows: add step to resolve version conflicts when develop is behind test, preferring develop in string merges and handling conflict resolution.

- 🔧 Chores & Improvements
  - 🧪 CI/CD: Pass generated token to checkout step and remove hard-coded git remote URL updates in workflow jobs.
  - 🔧 CI/CD: Refine bot user config and use GH token for remote in automation steps.
  - 📚 Documentation: Update deployment notification workflow to simplify Discord payload construction and centralize deployment-related fields. 
  - ⚠️  Breaking Changes: None detected

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/205


## [0.0.2-beta.202603231421.2de1435a] - 2026-03-23

- 🔧 Chores & Improvements: Clean startup by removing any existing docker container named caddy-proxy before starting the Caddy proxy

**Full Changelog**: https://github.com/Max-Health-Inc/proxy-smart/pull/204


## [0.0.2-alpha] - 2026-03-14

### ✨ Features

- AI assistant with RAG for documentation queries
- MCP server (Streamable HTTP) auto-generated from backend OpenAPI spec
- External MCP server connectivity with official SDK (JSON-RPC 2.0)
- SMART on FHIR proxy with Keycloak integration
- Admin UI for managing SMART apps, FHIR servers, users, and roles
- Access control integration (Kisi, UniFi Access)
- Quick Setup Templates for MCP server configuration
- Docker-ready deployment (mono-container and multi-container)

### 🔧 Chores & Improvements

- Refactored AI MCP client to use official `@modelcontextprotocol/sdk`
- Migrated from Node.js-based AI changelog to Python-based workflow scripts
- Updated dependencies: vite 8.0.0, vitest 4.1.0, @types/node 25.5.0
