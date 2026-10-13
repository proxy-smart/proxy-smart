# SMART Compliance Testing

`.github/workflows/smart-compliance-tests.yml` runs the Inferno SMART App Launch STU2.2 suite (`smart_app_launch_test_kit` v1.0.0) and drives its OAuth steps with Playwright (`.github/scripts/inferno-oauth-automation.js`). Each run uploads a `compliance-report-<stage>` artifact, which the docs site publishes under [Compliance Reports](../docs/compliance-reports.md).

## When it runs

| Trigger | Stage | What runs |
|---|---|---|
| `v*` tag push touching backend, Keycloak or testing paths | `dev` | Full suite against a local CI stack |
| Release to `test` (`release-beta.yml` → `testing-strategy.yml`) | `beta` | Full suite against the deployed VPS |
| Release to `main` (`release-production.yml` → `testing-strategy.yml`) | `production` | Consent-enforcement probe only |
| Monday 06:00 UTC schedule | `production` (default branch) | Consent-enforcement probe only |
| `workflow_dispatch` | any | Whatever the chosen stage's mode says |

Branch pushes do not trigger it: on `test` and `main` a push would race the deploy, and `dev/*` is covered by its auto-PR. Dispatch it by hand for a branch that touches the launch, token or scope paths.

## Stages and modes

Each folder holds the `inferno-config.json` for one stage. `mode` decides what a run may do to its target.

| Folder | Target | Mode |
|---|---|---|
| `dev/` | Local CI stack | `conformance` |
| `alpha/` | Local CI stack | `conformance` |
| `beta/` | `https://beta.proxy-smart.com` | `conformance` |
| `production/` | Production | `enforcement` |

`conformance` provisions the Inferno clients and FHIR fixtures, logs in as a test user and runs four groups: Standalone Launch, Token Introspection, Backend Services and EHR Launch. It is valid only where the realm is disposable and the data synthetic.

`enforcement` writes nothing. It asserts that a token without consent for a patient gets `403 consent_denied`, that the issuer is self-consistent, and that `/metadata` still answers.

## Credentials

A local stage may carry its fixture credentials in the config file, since the realm export they belong to is public anyway. A deployed stage never does; the workflow fails if one tries. Instead:

| Credential | Local | `beta` |
|---|---|---|
| Test user password | `test_user.password` | `BETA_TEST_USER_PASSWORD` |
| Introspection client secret | `introspection_client.client_secret` | `BETA_KEYCLOAK_ADMIN_CLIENT_SECRET` |
| Production probe key | | `PROD_PROBE_PRIVATE_KEY` (production) |

The introspection client is `admin-service`, the client the backend marks with `allow.token.introspection.without.audience.check`. Inferno plays a resource server in that group, and `/auth/introspect` refuses callers that do not authenticate.

## Login theme guard

The automation fails the run when the Keycloak login page is not served by the `proxy-smart` theme, or when its Geist fonts do not load. The CI Keycloak container therefore mounts `keycloak/themes/proxy-smart`, as both local compose files do. `bun run check:theme-env` verifies that every one of those targets sets the `${env.*}` values the theme reads.
