# Brand Management

The Brand Management section lets you configure **User-Access Brands** as defined in [SMART App Launch 2.2.0 Section 8](https://hl7.org/fhir/smart-app-launch/STU2.2/brands.html). Brands help patients and app developers identify your organization when choosing healthcare providers in SMART-enabled applications.

Proxy Smart publishes a **FHIR Brand Bundle** at `/branding.json` and references it from `.well-known/smart-configuration` through the `user_access_brand_bundle` and `user_access_brand_identifier` fields. Every brand property is editable from the Admin UI, and no restart is needed for a change to take effect.

## How It Works

1. **Environment variables** provide default brand values at startup (e.g. `BRAND_NAME`, `BRAND_WEBSITE`)
2. **Admin overrides** are persisted in Keycloak realm attributes (prefix `brand_settings.`)
3. At runtime, admin overrides take precedence over env defaults
4. The FHIR Brand Bundle is rebuilt automatically when settings change
5. `Bundle.timestamp` and each entry's `meta.lastUpdated` record when that content last changed, not when the bundle was built. Saving identical settings, restarting, or asking another node moves neither the timestamp nor the `ETag`

## Brand Identity

Core fields that identify your organization in the SMART ecosystem:

| Field | Env Variable | Description |
|-------|-------------|-------------|
| **Brand Name** | `BRAND_NAME` | Human-readable organization name |
| **Website** | `BRAND_WEBSITE` | Organization website URL |
| **Identifier** | `BRAND_IDENTIFIER` | Identifier value; advertised as `user_access_brand_identifier` and carried only by the primary Organization (defaults to website URL) |
| **Identifier System** | `BRAND_IDENTIFIER_SYSTEM` | Identifier system (defaults to `urn:ietf:rfc:3986`). Set both to publish a customer-supplied identifier, e.g. an NPI or an OID |
| **Developer URL** | `BRAND_DEVELOPER_URL` | https page where app developers configure access, published as each Endpoint's `contact` (defaults to the proxy's app registration docs) |
| **Category** | `BRAND_CATEGORY` | Organization type code (see table below) |
| **Aliases** | `BRAND_ALIASES` | Comma-separated alternative names (e.g. abbreviations, former names) |

### Organization Categories

Categories follow the [FHIR organization-type CodeSystem](http://hl7.org/fhir/codesystem-organization-type.html):

| Code | Display |
|------|---------|
| `prov` | Healthcare Provider |
| `pay` | Payer |
| `laboratory` | Laboratory |
| `imaging` | Imaging Center |
| `pharmacy` | Pharmacy |
| `network` | Health Information Network |
| `aggregator` | Data Aggregator |

## Logo & Branding

Logo URLs are included in the FHIR Organization resource via the `organization-brand` extension.

| Field | Env Variable | Description |
|-------|-------------|-------------|
| **Brand Logo URL** | `BRAND_LOGO_URL` | SVG or 1024 px PNG with transparent background |
| **Logo License URL** | `BRAND_LOGO_LICENSE_URL` | URL to the logo license |
| **Portal Logo URL** | `BRAND_PORTAL_LOGO_URL` | Logo for the patient-facing portal |
| **Portal Logo License URL** | `BRAND_PORTAL_LOGO_LICENSE_URL` | License for the portal logo |

> **Tip**: Per the SMART spec, logos should be SVG (preferred) or at least 1024 px PNG with a transparent background for best results across apps.

## Patient Portal

Portal settings are published via the `organization-portal` FHIR extension. App developers use these to help patients connect to your patient-facing portal.

| Field | Env Variable | Description |
|-------|-------------|-------------|
| **Portal Name** | `BRAND_PORTAL_NAME` | Name of the patient-facing portal (e.g. "MyChart") |
| **Portal URL** | `BRAND_PORTAL_URL` | Portal login or home URL |
| **Portal Description** | `BRAND_PORTAL_DESCRIPTION` | Markdown description of the portal |
| **Additional Portals** | `BRAND_ADDITIONAL_PORTALS` | Further portals as a list (JSON in the env var). Each has `name`, `url`, optional `description`, `logoUrl`, `logoLicenseUrl`, and `serverIds` to list only some FHIR servers as its endpoints |

Each portal becomes its own `organization-portal` extension, so an app can show one "connect" button per portal on the brand's card.

## Organization Address

Address fields are included in the FHIR Organization resource for geographic identification.

| Field | Env Variable | Description |
|-------|-------------|-------------|
| **Street** | `BRAND_ADDRESS_LINE` | Street address, one line per row (`address.line`) |
| **City** | `BRAND_ADDRESS_CITY` | Organization city |
| **State / Province** | `BRAND_ADDRESS_STATE` | State or province |
| **Postal Code** | `BRAND_ADDRESS_POSTAL_CODE` | ZIP or postal code |
| **Country** | `BRAND_ADDRESS_COUNTRY` | ISO country code (e.g. `US`) |

## Admin API

Brand settings can also be managed programmatically via the REST API.

### Get Brand Configuration

```http
GET /admin/branding
Authorization: Bearer <token>
```

**Response** `200 OK`:

```json
{
  "message": "Brand configuration retrieved",
  "config": {
    "name": "Acme Health",
    "website": "https://acmehealth.example.com",
    "logoUrl": "https://acmehealth.example.com/logo.svg",
    "logoLicenseUrl": null,
    "aliases": ["Acme", "AH"],
    "category": "prov",
    "portalName": "MyAcme",
    "portalUrl": "https://portal.acmehealth.example.com",
    "portalDescription": "Access your health records",
    "portalLogoUrl": null,
    "portalLogoLicenseUrl": null,
    "addressCity": "Boston",
    "addressState": "MA",
    "addressPostalCode": "02101",
    "addressLine": "1 Main Street\nSuite 200",
    "addressCountry": "US",
    "identifier": "https://acmehealth.example.com",
    "identifierSystem": "urn:ietf:rfc:3986",
    "developerUrl": "https://developer.acmehealth.example.com",
    "additionalPortals": [
      { "name": "Acme Lab Results", "url": "https://labs.acmehealth.example.com", "serverIds": ["lab"] }
    ]
  },
  "timestamp": "2026-03-24T12:00:00.000Z"
}
```

### Update Brand Configuration

```http
PUT /admin/branding
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Acme Health System",
  "website": "https://acmehealth.example.com",
  "logoUrl": "https://acmehealth.example.com/logo.svg",
  "logoLicenseUrl": null,
  "aliases": ["Acme", "AH", "Acme Health"],
  "category": "prov",
  "portalName": "MyAcme",
  "portalUrl": "https://portal.acmehealth.example.com",
  "portalDescription": "Access your health records online.",
  "portalLogoUrl": null,
  "portalLogoLicenseUrl": null,
  "addressCity": "Boston",
  "addressState": "MA",
  "addressPostalCode": "02101",
  "addressCountry": "US",
  "identifier": "https://acmehealth.example.com",
  "identifierSystem": "urn:ietf:rfc:3986",
  "developerUrl": "https://developer.acmehealth.example.com"
}
```

`addressLine`, `identifierSystem`, `developerUrl` and `additionalPortals` are optional; a field left out keeps its stored value. `developerUrl` must be an `https` URL.

A successful update clears the Brand Bundle cache so the next request to `/branding.json` returns fresh data.

## FHIR Brand Bundle

The published bundle at `/branding.json` is a FHIR `Bundle` (type `collection`) containing:

- **Organization** -- the brand itself, with the `organization-brand` extension (logo and license) and one `organization-portal` extension per portal. `brandBundle` is not set: it links to a different bundle, and this one has none to point at
- **Endpoint** -- one per registered FHIR server, with FHIR version, connection metadata and the developer `contact` URL
- **Organization per Keycloak Organization** -- linked to the primary brand by `partOf`. Its identifier is its own `identifier` or `website` override, never the primary one; an identifier already used in the bundle is dropped, so `user_access_brand_identifier` matches exactly one Organization

### Example Bundle Structure

```json
{
  "resourceType": "Bundle",
  "id": "user-access-brands",
  "type": "collection",
  "timestamp": "2026-03-24T12:00:00.000Z",
  "entry": [
    {
      "fullUrl": "https://proxy.example.com/branding/Organization/primary-brand",
      "resource": {
        "resourceType": "Organization",
        "id": "primary-brand",
        "meta": { "lastUpdated": "2026-03-24T12:00:00.000Z" },
        "active": true,
        "identifier": [{ "system": "urn:ietf:rfc:3986", "value": "https://acmehealth.example.com" }],
        "name": "Acme Health",
        "type": [{ "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/organization-type", "code": "prov" }] }],
        "extension": [
          { "url": "http://hl7.org/fhir/StructureDefinition/organization-brand", "extension": [...] },
          { "url": "http://hl7.org/fhir/StructureDefinition/organization-portal", "extension": [...] }
        ],
        "endpoint": [{ "reference": "Endpoint/endpoint-main" }]
      }
    },
    {
      "fullUrl": "https://proxy.example.com/branding/Endpoint/endpoint-main",
      "resource": {
        "resourceType": "Endpoint",
        "id": "endpoint-main",
        "status": "active",
        "meta": { "lastUpdated": "2026-03-20T09:30:00.000Z" },
        "connectionType": { "system": "http://terminology.hl7.org/CodeSystem/endpoint-connection-type", "code": "hl7-fhir-rest" },
        "contact": [{ "system": "url", "value": "https://developer.acmehealth.example.com" }],
        "address": "https://proxy.example.com/smart/main/R4"
      }
    }
  ]
}
```

### SMART Configuration Integration

The `/.well-known/smart-configuration` response automatically includes:

```json
{
  "user_access_brand_bundle": "https://proxy.example.com/branding.json",
  "user_access_brand_identifier": { "system": "urn:ietf:rfc:3986", "value": "https://acmehealth.example.com" }
}
```

Both the bundle and this response read the same runtime brand configuration, so an identifier changed in the Admin UI shows up in both at once.

## Configuration Precedence

Brand settings resolve in the following order (first non-null wins):

1. **Admin overrides** -- values saved via the Admin UI or `PUT /admin/branding`
2. **Environment variables** -- `BRAND_*` env vars set at deployment
3. **Built-in defaults** -- package name, `BASE_URL`, `prov` category

This means you can deploy with env vars for a quick setup and later fine-tune through the Admin UI without restarting.

## Cache Behavior

- The Brand Bundle is cached for **60 seconds** (`Cache-Control: public, max-age=60`)
- The weak `ETag` is a hash of the content, so it only changes when the content does. `If-None-Match` may list several tags or `*`; a match returns `304 Not Modified` with the `ETag`, `Cache-Control` and `Last-Modified` headers
- Change times are kept in the admin-config store (PostgreSQL when `DATABASE_URL` is set, else `DATA_DIR/brand-bundle-changes.json`). A FHIR server added or removed shows up, with its change time, on the next rebuild, at most 60 seconds later
- Saving brand settings via the Admin UI or API **immediately clears the cache**
- The SMART configuration endpoint picks up the current brand identifier on every request
