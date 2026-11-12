# Launch Context

SMART launch context (the patient, encounter, `fhirUser` and the rest an app receives with its token) is resolved during each authorization, not configured per user. There is no admin API for storing it on a user.

## Where context comes from

- **EHR launch.** The EHR, or an agent acting for its signed-in user, calls `POST /auth/launch` with the context to launch with and hands the app the signed `launch` code it gets back. See [EHR Launch](../oauth-authentication#ehr-launch).
- **Task-based launch.** `POST /auth/launch/task` acts on a SMART launch Task and returns the app launch URL. See [Task-Based App Launch](../task-launch).
- **Standalone launch.** An app that asks for `launch/patient` or `launch/encounter` without an EHR gets the context from a Patient `fhirUser`, or from the [Patient Picker](../apps/patient-picker), which pauses the authorization for a practitioner to choose it.

## What the app receives

The token response carries the resolved context, and token introspection repeats these fields for as long as the token is valid:

<!-- generated:launch-context-claims -->
`patient`, `encounter`, `fhirUser`, `fhirContext`, `intent`, `smart_style_url`, `tenant`, `need_patient_banner`, `act`, `scope`
<!-- /generated:launch-context-claims -->

The context is stored by the token's `jti`, shared through PostgreSQL when a database is configured, and survives a refresh. See [Database and multi-node state](../environment-variables#database-and-multi-node-state).

## Configuring what can be requested

Which launch scopes an app may request is part of its SMART app registration ([SMART Apps](smart-apps)), and the Keycloak client scopes and protocol mappers behind them are managed in [Scope Management](scope-management).
