#!/usr/bin/env bash
# SPDX-FileCopyrightText: Max Health Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
# beta-keycloak.sh — Keycloak admin steps of deploy-beta-remote.sh, sourced from DEPLOY_DIR.
# Expects REALM, RESEND_API_KEY and .env.beta in the working directory.

# Signs in to the beta Keycloak's master realm as the bootstrap admin and sets KC_BASE and
# KC_TOKEN. Returns 1 when no Keycloak container exists, 2 when one exists but admin sign-in
# fails. The password goes on stdin so it never sits in curl's arguments.
kc_admin_session() {
  KC_TOKEN=''
  KC_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{break}}{{end}}' \
    proxy-smart-keycloak-beta 2>/dev/null || true)
  if [ -z "$KC_IP" ]; then
    echo "  ⚠️ Keycloak container not found — skipping $1"
    return 1
  fi
  KC_BASE="http://${KC_IP}:8080/auth"
  for _ in $(seq 1 20); do
    curl -sf --connect-timeout 5 --max-time 10 "http://${KC_IP}:9000/auth/health/ready" >/dev/null 2>&1 && break
    sleep 3
  done
  KC_TOKEN=$(sed -n 's/^KEYCLOAK_ADMIN_PASSWORD=//p' .env.beta | head -1 | tr -d '\n' \
    | curl -sf -X POST "${KC_BASE}/realms/master/protocol/openid-connect/token" \
        --data-urlencode 'username=admin' --data-urlencode 'password@-' \
        -d 'grant_type=password' -d 'client_id=admin-cli' 2>/dev/null \
    | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4 || true)
  if [ -z "$KC_TOKEN" ]; then
    echo "  ⚠️ Could not get Keycloak admin token — skipping $1"
    return 2
  fi
}

ensure_live_realm_name() {
# KEYCLOAK_REALM is the name the infra realm declaration gives the realm. Import skips a realm
# only when one of that name exists, so after a rename the new image would import a second,
# empty realm beside the live one. The running Keycloak renames it first: the realm keeps its
# id, users, sessions, keys and clients, and Keycloak moves its own console URLs with it.
echo "🏷️ Ensuring the live realm is named ${REALM}..."
kc_admin_session 'the realm name check' && KC_STATE=0 || KC_STATE=$?
case "$KC_STATE" in
  0)
    LIVE_REALMS=$(curl -sf "${KC_BASE}/admin/realms?briefRepresentation=true" -H "Authorization: Bearer $KC_TOKEN" \
      | grep -o '"realm":"[^"]*"' | cut -d'"' -f4 | grep -vx master || true)
    if printf '%s\n' "$LIVE_REALMS" | grep -qx "$REALM"; then
      echo "  ✅ ${REALM} is live"
    elif [ -z "$LIVE_REALMS" ]; then
      echo "  ℹ️ No realm yet — ${REALM} imports fresh"
    elif [ "$(printf '%s\n' "$LIVE_REALMS" | wc -l)" -eq 1 ]; then
      HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "${KC_BASE}/admin/realms/${LIVE_REALMS}" \
        -H "Authorization: Bearer $KC_TOKEN" -H 'Content-Type: application/json' \
        -d "{\"realm\":\"${REALM}\"}")
      if [ "$HTTP_CODE" != '204' ]; then
        echo "  ❌ Renaming ${LIVE_REALMS} to ${REALM} failed (HTTP ${HTTP_CODE}); the new image would import ${REALM} beside it"
        exit 1
      fi
      echo "  ✅ Renamed ${LIVE_REALMS} to ${REALM}"
    else
      echo "  ❌ ${REALM} is not live, and several realms are ($(printf '%s' "$LIVE_REALMS" | tr '\n' ' ')); rename the one it replaces by hand"
      exit 1
    fi
    ;;
  1) ;;
  *)
    echo "  ❌ Keycloak runs but refused the admin sign-in, so ${REALM} cannot be confirmed live before the new image imports"
    exit 1
    ;;
esac
}

reconcile_keycloak() {
# ── 9. SMTP Configuration (optional) ──
if [ -n "${RESEND_API_KEY:-}" ]; then
  echo '📧 Configuring Keycloak SMTP...'
  if kc_admin_session 'SMTP'; then
    EXISTING_HOST=$(curl -sf "${KC_BASE}/admin/realms/${REALM}" \
      -H "Authorization: Bearer $KC_TOKEN" \
      | grep -o '"host":"[^"]*"' | head -1 | cut -d'"' -f4 || true)

    if [ "$EXISTING_HOST" = 'smtp.resend.com' ]; then
      echo '  ✅ SMTP already configured'
    else
      # Body on stdin: as a -d argument the API key would sit in this
      # process's arguments, readable via `ps` while the request runs.
      curl -sf -X PUT "${KC_BASE}/admin/realms/${REALM}" \
        -H 'Content-Type: application/json' \
        -H "Authorization: Bearer $KC_TOKEN" \
        --data @- <<SMTP_JSON
{
  "resetPasswordAllowed": true,
  "smtpServer": {
    "host": "smtp.resend.com",
    "port": "465",
    "from": "noreply@maxhealth.tech",
    "fromDisplayName": "Proxy Smart",
    "replyTo": "noreply@maxhealth.tech",
    "ssl": "true",
    "auth": "true",
    "user": "resend",
    "password": "${RESEND_API_KEY}"
  }
}
SMTP_JSON
      echo '  ✅ SMTP configured (Resend via maxhealth.tech)'
    fi
  fi
else
  echo '⚠️ RESEND_API_KEY not set — skipping SMTP'
fi

# ── 10. Keycloak IDP Reconciliation ──
# realm-export.json uses IGNORE_EXISTING, so IDP settings drift after manual changes.
# This step ensures proxy-smart-signing is always hidden on the login page.
echo '🔧 Reconciling Keycloak IDP settings...'
if kc_admin_session 'IDP reconciliation'; then
  # Hide proxy-smart-signing IDP (used for backend token signing, not user login)
  SIGNING_IDP=$(curl -sf "${KC_BASE}/admin/realms/${REALM}/identity-provider/instances/proxy-smart-signing" \
    -H "Authorization: Bearer $KC_TOKEN")

  if [ -n "$SIGNING_IDP" ]; then
    # Keycloak 26.x uses config.hideOnLoginPage (string "true"), not top-level hideOnLogin
    UPDATED_IDP=$(echo "$SIGNING_IDP" | sed 's/"config":{/"config":{"hideOnLoginPage":"true",/')
    HTTP_CODE=$(curl -sf -o /dev/null -w '%{http_code}' -X PUT \
      "${KC_BASE}/admin/realms/${REALM}/identity-provider/instances/proxy-smart-signing" \
      -H "Authorization: Bearer $KC_TOKEN" \
      -H 'Content-Type: application/json' \
      -d "$UPDATED_IDP")
    if [ "$HTTP_CODE" = '204' ]; then
      echo '  ✅ proxy-smart-signing IDP hidden on login page'
    else
      echo "  ⚠️ Failed to hide proxy-smart-signing (HTTP $HTTP_CODE)"
    fi
  else
    echo '  ℹ️ proxy-smart-signing IDP not found — skipping'
  fi
fi

# ── 10a. Environment Isolation For Brokered Identity ──
# Beta must broker to BETA identity only. A prod IdP registered here means prod
# credentials and prod personal data reach a non-prod environment, and (for the
# signing IdP) that beta would trust assertions signed by the prod proxy key.
#
# Login identity providers are the operator's, declared in Max-Health-Inc/proxy-smart-infra's
# beta realm, and import skips an existing realm. deploy-beta.yml extracts them into
# realm-idps/, and each is applied in place here (PUT keeps users' brokered links; a partial
# import would delete and recreate the provider). production-hosts.txt holds the issuer hosts
# of the production realm's providers, which beta must never reference.
echo '🔒 Verifying brokered identity stays within beta...'
REALM_IDPS="${DEPLOY_DIR}/realm-idps"
FOREIGN_HOSTS=$(cat "${REALM_IDPS}/production-hosts.txt" 2>/dev/null || true)
[ -n "$FOREIGN_HOSTS" ] || echo '  ⚠️ No production hosts from the realm declaration — isolation check has nothing to compare'
if kc_admin_session 'isolation check'; then
  IDP_API="${KC_BASE}/admin/realms/${REALM}/identity-provider/instances"
  for IDP_FILE in "${REALM_IDPS}"/*.json; do
    [ -e "$IDP_FILE" ] || continue
    ALIAS=$(basename "$IDP_FILE" .json)
    if curl -sf -o /dev/null "${IDP_API}/${ALIAS}" -H "Authorization: Bearer $KC_TOKEN"; then
      HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "${IDP_API}/${ALIAS}"           -H "Authorization: Bearer $KC_TOKEN" -H 'Content-Type: application/json'           --data-binary "@${IDP_FILE}")
      [ "$HTTP_CODE" = '204' ]           && echo "  ✅ ${ALIAS} IDP applied from the realm declaration"           || echo "  ⚠️ Failed to apply ${ALIAS} IDP (HTTP $HTTP_CODE)"
    else
      HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${IDP_API}"           -H "Authorization: Bearer $KC_TOKEN" -H 'Content-Type: application/json'           --data-binary "@${IDP_FILE}")
      [ "$HTTP_CODE" = '201' ]           && echo "  ✅ ${ALIAS} IDP created from the realm declaration"           || echo "  ⚠️ ${ALIAS} IDP not created (HTTP $HTTP_CODE)"
    fi
  done

  # Assert: no IdP in this realm may reference a production host. Fatal —
  # cross-environment identity is a data-governance problem, not a warning.
  ALL_IDPS=$(curl -sf "${IDP_API}" -H "Authorization: Bearer $KC_TOKEN" || true)
  if [ -n "$ALL_IDPS" ]; then
    LEAKED=''
    for HOST in $FOREIGN_HOSTS; do
      # -F: treat dots literally, so auth.beta.example.org is not a match
      # for auth.example.org.
      if printf '%s' "$ALL_IDPS" | grep -qF "$HOST"; then
        LEAKED="${LEAKED} ${HOST}"
      fi
    done
    if [ -n "$LEAKED" ]; then
      echo "  ❌ Beta identity providers reference production host(s):${LEAKED}"
      echo '     Beta must broker to beta identity only. Inspect with:'
      echo '       proxy-smart --url https://beta.proxy-smart.com idps list --json'
      exit 1
    fi
    echo '  ✅ No identity provider references a production host'
  else
    echo '  ⚠️ Could not list identity providers — skipping isolation check'
  fi
fi

# ── 10b. Keycloak Resource-Indicator Reconciliation ──
# realm-export.json uses IGNORE_EXISTING, so RFC 8707 resource-indicator wiring
# (resource clients + shared scope + default-scope attachment) does NOT reach an
# existing beta realm via import. This best-effort, non-fatal block reconciles:
#   1. the resource clients fhir-resource-server / mcp-resource-server
#      (each holding a resource_url attribute the post-processor binds into aud)
#   2. the resource-indicators client scope (two oidc-audience-mappers)
#   3. that scope attached as a DEFAULT scope on each beta SMART app client
# All sub-steps are idempotent and parse JSON with grep/cut (no jq dependency).
echo '🔧 Reconciling Keycloak resource indicators...'
RI_FHIR_URL='https://beta.proxy-smart.com/proxy-smart-backend/hapi-fhir-server/R4'
RI_MCP_URL='https://beta.proxy-smart.com/mcp'
if kc_admin_session 'resource-indicator reconciliation'; then
  KC_CLIENTS="${KC_BASE}/admin/realms/${REALM}/clients"
  KC_SCOPES="${KC_BASE}/admin/realms/${REALM}/client-scopes"

  # Step 1: ensure the two resource clients exist with the right resource_url.
  ensure_resource_client() {
    RC_ID="$1"; RC_NAME="$2"; RC_DESC="$3"; RC_URL="$4"
    EXISTING=$(curl -sf "${KC_CLIENTS}?clientId=${RC_ID}" \
      -H "Authorization: Bearer $KC_TOKEN" 2>/dev/null || true)
    RC_UUID=$(echo "$EXISTING" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
    RC_BODY=$(cat <<JSON
{"clientId":"${RC_ID}","name":"${RC_NAME}","description":"${RC_DESC}","enabled":true,"clientAuthenticatorType":"client-secret","protocol":"openid-connect","publicClient":false,"bearerOnly":false,"standardFlowEnabled":false,"implicitFlowEnabled":false,"directAccessGrantsEnabled":false,"serviceAccountsEnabled":false,"authorizationServicesEnabled":false,"fullScopeAllowed":false,"attributes":{"resource_url":"${RC_URL}"}}
JSON
)
    if [ -z "$RC_UUID" ]; then
      HTTP_CODE=$(curl -sf -o /dev/null -w '%{http_code}' -X POST "$KC_CLIENTS" \
        -H "Authorization: Bearer $KC_TOKEN" -H 'Content-Type: application/json' \
        -d "$RC_BODY" 2>/dev/null || true)
      if [ "${HTTP_CODE:-}" = '201' ]; then
        echo "  ✅ Created resource client ${RC_ID}"
      else
        echo "  ⚠️ Failed to create resource client ${RC_ID} (HTTP ${HTTP_CODE:-none})"
      fi
    else
      HTTP_CODE=$(curl -sf -o /dev/null -w '%{http_code}' -X PUT "${KC_CLIENTS}/${RC_UUID}" \
        -H "Authorization: Bearer $KC_TOKEN" -H 'Content-Type: application/json' \
        -d "$RC_BODY" 2>/dev/null || true)
      if [ "${HTTP_CODE:-}" = '204' ]; then
        echo "  ✅ Reconciled resource_url for ${RC_ID}"
      else
        echo "  ⚠️ Failed to reconcile resource client ${RC_ID} (HTTP ${HTTP_CODE:-none})"
      fi
    fi
  }
  ensure_resource_client 'fhir-resource-server' \
    'FHIR Resource Server (RFC 8707 resource indicator)' \
    'Non-login resource client. Holds resource_url = the proxy FHIR base.' \
    "$RI_FHIR_URL"
  ensure_resource_client 'mcp-resource-server' \
    'MCP Resource Server (RFC 8707 resource indicator)' \
    'Non-login resource client. Holds resource_url = the proxy MCP URL.' \
    "$RI_MCP_URL"

  # Step 2: ensure the resource-indicators client scope exists with both
  # oidc-audience-mappers (fhir-resource-server + mcp-resource-server).
  ALL_SCOPES=$(curl -sf "$KC_SCOPES" -H "Authorization: Bearer $KC_TOKEN" 2>/dev/null || true)
  if echo "$ALL_SCOPES" | grep -q '"name":"resource-indicators"'; then
    echo '  ✅ resource-indicators client scope already present'
  else
    SCOPE_BODY='{"name":"resource-indicators","description":"RFC 8707 resource indicators: pre-populates the access-token aud with the resource-client ids.","protocol":"openid-connect","attributes":{"include.in.token.scope":"false","display.on.consent.screen":"false"}}'
    HTTP_CODE=$(curl -sf -o /dev/null -w '%{http_code}' -X POST "$KC_SCOPES" \
      -H "Authorization: Bearer $KC_TOKEN" -H 'Content-Type: application/json' \
      -d "$SCOPE_BODY" 2>/dev/null || true)
    if [ "${HTTP_CODE:-}" = '201' ]; then
      echo '  ✅ Created resource-indicators client scope'
    else
      echo "  ⚠️ Failed to create resource-indicators scope (HTTP ${HTTP_CODE:-none})"
    fi
  fi

  # Resolve the scope id, then ensure both audience mappers exist on it.
  SCOPE_LIST=$(curl -sf "$KC_SCOPES" -H "Authorization: Bearer $KC_TOKEN" 2>/dev/null || true)
  # Isolate the resource-indicators object, then take the id that precedes its name.
  RI_SCOPE_ID=$(echo "$SCOPE_LIST" \
    | grep -o '{"id":"[^"]*","name":"resource-indicators"' \
    | head -1 | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  if [ -n "${RI_SCOPE_ID:-}" ]; then
    EXISTING_MAPPERS=$(curl -sf "${KC_SCOPES}/${RI_SCOPE_ID}/protocol-mappers/models" \
      -H "Authorization: Bearer $KC_TOKEN" 2>/dev/null || true)
    ensure_audience_mapper() {
      MAP_NAME="$1"; MAP_AUD="$2"
      if echo "$EXISTING_MAPPERS" | grep -q "\"name\":\"${MAP_NAME}\""; then
        echo "  ✅ Audience mapper ${MAP_NAME} already present"
        return
      fi
      MAP_BODY=$(cat <<JSON
{"name":"${MAP_NAME}","protocol":"openid-connect","protocolMapper":"oidc-audience-mapper","consentRequired":false,"config":{"included.client.audience":"${MAP_AUD}","id.token.claim":"false","access.token.claim":"true"}}
JSON
)
      HTTP_CODE=$(curl -sf -o /dev/null -w '%{http_code}' -X POST \
        "${KC_SCOPES}/${RI_SCOPE_ID}/protocol-mappers/models" \
        -H "Authorization: Bearer $KC_TOKEN" -H 'Content-Type: application/json' \
        -d "$MAP_BODY" 2>/dev/null || true)
      if [ "${HTTP_CODE:-}" = '201' ]; then
        echo "  ✅ Added audience mapper ${MAP_NAME}"
      else
        echo "  ⚠️ Failed to add audience mapper ${MAP_NAME} (HTTP ${HTTP_CODE:-none})"
      fi
    }
    ensure_audience_mapper 'fhir-resource-audience' 'fhir-resource-server'
    ensure_audience_mapper 'mcp-resource-audience' 'mcp-resource-server'

    # Step 3: attach the scope as a DEFAULT client scope on each SMART app.
    # inferno-test-client is included here (not left to the compliance workflow)
    # because that workflow cannot authenticate to the beta KC admin API, so its
    # own scope-attach never runs; this deploy path has working master-admin auth.
    for SMART_CLIENT in admin-ui mcp-client patient-portal dicom-viewer consent-app dtr-app inferno-test-client; do
      SC_UUID=$(curl -sf "${KC_CLIENTS}?clientId=${SMART_CLIENT}" \
        -H "Authorization: Bearer $KC_TOKEN" 2>/dev/null \
        | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
      if [ -z "${SC_UUID:-}" ]; then
        echo "  ℹ️ SMART client ${SMART_CLIENT} not found — skipping scope attach"
        continue
      fi
      HTTP_CODE=$(curl -sf -o /dev/null -w '%{http_code}' -X PUT \
        "${KC_CLIENTS}/${SC_UUID}/default-client-scopes/${RI_SCOPE_ID}" \
        -H "Authorization: Bearer $KC_TOKEN" 2>/dev/null || true)
      if [ "${HTTP_CODE:-}" = '204' ]; then
        echo "  ✅ Attached resource-indicators default scope to ${SMART_CLIENT}"
      else
        echo "  ⚠️ Could not attach resource-indicators to ${SMART_CLIENT} (HTTP ${HTTP_CODE:-none})"
      fi
    done
  else
    # TODO: operator action — could not resolve the resource-indicators scope id
    # via grep. Run manually once:
    #   GET  /admin/realms/${REALM}/client-scopes  (find the "resource-indicators" id)
    #   POST /admin/realms/${REALM}/client-scopes/{id}/protocol-mappers/models  (both audience mappers)
    #   PUT  /admin/realms/${REALM}/clients/{clientUuid}/default-client-scopes/{id}  (per SMART client)
    echo '  ⚠️ Could not resolve resource-indicators scope id — see TODO in deploy script'
  fi
fi

# ── 10c. Keycloak Device-Grant Reconciliation (admin-ui) ──
# realm-export.json uses IGNORE_EXISTING, so flipping
# oauth2.device.authorization.grant.enabled to "true" on admin-ui in the export
# never reaches an already-imported beta realm. The CLI's interactive login
# (RFC 8628 device flow) uses the admin-ui client, so without this attribute
# Keycloak rejects the device-authorization request with unauthorized_client.
# Best-effort, non-fatal, idempotent: GET admin-ui by clientId, set the
# attribute via grep/sed (no jq on the VPS), PUT the updated representation.
echo '🔧 Reconciling admin-ui device-authorization grant...'
if kc_admin_session 'device-grant reconciliation'; then
  KC_CLIENTS="${KC_BASE}/admin/realms/${REALM}/clients"
  ADMIN_UI=$(curl -sf "${KC_CLIENTS}?clientId=admin-ui" \
    -H "Authorization: Bearer $KC_TOKEN" 2>/dev/null || true)
  # The list endpoint returns a JSON array; strip the surrounding [ ] to get the object.
  ADMIN_UI=$(echo "$ADMIN_UI" | sed 's/^\[//; s/\]$//')
  AU_UUID=$(echo "$ADMIN_UI" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)

  if [ -z "${AU_UUID:-}" ]; then
    echo '  ℹ️ admin-ui client not found — skipping device-grant reconciliation'
  elif echo "$ADMIN_UI" | grep -q '"oauth2.device.authorization.grant.enabled":"true"'; then
    echo '  ✅ admin-ui device-authorization grant already enabled'
  else
    # Flip an existing "false" value, or inject the attribute if absent.
    if echo "$ADMIN_UI" | grep -q '"oauth2.device.authorization.grant.enabled":"false"'; then
      UPDATED_AU=$(echo "$ADMIN_UI" \
        | sed 's/"oauth2.device.authorization.grant.enabled":"false"/"oauth2.device.authorization.grant.enabled":"true"/')
    else
      UPDATED_AU=$(echo "$ADMIN_UI" \
        | sed 's/"attributes":{/"attributes":{"oauth2.device.authorization.grant.enabled":"true",/')
    fi
    HTTP_CODE=$(curl -sf -o /dev/null -w '%{http_code}' -X PUT "${KC_CLIENTS}/${AU_UUID}" \
      -H "Authorization: Bearer $KC_TOKEN" -H 'Content-Type: application/json' \
      -d "$UPDATED_AU" 2>/dev/null || true)
    if [ "${HTTP_CODE:-}" = '204' ]; then
      echo '  ✅ admin-ui device-authorization grant enabled'
    else
      echo "  ⚠️ Failed to enable admin-ui device grant (HTTP ${HTTP_CODE:-none})"
    fi
  fi
fi

# ── 10d. Keycloak Default-Role Composite Reconciliation ──
# The realm's default role (`default-roles-<realm>`) is what EVERY user gets
# on creation — including brokered users on first sign-in. It must grant
# `offline_access` and `user`.
#
# Keycloak's RealmManager creates the default role via
# RepresentationToModel.createRole(), which does NOT wire composites; those come
# from the separate pass over `roles.realm[]`. Realms first imported from an
# export that declared the role only under `realm.defaultRole` therefore have an
# EMPTY default role, and --import-realm is a no-op once the realm exists, so
# fixing the export cannot repair them.
#
# The symptom is remote from the cause: login succeeds, the consent screen is
# granted, and THEN the code exchange fails with
#   "Offline tokens not allowed for the user or client"
# because Keycloak gates the `offline_access` scope on the user holding the
# `offline_access` REALM ROLE. Clients report it as an authorization failure
# against an otherwise healthy server.
#
# Idempotent and non-fatal, like the blocks above.
echo '🔧 Reconciling Keycloak default-role composite...'
if kc_admin_session 'default-role reconciliation'; then
  KC_ROLES="${KC_BASE}/admin/realms/${REALM}/roles"

  # The realm names its default role, which keeps its first name when the realm is renamed.
  DEFAULT_ROLE_REF=$(curl -sf "${KC_BASE}/admin/realms/${REALM}" -H "Authorization: Bearer $KC_TOKEN" 2>/dev/null \
    | grep -o '"defaultRole":{"id":"[^"]*","name":"[^"]*"' || true)
  DR_ID=$(printf '%s' "$DEFAULT_ROLE_REF" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 || true)
  DEFAULT_ROLE=$(printf '%s' "$DEFAULT_ROLE_REF" | grep -o '"name":"[^"]*"' | cut -d'"' -f4 || true)
  DEFAULT_ROLE="${DEFAULT_ROLE:-the default role}"

  if [ -z "${DR_ID:-}" ]; then
    echo "  ⚠️ ${DEFAULT_ROLE} not found — skipping"
  else
    EXISTING=$(curl -sf "${KC_ROLES}-by-id/${DR_ID}/composites" \
      -H "Authorization: Bearer $KC_TOKEN" 2>/dev/null || true)

    ensure_default_child() {
      CHILD="$1"
      if printf '%s' "$EXISTING" | grep -q "\"name\":\"${CHILD}\""; then
        echo "  ✅ default role already grants ${CHILD}"
        return
      fi
      CHILD_ID=$(curl -sf "${KC_ROLES}/${CHILD}" -H "Authorization: Bearer $KC_TOKEN" 2>/dev/null \
        | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
      if [ -z "${CHILD_ID:-}" ]; then
        echo "  ⚠️ realm role ${CHILD} not found — cannot add to default role"
        return
      fi
      HTTP_CODE=$(curl -sf -o /dev/null -w '%{http_code}' -X POST \
        "${KC_ROLES}-by-id/${DR_ID}/composites" \
        -H "Authorization: Bearer $KC_TOKEN" -H 'Content-Type: application/json' \
        -d "[{\"id\":\"${CHILD_ID}\",\"name\":\"${CHILD}\"}]" 2>/dev/null || true)
      if [ "${HTTP_CODE:-}" = '204' ]; then
        echo "  ✅ Added ${CHILD} to the default role composite"
      else
        echo "  ⚠️ Failed to add ${CHILD} to default role (HTTP ${HTTP_CODE:-none})"
      fi
    }
    ensure_default_child 'offline_access'
    ensure_default_child 'user'
  fi
fi
}
