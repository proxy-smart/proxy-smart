# Environment Variables

Complete reference for all environment variables used by Proxy Smart.

## Core

| Variable | Description | Default |
|---|---|---|
| `BASE_URL` | Public base URL of the Proxy Smart instance | `http://localhost:8445` |
| `PORT` | HTTP port for the backend server | `8445` |
| `NODE_ENV` | Node environment (`production`, `development`) | -- |
| `CORS_ORIGINS` | Comma-separated allowed CORS origins | development defaults |

## Keycloak

| Variable | Description | Default |
|---|---|---|
| `KEYCLOAK_BASE_URL` | Internal Keycloak URL (container-to-container) | -- |
| `KEYCLOAK_PUBLIC_URL` | Browser-facing Keycloak URL | derived from `KEYCLOAK_BASE_URL` |
| `KEYCLOAK_REALM` | Keycloak realm name | -- |
| `KEYCLOAK_DOMAIN` | Domain override for public URL hostname | -- |
| `KEYCLOAK_ADMIN_CLIENT_ID` | Service account client ID | -- |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | Service account client secret | -- |

## FHIR

| Variable | Description | Default |
|---|---|---|
| `FHIR_SERVER_BASE` | Comma-separated upstream FHIR server URLs | `http://localhost:8081/fhir` |
| `FHIR_SUPPORTED_VERSIONS` | Comma-separated FHIR versions | `R4` |

## SMART Configuration

| Variable | Description | Default |
|---|---|---|
| `SMART_CONFIG_CACHE_TTL` | SMART well-known configuration cache TTL (ms) | `300000` |
| `SMART_SCOPES_SUPPORTED` | Comma-separated override for supported SMART scopes | auto-detected |
| `SMART_CAPABILITIES` | Comma-separated override for SMART capabilities | auto-detected |

## Consent Enforcement

| Variable | Description | Default |
|---|---|---|
| `CONSENT_ENABLED` | Enable consent checking | `false` |
| `CONSENT_MODE` | `disabled`, `audit-only`, or `enforce` | `disabled` |
| `CONSENT_CACHE_TTL` | Consent decision cache TTL (ms) | `60000` |
| `CONSENT_EXEMPT_CLIENTS` | Comma-separated client IDs exempt from consent | -- |
| `CONSENT_REQUIRED_RESOURCE_TYPES` | Resource types that always require consent | -- |
| `CONSENT_EXEMPT_RESOURCE_TYPES` | Resource types exempt from consent | `CapabilityStatement,metadata` |

## Identity Assurance Level (IAL)

| Variable | Description | Default |
|---|---|---|
| `IAL_ENABLED` | Enable IAL verification | `false` |
| `IAL_MINIMUM_LEVEL` | Minimum IAL for general access (`level1`–`level4`) | `level1` |
| `IAL_SENSITIVE_RESOURCE_TYPES` | Comma-separated resource types requiring elevated IAL | -- |
| `IAL_SENSITIVE_MINIMUM_LEVEL` | Minimum IAL for sensitive resources | `level3` |
| `IAL_VERIFY_PATIENT_LINK` | Verify token patient matches Person.link[] | `true` |
| `IAL_ALLOW_ON_PERSON_LOOKUP_FAILURE` | Allow access if Person lookup fails | `false` |
| `IAL_CACHE_TTL` | Person resource cache TTL (ms) | `300000` |

## Access Control

| Variable | Description | Default |
|---|---|---|
| `SCOPE_ENFORCEMENT_MODE` | SMART scope enforcement: `disabled`, `audit-only`, `enforce` | `enforce` |
| `ROLE_BASED_FILTERING_MODE` | Role-based data isolation: `disabled`, `audit-only`, `enforce` | `audit-only` |
| `PATIENT_SCOPED_RESOURCES` | Comma-separated resource types subject to patient-scoped filtering | `Observation,Condition,Procedure,...` |

## Branding (SMART 2.2.0 User-Access Brands)

| Variable | Description | Default |
|---|---|---|
| `BRAND_NAME` | Organization display name | package display name |
| `BRAND_WEBSITE` | Organization website URL | `BASE_URL` |
| `BRAND_LOGO_URL` | Logo image URL | -- |
| `BRAND_LOGO_LICENSE_URL` | Logo license URL | -- |
| `BRAND_ALIASES` | Comma-separated alternative names | -- |
| `BRAND_CATEGORY` | Organization category (`prov`, `pay`, `laboratory`, etc.) | `prov` |
| `BRAND_PORTAL_NAME` | Patient portal display name | -- |
| `BRAND_PORTAL_URL` | Patient portal URL | -- |
| `BRAND_PORTAL_DESCRIPTION` | Patient portal description | -- |
| `BRAND_PORTAL_LOGO_URL` | Patient portal logo URL | -- |
| `BRAND_PORTAL_LOGO_LICENSE_URL` | Portal logo license URL | -- |
| `BRAND_ADDRESS_CITY` | Address city | -- |
| `BRAND_ADDRESS_STATE` | Address state | -- |
| `BRAND_ADDRESS_POSTAL_CODE` | Address postal code | -- |
| `BRAND_ADDRESS_COUNTRY` | Address country | -- |
| `BRAND_IDENTIFIER` | Brand identifier URI | `BRAND_WEBSITE` or `BASE_URL` |

## MCP

| Variable | Description | Default |
|---|---|---|
| `OPENAI_API_KEY` | API key for embeddings and semantic search | -- |
| `MCP_ENDPOINT_PATH` | MCP endpoint URL path | `/mcp` |
| `MCP_PREFAB_UI` | Render MCP tool results as prefab UIs for MCP Apps hosts. Tools stop advertising `outputSchema` when on | `false` |

## App Store

| Variable | Description | Default |
|---|---|---|
| `APP_STORE_SHOW_ADMIN` | Show the Admin link in the app store header. The store is a public page and the console only works for a staff admin, so it is hidden unless a deployment asks for it | `false` |

Replaces `APP_STORE_HIDE_ADMIN`, which defaulted to SHOWING the link: a deployment that set
nothing published a link to the staff console on a public page. Set `APP_STORE_SHOW_ADMIN=true`
to get the old behaviour back on an internal deployment.

## DICOMweb Proxy

| Variable | Description | Default |
|---|---|---|
| `DICOMWEB_BASE_URL` | Upstream PACS DICOMweb URL | -- (disabled if unset) |
| `DICOMWEB_WADO_ROOT` | WADO-RS root URL | `DICOMWEB_BASE_URL` |
| `DICOMWEB_QIDO_ROOT` | QIDO-RS root URL | `DICOMWEB_BASE_URL` |
| `DICOMWEB_UPSTREAM_AUTH` | Auth header for upstream PACS | -- |
| `DICOMWEB_TIMEOUT_MS` | Request timeout for PACS calls (ms) | `30000` |

## Access Control Integration (Physical)

### Kisi

| Variable | Description | Default |
|---|---|---|
| `KISI_API_KEY` | Kisi API key | -- |
| `KISI_BASE_URL` | Kisi API base URL | `https://api.kisi.io` |
| `KISI_TIMEOUT_MS` | Request timeout (ms) | `10000` |

### UniFi Access

| Variable | Description | Default |
|---|---|---|
| `UNIFI_ACCESS_HOST` | UniFi Access controller hostname | -- |
| `UNIFI_ACCESS_USERNAME` | Controller username | -- |
| `UNIFI_ACCESS_PASSWORD` | Controller password | -- |
