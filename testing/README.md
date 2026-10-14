# SMART Compliance Testing

`.github/workflows/smart-compliance-tests.yml` runs the Inferno SMART App Launch STU2.2 suite (`smart_app_launch_test_kit` v1.0.0) and drives its OAuth steps with Playwright (`.github/scripts/inferno-oauth-automation.js`). Each run uploads a `compliance-report-<stage>` artifact, which the docs site publishes under [Compliance Reports](../docs/compliance-reports.md).

## When it runs

| Trigger | Stage | What runs |
|---|---|---|
| `v*` tag push touching backend, Keycloak or testing paths | `dev` | Full suite against a local CI stack |
| Release to `test` (`release-beta.yml` → `testing-strategy.yml`) | `beta` | Enforcement probe, then the full suite against the deployed VPS |
| Release to `main` (`release-production.yml` → `testing-strategy.yml`) | `production` | Enforcement probe only |
| Monday 06:00 UTC schedule | `production` (default branch) | Enforcement probe only |
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

`conformance` provisions the Inferno clients, logs in as a test user and runs four groups: Standalone Launch, Token Introspection, Backend Services and EHR Launch. It is valid only where the realm is disposable and the data synthetic.

Every stage runs the access posture production runs: compartment filtering and consent enforced. The FHIR fixtures are `scripts/seed/fhir-seed-bundle.json`, which the beta deploy and the local CI stack both load. Its Consents let `Practitioner/example-practitioner`, the `doctor` test user, read `Patient/test-patient`, so the suite passes with consent enforced and no client exempted.

`enforcement` runs only the probe. A deployed stage with a `probe` block (`beta` and `production`) runs `.github/scripts/consent-enforcement-probe.mjs`, which writes nothing. Its client `ci-enforcement-probe` holds no FHIR scope. It asserts that a read without consent gets `403 consent_denied`, that the issuer is self-consistent and that `/metadata` answers. It asserts each stage at the mode `backend/src/lib/access-posture.json` declares: consent when `consent` is `enforce`, and, when `fhirAudience` is `enforce`, that a token issued for the MCP endpoint is refused at the FHIR endpoint.

## Credentials

A local stage may carry its fixture credentials in the config file, since the realm export they belong to is public anyway. A deployed stage never does: it takes them from CI secrets, and the run fails when one is missing.

| Credential | Local | `beta` | `production` |
|---|---|---|---|
| Test user password | `test_user.password` | `BETA_TEST_USER_PASSWORD` | |
| Introspection client secret | `introspection_client.client_secret` | `BETA_KEYCLOAK_ADMIN_CLIENT_SECRET` | |
| Probe private key and key id | | `BETA_PROBE_PRIVATE_KEY`, `BETA_PROBE_KID` | `PROD_PROBE_PRIVATE_KEY`, `PROD_PROBE_KID` |

The probe client is registered through the admin API as a backend service with an inline JWKS. Rotating its key means generating a new RS384 pair, updating the client's `jwksString`, and replacing both secrets.

The introspection client is `admin-service`, the client the backend marks with `allow.token.introspection.without.audience.check`. Inferno plays a resource server in that group, and `/auth/introspect` refuses callers that do not authenticate.

## Login theme guard

The automation fails the run when the Keycloak login page is not served by the `proxy-smart` theme, or when its Geist fonts do not load. The CI Keycloak container therefore mounts `keycloak/themes/proxy-smart`, as both local compose files do. `bun run check:theme-env` verifies that every one of those targets sets the `${env.*}` values the theme reads.
