# SMART App Launch Implementation Checklist (Version History)

## Overview

This document provides a detailed breakdown of the HL7 SMART App Launch specification requirements organized by version introduction and our implementation status.

**Specification URL**: http://hl7.org/fhir/smart-app-launch/
**Current Version**: 2.2.0 (STU 2.2) - Published 2024-04-30
**FHIR Version**: Compatible with FHIR DSTU2+, artifacts for R4/R4B

## Version History & Feature Introduction

### SMART 1.0 (STU 1) - November 2018
**Foundation Release**
- Basic OAuth 2.0 patterns for FHIR
- EHR launch and standalone launch flows
- Original scope syntax (`patient/*.read`, `user/*.read`)
- Basic patient and user context

### SMART 2.0 (STU 2) - November 2021
**Major Enhancement Release**
- **New scope syntax** for granular permissions (`patient/[Resource].[cruds]`)
- **PKCE requirement** for authorization
- **POST-based authorization** support
- **Token introspection** profiling (RFC 7662)
- **Backend Services** authorization pattern
- **Asymmetric client authentication** (preferred method)
- Enhanced discovery properties
- Guidance for communicating permissions to end users

### SMART 2.1 (STU 2.1) - April 2023
**Context & State Enhancement Release**
- **Enhanced fhirContext** for more detailed launch context
- **PractitionerRole support** for fhirUser
- **Absolute URL requirement** for smart-configuration links
- **SMART App State Persistence** (experimental)
- **Task profiles** for describing app launch
- Removal of dynamic ports note in redirect_uri

### SMART 2.2 (STU 2.2) - April 2024 (Current)
**Branding & Enhanced Context Release**
- **Surface branding information** for endpoints and organizations
- **Enhanced fhirContext** with canonical and identifier references
- **Organization-level branding** metadata
- **Endpoint-specific branding** support

---

## Discovery & Configuration

### .well-known/smart-configuration Endpoint
**(SMART 1.0+ Core Feature)**

- [x] **Required Fields** *Implemented in `backend/src/lib/smart-config.ts`*
  - `authorization_endpoint` - OAuth 2.0 authorization endpoint
  - `token_endpoint` - OAuth 2.0 token endpoint
  - `capabilities` - Array of supported capabilities
- [x] **Optional Fields** *Implemented*
  - `revocation_endpoint` - Token revocation endpoint
  - `introspection_endpoint` - Token introspection endpoint *(SMART 2.0+)*
  - `management_endpoint` - App management endpoint
  - `registration_endpoint` - Dynamic client registration
- [x] **SMART-Specific Fields** *Implemented*
  - `scopes_supported` - List of supported scopes
  - `response_types_supported` - Supported OAuth response types
  - `code_challenge_methods_supported` - PKCE methods *(SMART 2.0+)*
  - `grant_types_supported` - Supported grant types

### Capability Advertisement

#### SMART 1.0 Core Capabilities
- [x] **App Launch Capabilities** *Implemented*
  - `launch-ehr` - EHR launch support
  - `launch-standalone` - Standalone launch support
  - `client-public` - Public client support
  - `client-confidential-symmetric` - Symmetric client authentication

#### SMART 2.0+ Enhanced Capabilities
- [x] **Enhanced Authentication** *Implemented*
  - `client-confidential-asymmetric` - Asymmetric client authentication *(Preferred)*
- [x] **Authorization Methods** *Implemented*
  - `authorize-post` - Support for POST-based authorization requests
- [x] **Context Capabilities** *Implemented*
  - `context-ehr-patient` - Patient context in EHR launch
  - `context-ehr-encounter` - Encounter context in EHR launch
  - `context-standalone-patient` - Patient selection in standalone
  - `context-standalone-encounter` - Encounter selection in standalone
- [x] **UI Integration Context** *Implemented*
  - `context-banner` - Support for "need patient banner" (`need_patient_banner` token param)
  - `context-style` - Support for SMART style URL *(Experimental)*
- [x] **Single Sign-on** *Implemented*
  - `sso-openid-connect` - Support for SMART's OpenID Connect profile
- [x] **Permission Capabilities** *Implemented*
  - `permission-offline` - Refresh token support
  - `permission-online` - Online refresh tokens *(SMART 2.0+ Experimental)*
  - `permission-patient` - Patient-level access
  - `permission-user` - User-level access
  - `permission-v1` - SMARTv1 scope syntax (backward compatibility)
  - `permission-v2` - SMARTv2 scope syntax *(SMART 2.0+)*

---

## Authorization Patterns

### 1. SMART App Launch (User-Facing Apps)
**(SMART 1.0+ Core Feature)**

#### EHR Launch Flow *(SMART 1.0+)*

- [x] **Launch Parameters** *Implemented in `backend/src/routes/auth/oauth.ts`*
  - `iss` - FHIR server URL
  - `launch` - Launch context token
- [x] **Authorization Request** *Implemented*
  - `response_type=code`
  - `client_id` - Registered client identifier
  - `redirect_uri` - Callback URL
  - `scope` - Requested permissions
  - `state` - CSRF protection
  - `aud` - FHIR server URL
  - `launch` - Launch context (EHR launch)
  - `code_challenge` + `code_challenge_method` - PKCE *(SMART 2.0+ Required)*
- [x] **Authorization Response** *Implemented*
  - Authorization code return
  - State validation
  - Error handling

#### Standalone Launch Flow *(SMART 1.0+)*

- [x] **Patient Selection** *Implemented in UI*
  - Patient picker interface
  - Search functionality
  - Selection persistence
- [x] **Authorization Request (Standalone)** *Implemented*
  - Same as EHR launch but without `launch` parameter
  - Patient selection during auth flow
- [x] **Context Establishment** *Implemented*
  - Patient context from selection
  - Encounter context (if applicable)
  - Triggered by `launch/patient` **or** by any patient-restricted resource scope
    (`patient/*.rs`), per the spec obligation below

- [x] **Patient context for `patient/` scopes** *Implemented*
  - Spec (Scopes and Launch Context, both "Apps that launch from the EHR" and
    "Standalone apps"): *"If an application requests a FHIR Resource scope which is
    restricted to a single patient (e.g., `patient/*.rs`), and the authorization
    results in the EHR granting that scope, the EHR SHALL establish a patient in
    context."* The EHR *"MAY refuse authorization requests including `patient/` that
    do not also include a valid `launch` [/ `launch/patient` scope], or it MAY infer
    the `launch/patient` scope."*
  - We take the **infer** branch: `hasPatientCompartmentScope` in
    `@proxy-smart/auth` makes a `patient/` scope trigger the same launch handling
    as `launch/patient`, so an EHR launch code or the patient picker establishes
    the context, and `canReturnPatient` lets it reach the app.
  - **Data restricted to the in-context patient** — implemented, gated by
    `ROLE_BASED_FILTERING_MODE`:
    - `enforce` — a `patient/`-scoped grant is narrowed to the token's `patient`
      claim for every user type (searches gain `patient=Patient/<id>`, `Patient`
      searches gain `_id=<id>`, cross-patient direct reads are refused), and a
      patient-scoped token carrying no context is refused outright.
    - `audit-only` *(current default in every environment)* — logs what `enforce`
      would change, changing nothing. Review those logs before flipping.
    - `disabled` — no compartment filtering.
    - The posture is declared per environment (`docker-compose.beta.yml`,
      `backend-stack.ts` in the `proxy-smart-infra` repo) rather than inherited from code
      defaults, so changing it is a reviewable edit.

#### Token Exchange *(Enhanced in SMART 2.0+)*

- [x] **Authorization Code Exchange** *Implemented*
  - Code for token exchange
  - Client authentication (if confidential)
  - **PKCE verification** *(SMART 2.0+ Required)*
- [x] **Token Response** *Implemented with SMART context*
  - `access_token` - Bearer token for API access
  - `token_type` - Always "Bearer"
  - `expires_in` - Token lifetime
  - `scope` - Granted permissions
  - `refresh_token` - For offline access (optional)
  - `patient` - Patient context (if applicable)
  - `encounter` - Encounter context (if applicable)

### 2. SMART Backend Services (System-to-System)
**(SMART 2.0+ New Feature)**

#### Client Credentials Grant

- [x] **Client Authentication** *Implemented*
  - JWT-based authentication (preferred)
  - Client secret authentication (alternative)
- [x] **Token Request** *Implemented*
  - `grant_type=client_credentials`
  - `scope` - System-level scopes
  - `client_assertion_type` - JWT assertion type
  - `client_assertion` - Signed JWT
- [x] **Token Response** *Implemented*
  - `access_token` - System-level access token
  - `token_type` - "Bearer"
  - `expires_in` - Token lifetime
  - `scope` - Granted system permissions

---

## Client Authentication

### Asymmetric Authentication (Preferred - SMART 2.0+)

- [x] **JWT Creation** *Implemented*
  - `iss` - Client ID
  - `sub` - Client ID
  - `aud` - Token endpoint URL
  - `jti` - Unique token identifier
  - `exp` - Expiration time
- [x] **Key Management** *Implemented via Keycloak*
  - RSA or EC key pairs
  - Key rotation support
  - JWKS endpoint for public keys
- [x] **Signature Validation** *Implemented*
  - Algorithm verification (RS256, ES256)
  - Key retrieval and caching
  - Signature verification

### Symmetric Authentication (SMART 1.0+)

- [x] **Client Secret Methods** *Implemented*
  - HTTP Basic authentication
  - POST body parameters
  - Client secret validation
- [x] **Security Considerations** *Implemented*
  - Secure secret storage
  - Secret rotation capabilities
  - Rate limiting protection

---

## Scopes & Permissions

### Legacy SMART v1 Scope Syntax (SMART 1.0)

- [x] **Backward Compatibility** *Implemented in `smart-config.ts`*
  - `patient/*.read` - Read access patterns
  - `user/*.read` - User read access
  - `patient/*.write` - Write access patterns
  - Migration path from v1 to v2

### SMART v2 Scope Syntax (SMART 2.0+)

- [x] **Resource Scopes** *Implemented*
  - `patient/[Resource].[cruds]` - Patient-specific access
  - `user/[Resource].[cruds]` - User-accessible resources
  - `system/[Resource].[cruds]` - System-wide access
- [x] **Interaction Types** *Implemented*
  - `c` - Create (POST)
  - `r` - Read (GET)
  - `u` - Update (PUT)
  - `d` - Delete (DELETE)
  - `s` - Search (GET with parameters)

### Launch Context Scopes (Enhanced in SMART 2.1/2.2)

#### Basic Context (SMART 1.0+)
- [x] **Patient Context** *Implemented*
  - `launch/patient` - Patient context required
  - Patient ID in token response
- [x] **Encounter Context** *Implemented*
  - `launch/encounter` - Encounter context required
  - Encounter ID in token response
- [x] **Other Contexts** *Implemented*
  - `launch` - General launch context
  - Custom context parameters

#### Enhanced fhirContext (SMART 2.1+)
- [x] **SMART 2.1 Enhancements** *Implemented in token response*
  - More detailed context when launching apps
  - PractitionerRole support for fhirUser
- [x] **SMART 2.2 Enhancements** *Implemented*
  - Canonical reference support
  - Identifier reference support

### Special Scopes

- [x] **Offline Access (SMART 1.0+)** *Implemented*
  - `offline_access` - Refresh token issuance
  - Long-term access without user presence
- [x] **Online Access (SMART 2.0+ Experimental)** *Implemented*
  - `online_access` - Refresh token valid while user is online
  - Scope negotiation may grant online or offline token
- [x] **OpenID Connect (SMART 1.0+)** *Implemented*
  - `openid` - Identity token issuance
  - `profile` - User profile information
  - `fhirUser` - FHIR User resource reference

---

## Token Introspection (SMART 2.0+)

### RFC 7662 Implementation

- [x] **Introspection Endpoint** *Implemented in `oauth.ts`*
  - Token validation service
  - Metadata exposure
  - Client authentication required
- [x] **Response Format** *Implemented via Keycloak*
  - `active` - Token validity status
  - `scope` - Granted scopes
  - `client_id` - Client identifier
  - `username` - User identifier (if applicable)
  - `exp` - Expiration timestamp
- [x] **SMART Extensions** *Implemented in token response*
  - `patient` - Patient context
  - `encounter` - Encounter context
  - `fhirUser` - User FHIR resource

---

## User-Access Brands

> **Note**: Per SMART 2.2.0 spec, `user_access_brand_bundle` and `user_access_brand_identifier` are **RECOMMENDED** in `.well-known/smart-configuration`.

### Basic Branding (SMART 2.1+)

- [x] **Discovery Properties** *(RECOMMENDED)*
  - `user_access_brand_bundle` - URL for Brand Bundle
  - `user_access_brand_identifier` - Identifier for primary entry in Brand Bundle
- [x] **Brand Information**
  - `name` - Provider/organization name (via `BRAND_NAME` env)
  - `logo` - Logo URL with specifications (via `BRAND_LOGO_URL` env)
  - `description` - Provider description (via portal description)
  - `url` - Provider website (via `BRAND_WEBSITE` env)
- [ ] **Patient-Facing UX**
  - "Connect to my records" interface
  - Provider selection with branding

### Enhanced Branding (SMART 2.2+)

- [x] **Endpoint-Level Branding**
  - Brand information surfacing for endpoints (auto-generated from FHIR server store)
  - Endpoint-specific branding support (FHIR version, connection type, contact)
- [x] **Organization-Level Branding**
  - Organization-level branding metadata (`organization-brand` + `organization-portal` extensions)
  - Enhanced brand discovery mechanisms (Brand Bundle at `/branding.json` with ETag support)
  - Organization-specific visual consistency (logo, aliases, categories, address)

---

## App State Persistence (SMART 2.1+ Experimental)

> **Note**: Advertise via `smart-app-state` capability in `.well-known/smart-configuration`.

### Discovery

- [ ] **Capability Advertisement**
  - `smart-app-state` - Capability flag for app state support
  - `associated_endpoints` - Array of endpoints sharing authorization *(Experimental)*

### State Management API

- [ ] **Storage Endpoints**
  - User-specific state storage
  - Patient-specific configurations
  - Application preferences
  - Cross-session persistence
- [ ] **Data Format**
  - JSON-based storage
  - Version control
  - Conflict resolution
  - State synchronization
- [ ] **Access Control**
  - Scope-based access to state
  - User isolation
  - Patient data separation
  - App-specific namespacing

### Task Profiles (SMART 2.1+)

- [ ] **App Launch Task Profiles**
  - Task profiles for describing app launch
  - Launch workflow documentation
  - Integration with FHIR workflow patterns

---

## Task-Based App Launch (SMART 2.1+)

> **Note**: Allows EHRs to request app launches via FHIR Task resources.

### Task Launch Flow

- [ ] **Task Resource Support**
  - `Task.code` - Identifies launch request type
  - `Task.input` - Launch parameters (app URL, context)
  - `Task.output` - Launch result/status
- [ ] **Launch Request Types**
  - Launch from clinical workflow
  - Launch with specific patient/encounter context
  - Launch with custom parameters
- [ ] **Task Status Management**
  - Task creation and acceptance
  - Launch completion tracking
  - Error handling and retry logic

---

## Testing & Compliance

### SMART App Launch Test Suite

- [x] **Inferno Testing** *Automated in CI*
  - Official SMART test suite (Inferno v0.4.38+)
  - Automated compliance verification via `smart-compliance-tests.yml`
  - Runs on every merge to `test`/`main` and weekly via cron
  - Puppeteer-based OAuth automation for unattended test execution
  - Reports committed to `testing/{stage}/inferno-report/`
- [x] **Test Categories** *Partially implemented*
  - EHR launch flows
  - Standalone launch flows
  - Backend services
  - Token introspection
  - Error handling

### Custom Test Implementation

- [x] **Unit Tests** *Implemented*
  - OAuth flow components
  - Scope validation
  - Token management
- [x] **Integration Tests** *Implemented*
  - End-to-end flows
  - FHIR server integration
  - Client application testing
- [ ] **Security Tests**
  - Penetration testing
  - Vulnerability assessment
  - OWASP compliance

---

## Implementation Priority Matrix by Version

### SMART 1.0 Foundation (High Priority - Core Functionality)

1. **Discovery & Configuration** - Foundation for all other features
   - .well-known/smart-configuration endpoint
   - Basic capability advertisement
2. **EHR Launch Flow** - Primary use case for most implementations
   - Launch parameters (iss, launch)
   - Basic authorization request/response
3. **Basic Scopes (v1 syntax)** - Essential for data access
   - `patient/*.read`, `user/*.read` patterns
4. **Token Management** - Core OAuth functionality
   - Authorization code exchange
   - Basic token response

### SMART 2.0 Enhancements (Medium Priority - Extended Features)

1. **PKCE Implementation** - **Required** security enhancement
   - Code challenge/verifier support
2. **New Scope Syntax (v2)** - Modern permission model
   - `patient/[Resource].[cruds]` patterns
3. **Backend Services** - System-to-system integration
   - Client credentials grant
   - JWT-based authentication
4. **Token Introspection** - Resource server support
   - RFC 7662 implementation
5. **Asymmetric Authentication** - Preferred security method
   - JWT-based client authentication

### SMART 2.1 Context & State (Medium-Low Priority)

1. **Enhanced fhirContext** - Improved launch context
   - More detailed context information
   - PractitionerRole support
2. **App State Persistence** - Application convenience (Experimental)
   - User/patient-specific state storage
3. **Task Profiles** - Workflow integration
   - App launch workflow documentation
4. **Absolute URL Requirements** - Configuration compliance

### SMART 2.2 Branding (Lower Priority - UX Enhancement)

1. **User-Access Brands** - UX enhancement
   - Endpoint and organization branding
2. **Enhanced fhirContext (2.2)** - Advanced context support
   - Canonical and identifier references

### Legacy Support (As Needed)

1. **SMART v1 Scope Support** - Backward compatibility
   - Migration path from v1 to v2
2. **OpenID Connect Integration** - Identity features
   - Identity token support

---

## Implementation Roadmap by Release Stage

### Shipped (current: 0.4.x)
**Focus: Core OAuth and SMART Foundation**

#### Completed
- [x] Discovery endpoint (`.well-known/smart-configuration`)
- [x] OAuth 2.0 framework with Keycloak integration
- [x] EHR and standalone launch flows
- [x] Patient selection interface
- [x] PKCE implementation
- [x] v1 and v2 scope syntax support
- [x] Token introspection
- [x] Backend services authorization
- [x] JWT-based authentication
- [x] Unit tests for core components

### Remaining: Integration Testing & Edge Cases

The Playwright harness in `testing/e2e/` is configured but carries no specs yet; Inferno runs against every release channel from `testing/{alpha,beta,production}/`.

- [ ] Playwright tests for UI flows
- [ ] End-to-end integration tests
- [ ] Error handling improvements
- [ ] Edge case coverage

### Production Release Targets

#### SMART 2.2.0 Compliance
- [x] User-access branding support *`backend/src/lib/brand-bundle.ts`, admin routes in `routes/admin/branding.ts`*
- [ ] App state persistence (experimental)
- [x] Inferno test suite compliance *Automated in CI*

#### Remaining before v1.0.0
- [ ] Performance optimization
- [ ] Penetration testing
- [ ] Full documentation
- [ ] Certification readiness

---

## Development & Deployment

### Development Environment

- [x] **Local Development Setup** *Implemented*
  - Docker Compose for local testing
  - Hot reload configuration
  - Environment variable management
  - Database setup and migrations

### Production Deployment

- [x] **Infrastructure Requirements** *Implemented*
  - HTTPS enforcement (required for OAuth)
  - Reverse proxy configuration
  - Load balancing for high availability
  - Database clustering and backups
- [x] **Security Configuration** *Implemented*
  - JWT signing keys management
  - Client certificate validation
  - Rate limiting implementation
  - CORS policy configuration
- [x] **Monitoring & Logging** *Implemented*
  - OAuth flow monitoring
  - Performance metrics collection
  - Security event logging
  - Error tracking and alerting

### Quality Assurance

- [x] **Code Quality** *Implemented*
  - ESLint/TSLint configuration
  - TypeScript strict mode
  - Code coverage targets (>90%)
  - Automated code review
- [x] **Documentation** *Implemented*
  - API documentation (OpenAPI/Swagger)
  - Integration guides
  - Troubleshooting guides
  - Security best practices

---

## Compliance & Certification

### Specification Compliance

- [ ] **HL7 FHIR Compliance**
  - FHIR R4/R4B compatibility
  - FHIR validation implementation
  - Resource conformance verification
- [ ] **OAuth 2.0 Compliance**
  - RFC 6749 authorization framework
  - RFC 7636 PKCE implementation
  - RFC 7662 token introspection
  - Security best practices (RFC 6819)

### Security Standards

- [ ] **Healthcare Security**
  - HIPAA compliance considerations
  - HITECH Act requirements
  - Patient data protection
  - Audit trail requirements
- [ ] **General Security**
  - OWASP Top 10 mitigation
  - Penetration testing readiness
  - Vulnerability scanning
  - Security incident response

### Certification Readiness

- [x] **SMART App Launch Certification** *In progress*
  - Inferno test suite compliance (automated, 55+ tests passing)
  - Official certification submission
  - Test result documentation
- [ ] **Regulatory Compliance**
  - FDA guidance compliance (if applicable)
  - International standards (ISO 27001)
  - Regional privacy laws (GDPR, etc.)

---

This checklist serves as both a reference for the SMART 2.2.0 specification and a comprehensive tracking mechanism for our implementation progress. Each item should be verified against the official specification and tested thoroughly before marking as complete.
