# Monitoring & Observability

Proxy Smart includes a comprehensive monitoring system covering OAuth flows, FHIR server health, consent decisions, and admin audit events. Each subsystem provides real-time SSE streams, REST query endpoints, and JSONL export.

## Overview

| Subsystem | Prefix | SSE Streams | REST Endpoints | Log Files |
|-----------|--------|-------------|----------------|-----------|
| **OAuth** | `/monitoring/oauth` | 2 (events, analytics) | 5 | `logs/oauth-metrics/` |
| **FHIR Health** | `/monitoring/fhir` | 2 (checks, summaries) | 2 | `logs/fhir-health/` |
| **FHIR Proxy** | `/monitoring/fhir-proxy` | 2 (events, analytics) | 2 | -- |
| **Auth Events** | `/monitoring/auth` | 2 (events, analytics) | 2 | -- |
| **Email Events** | `/monitoring/email` | 2 (events, analytics) | 2 | -- |
| **Consent** | `/monitoring/consent` | 2 (events, analytics) | 3 | `logs/consent-metrics/` |
| **Admin Audit** | `/monitoring/admin-audit` | 2 (events, analytics) | 3 | `logs/admin-audit/` |
| **System Status** | `/health`, `/status` | -- | 2 | `logs/keycloak/` |

All monitoring endpoints require a valid Bearer token. SSE endpoints also accept a `?token=` query parameter (since `EventSource` cannot send custom headers).

## Admin UI

The **Monitoring** tab in the admin dashboard is a tabbed container with:

| Tab | Content |
|-----|---------|
| **Dashboard** | OAuth flow summary stats + FHIR server uptime widget |
| **FHIR Proxy** | Proxied FHIR request metrics -- throughput, response times, error rates by server and resource type |
| **OAuth** | Live OAuth event table and analytics charts with predictive insights |
| **Auth** | Keycloak authentication events (logins, failures, session activity) |
| **Email** | Email delivery events from Keycloak (verification, password reset) |
| **Consent** | Consent decision monitoring dashboard |
| **Audit Log** | Admin audit event log with filtering and JSONL export |

FHIR server health is also shown on the main **Dashboard** page as a status card.

## OAuth Monitoring

Tracks all OAuth 2.0 authorization flows: token requests, refresh grants, authorization codes, errors.

### Endpoints -- `/monitoring/oauth`

| Method | Path | Type | Description |
|--------|------|------|-------------|
| `GET` | `/events/stream` | SSE | Real-time OAuth flow events |
| `GET` | `/analytics/stream` | SSE | Real-time analytics updates |
| `GET` | `/events` | REST | Query events (filter: `limit`, `type`, `status`, `clientId`, `since`) |
| `GET` | `/analytics` | REST | Analytics snapshot (totals, rates, top clients, hourly stats) |
| `GET` | `/health` | REST | System health metrics + alerts |
| `GET` | `/analytics/export` | REST | Download analytics as JSON |
| `GET` | `/events/export` | REST | Download event log as JSONL |

### Analytics Fields

- `totalRequests`, `successfulRequests`, `failedRequests`, `successRate`
- `averageResponseTime`, `activeTokens`
- `topClients` -- ranked by request count with per-client success rate
- `flowsByType` -- breakdown by grant type (authorization_code, refresh_token, etc.)
- `errorsByType` -- breakdown by error category
- `hourlyStats` -- time series (hour, success, error, total)
- `predictiveInsights` -- trend direction, next-hour forecast, anomaly risk assessment
- `weekdayInsights` -- per-weekday averages with projections

### WebSocket Transport

An alternative WebSocket transport is available at `/oauth/monitoring/websocket` supporting bidirectional messaging (subscribe, unsubscribe, filter, ping/pong). Connection info at `GET /oauth/monitoring/websocket/info`.

### Log Files

- `logs/oauth-metrics/oauth-events.jsonl` -- event log (one JSON object per line)
- `logs/oauth-metrics/oauth-analytics.json` -- latest analytics snapshot
- `logs/oauth-metrics/system-health.json` -- latest health snapshot

## FHIR Server Health Monitoring

Background poller that checks all configured FHIR servers every 30 seconds.

### How It Works

1. On startup, `FhirHealthLogger` initializes and replays recent checks from JSONL
2. `start()` begins polling -- hits each FHIR server's metadata endpoint
3. Each check produces a `FhirHealthCheck` with status (`healthy`, `degraded`, `unhealthy`) and response time
4. Results are persisted to JSONL and broadcast to SSE subscribers
5. After each full sweep, uptime summaries are computed and broadcast

### Endpoints -- `/monitoring/fhir`

| Method | Path | Type | Description |
|--------|------|------|-------------|
| `GET` | `/checks/stream` | SSE | Real-time per-check results |
| `GET` | `/summaries/stream` | SSE | Uptime summaries after each sweep |
| `GET` | `/checks` | REST | Query checks (filter: `serverUrl`, `limit`, `since`) |
| `GET` | `/summaries` | REST | Per-server uptime summaries |

### Summary Fields (per server)

- `serverName`, `serverUrl`, `currentStatus`
- `uptimePercent` -- percentage of healthy checks
- `avgResponseTimeMs` -- average response time across all checks
- `checksTotal`, `checksHealthy`
- `lastChecked`, `lastError`
- `recentChecks` -- last ~1 hour of individual check results

### Log Files

- `logs/fhir-health/health-checks.jsonl` -- check history

### Memory Limits

Ring buffer holds 2,880 entries per server (~24 hours at 30-second intervals).

## FHIR Proxy Monitoring

Tracks all proxied FHIR requests with per-request metrics.

### Endpoints -- `/monitoring/fhir-proxy`

| Method | Path | Type | Description |
|--------|------|------|-------------|
| `GET` | `/events/stream` | SSE | Real-time proxied request events |
| `GET` | `/analytics/stream` | SSE | Real-time analytics updates |
| `GET` | `/events` | REST | Query proxied request events |
| `GET` | `/analytics` | REST | Analytics snapshot (throughput, response times, errors) |

### Tracked Fields

Each proxied request logs: server name, HTTP method, resource path, resource type, status code, response time (ms), client ID, and error details (if any).

## Auth Event Monitoring

Polls Keycloak authentication events (login, logout, session expiry, failed attempts) every 60 seconds.

### Endpoints -- `/monitoring/auth`

| Method | Path | Type | Description |
|--------|------|------|-------------|
| `GET` | `/events/stream` | SSE | Real-time auth events |
| `GET` | `/analytics/stream` | SSE | Real-time analytics updates |
| `GET` | `/events` | REST | Query auth events |
| `GET` | `/analytics` | REST | Analytics snapshot |

## Email Event Monitoring

Polls Keycloak email delivery events (verification emails, password resets, account notifications) every 60 seconds.

### Endpoints -- `/monitoring/email`

| Method | Path | Type | Description |
|--------|------|------|-------------|
| `GET` | `/events/stream` | SSE | Real-time email events |
| `GET` | `/analytics/stream` | SSE | Real-time analytics updates |
| `GET` | `/events` | REST | Query email events |
| `GET` | `/analytics` | REST | Analytics snapshot |

## Consent Monitoring

Tracks patient consent decisions during authorization flows.

### Endpoints -- `/monitoring/consent`

| Method | Path | Type | Description |
|--------|------|------|-------------|
| `GET` | `/events/stream` | SSE | Real-time consent decisions |
| `GET` | `/analytics/stream` | SSE | Real-time analytics updates |
| `GET` | `/events` | REST | Query events (filter: `limit`, `decision`, `clientId`, `patientId`, `resourceType`, `since`) |
| `GET` | `/analytics` | REST | Analytics snapshot (last 24h) |
| `GET` | `/events/export` | REST | Download events as JSONL |

### WebSocket Transport

Available at `/consent/monitoring/websocket` with the same message protocol as the OAuth WebSocket.

### Analytics Fields

- `totalDecisions`, `permitRate`, `denyRate`
- `averageCheckDuration`, `cacheHitRate`
- `decisionsByMode` -- enforce, audit-only, disabled
- `decisionsByResourceType` -- e.g., Patient, Observation, MedicationRequest
- `topDeniedClients`, `topDeniedPatients`
- `hourlyStats`

### Event Fields

Each consent event includes:
- `decision` (permit/deny), `enforced`, `mode`
- `consentId`, `patientId`, `clientId`
- `resourceType`, `method`, `reason`
- `cached`, `checkDurationMs`
- IAL fields (Identity Assurance Level): `actualLevel`, `requiredLevel`, `sensitiveResource`

### Log Files

- `logs/consent-metrics/consent-events.jsonl` -- event log
- `logs/consent-metrics/consent-analytics.json` -- latest analytics

## Admin Audit Monitoring

Tracks all admin mutations (create, update, delete actions) with actor identification.

### Automatic Capture

The `adminAuditPlugin` middleware automatically captures all admin route mutations. No manual instrumentation needed -- it hooks into the Elysia request lifecycle.

### Endpoints -- `/monitoring/admin-audit`

| Method | Path | Type | Description |
|--------|------|------|-------------|
| `GET` | `/events/stream` | SSE | Real-time audit events (mutations only) |
| `GET` | `/analytics/stream` | SSE | Real-time analytics updates |
| `GET` | `/events` | REST | Query events (filter: `limit`, `action`, `resource`, `actor`, `success`, `since`) |
| `GET` | `/analytics` | REST | Analytics snapshot |
| `GET` | `/events/export` | REST | Download full audit JSONL (streamed) |

### Event Fields

- **Actor**: `sub`, `username`, `email`
- **Request**: `method`, `path`, `action` (create/update/delete/action/read)
- **Target**: `resource` domain, `resourceId`
- **Result**: `statusCode`, `success`, `durationMs`
- `ipAddress`, `detail`

### Analytics Fields

- `totalActions`, `successRate`
- `actionsByType`, `actionsByResource`
- `topActors` -- most active admin users
- `hourlyStats`
- `recentFailures` -- last failed admin operations

### Log Files

- `logs/admin-audit/admin-audit.jsonl` -- full audit log (replays last 7 days on startup)

## System Status & Health

### `GET /health`

Lightweight liveness probe (30-second TTL cache). Returns:

```json
{
  "status": "ok",
  "uptime": 86400
}
```

### `GET /status`

Full system status check including:

- **FHIR Servers** -- per-server reachability and response time
- **Keycloak** -- connection status, realm accessibility, last connected time
- **Memory** -- heap usage, RSS, external
- **Overall** -- aggregate health status

Keycloak connection events are logged to `logs/keycloak/connections.jsonl` and `logs/keycloak/last-connection.json`.

## SSE Stream Protocol

All SSE streams follow the same pattern:

1. **Connection event** -- sent immediately on connect
   ```
   data: {"type":"connection","message":"Connected to ...","timestamp":"..."}
   ```
2. **Data events** -- sent as they occur
   ```
   data: {"id":"...","type":"...","timestamp":"..."}
   ```
3. **Keepalive** -- every 30 seconds
   ```
   data: {"type":"keepalive","timestamp":"..."}
   ```

Streams automatically clean up when the client disconnects (detected via `controller.desiredSize === null`).

## Log Directory Structure

```
logs/
├── oauth-metrics/
│   ├── oauth-events.jsonl
│   ├── oauth-analytics.json
│   └── system-health.json
├── fhir-health/
│   └── health-checks.jsonl
├── consent-metrics/
│   ├── consent-events.jsonl
│   └── consent-analytics.json
├── admin-audit/
│   └── admin-audit.jsonl
└── keycloak/
    ├── connections.jsonl
    └── last-connection.json
```

All JSONL files use newline-delimited JSON (one object per line) and can be downloaded via the export endpoints.
