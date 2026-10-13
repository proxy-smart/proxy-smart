# Compliance Reports

Every SMART compliance run publishes its Inferno output here. The reports are
build artifacts of the [SMART Compliance Tests][workflow] workflow, attached to
this site at deploy time rather than committed to the repository.

## Latest runs

<!-- linkcheck: external /compliance/ -->


| Stage | Target | Report |
| --- | --- | --- |
| `dev` | local Docker stack | [summary](/compliance/dev/summary.json) · [Inferno output](/compliance/dev/inferno-output.log) |
| `beta` | VPS | [summary](/compliance/beta/summary.json) · [Inferno output](/compliance/beta/inferno-output.log) |
| `production` | AWS | [summary](/compliance/production/summary.json) · [Inferno output](/compliance/production/inferno-output.log) |

`dev` and `beta` run the full Inferno suite. `production` runs a read-only
consent-enforcement probe instead, because the suite provisions clients and
writes FHIR fixtures, so its report records the probe and not Inferno counts.
[testing/README.md](https://github.com/proxy-smart/proxy-smart/blob/develop/testing/README.md)
describes the stages, triggers and credentials.

A stage shows nothing until it has run at least once within the artifact
retention window. `summary.json` carries the counts and a link back to the run:

<!-- doccheck: skip — sample output, not code -->
```json
{
  "test_suite": "smart_stu2_2",
  "test_stage": "dev",
  "timestamp": "2026-08-08T09:18:21Z",
  "commit": "589e95d904b88787a239f4f03384fb91247b1030",
  "run_url": "https://github.com/proxy-smart/proxy-smart/actions/runs/...",
  "passed": 42,
  "failed": 0,
  "status": "success"
}
```

## Why these are not in the repository

They used to be committed to `develop` after each run. Because the Inferno log
and the Keycloak log are regenerated every time, each run produced a few hundred
lines of diff, which meant a promotion PR that changed no source at all still
looked like a real change — [#954][pr954] carried 75 additions and 151 deletions
of pure log churn.

Publishing them as artifacts also let the compliance workflow drop `contents:
write` and the app token it needed to push past branch protection.

For the specification-level view of what is covered, see the
[SMART 2.2.0 Checklist](/SMART_2.2.0_CHECKLIST).

[workflow]: https://github.com/proxy-smart/proxy-smart/actions/workflows/smart-compliance-tests.yml
[pr954]: https://github.com/proxy-smart/proxy-smart/pull/954
