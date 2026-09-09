// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Inferno SMART App Launch STU2.2 Compliance Test Runner
 * 
 * Runs the following test groups from the Inferno smart_stu2_2 suite:
 *   1. Standalone Launch — Discovery + OAuth + OpenID Connect + Token Refresh
 *   2. Token Introspection — Validates introspection of tokens from Standalone Launch
 *   3. Backend Services — Validates client_credentials grant with asymmetric JWT (RS384)
 *   4. EHR Launch — Validates EHR-initiated launch with patient context
 * 
 * OAuth flow is handled via Playwright (headless Chromium) to automate Keycloak login.
 * Backend Services uses machine-to-machine auth (no browser needed).
 */

const { chromium } = require('playwright');

const INFERNO_URL = process.env.INFERNO_URL || 'http://localhost:4567';
const FHIR_SERVER_URL = process.env.FHIR_SERVER_URL || 'http://localhost:8445/proxy-smart-backend/hapi-fhir-server/R4';
const TEST_SUITE = process.env.TEST_SUITE || 'smart_stu2_2';

// Test user credentials (for OAuth login page)
const KC_USERNAME = process.env.KC_USERNAME || 'testuser';
const KC_PASSWORD = process.env.KC_PASSWORD || 'testpass';

// Inferno client configuration
const CLIENT_ID = process.env.CLIENT_ID || 'inferno-test-client';
const BACKEND_SERVICES_CLIENT_ID = process.env.BACKEND_SERVICES_CLIENT_ID || 'inferno-backend-services';

// The proxy's own origin, for /auth/token and /auth/launch. Derived from the FHIR
// URL rather than configured separately so the two can never point at different
// deployments.
const PROXY_BASE_URL = process.env.PROXY_BASE_URL || new URL(FHIR_SERVER_URL).origin;

// Patient the simulated EHR puts in the launch context (seeded by the workflow).
const EHR_LAUNCH_PATIENT = process.env.EHR_LAUNCH_PATIENT || 'test-patient';

// Inferno test group IDs for SMART STU2.2 suite
const GROUP_IDS = {
  STANDALONE_LAUNCH: `${TEST_SUITE}-smart_full_standalone_launch`,
  EHR_LAUNCH: `${TEST_SUITE}-smart_full_ehr_launch`,
  BACKEND_SERVICES: `${TEST_SUITE}-smart_backend_services`,
  TOKEN_INTROSPECTION: `${TEST_SUITE}-smart_token_introspection_stu2_2`,
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForInferno() {
  console.log('Checking Inferno availability...');
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`${INFERNO_URL}/api/test_suites`);
      if (response.ok) {
        console.log('✓ Inferno is ready');
        return true;
      }
    } catch (e) {
      // Inferno not ready yet
    }
    await sleep(2000);
  }
  throw new Error('Inferno failed to start');
}

async function createTestSession() {
  console.log(`Creating test session for suite: ${TEST_SUITE}`);
  
  const response = await fetch(`${INFERNO_URL}/api/test_sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      test_suite_id: TEST_SUITE,
      suite_options: {}
    })
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create test session: ${response.status} - ${text}`);
  }
  
  const session = await response.json();
  console.log(`✓ Created test session: ${session.id}`);
  return session;
}

async function getTestGroups(suiteId) {
  const response = await fetch(`${INFERNO_URL}/api/test_suites/${suiteId}`);
  if (!response.ok) {
    throw new Error(`Failed to get test suite: ${response.status}`);
  }
  const suite = await response.json();
  return suite.test_groups || [];
}

async function runTestGroup(sessionId, groupId, inputs) {
  console.log(`Starting test group: ${groupId}`);
  
  // Note: The Inferno API endpoint is /api/test_runs, not /api/test_sessions/{id}/test_runs
  const response = await fetch(`${INFERNO_URL}/api/test_runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      test_session_id: sessionId,
      test_group_id: groupId,
      inputs: inputs
    })
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to start test run: ${response.status} - ${text}`);
  }
  
  const run = await response.json();
  console.log(`✓ Started test run: ${run.id}`);
  return run;
}

async function waitForTestResult(sessionId, runId, browser, page) {
  console.log(`Waiting for test run ${runId} to complete...`);
  
  const maxWait = 120000; // 2 minutes
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWait) {
    // The correct API endpoint is /api/test_runs/:id?include_results=true
    const response = await fetch(`${INFERNO_URL}/api/test_runs/${runId}?include_results=true`);
    if (!response.ok) {
      throw new Error(`Failed to get test run status: ${response.status}`);
    }
    
    const run = await response.json();
    
    // Check if test is waiting for user action (OAuth)
    if (run.status === 'waiting') {
      console.log('Test is waiting for OAuth - checking for redirect...');
      
      // Check if there's a wait result with a redirect URL
      const results = run.results || [];
      for (const result of results) {
        if (result.result === 'wait' && result.requests) {
          for (const req of result.requests) {
            if (req.direction === 'outgoing' && req.url && req.url.includes('authorize')) {
              console.log(`Found OAuth redirect: ${req.url}`);
              await handleOAuthFlow(page, req.url);
            }
          }
        }
      }
    }
    
    if (run.status === 'done' || run.status === 'error' || run.status === 'cancelled') {
      console.log(`Test run completed with status: ${run.status}`);
      return run;
    }
    
    await sleep(2000);
  }
  
  throw new Error('Test run timed out');
}

/**
 * Handle intermediate Keycloak pages that may appear between login and redirect.
 * These include: "Update Account Information", OAuth consent grant, patient-picker, error pages.
 */
async function handleKeycloakInterstitials(page) {
  const maxAttempts = 5;
  const infernoHost = new URL(INFERNO_URL).host;

  for (let i = 0; i < maxAttempts; i++) {
    const currentUrl = page.url();

    // Already redirected to Inferno — done
    if (currentUrl.includes(infernoHost)) {
      return;
    }

    // Handle Patient Picker page
    if (currentUrl.includes('/apps/patient-picker') || currentUrl.includes('/patient-picker')) {
      console.log('  Detected Patient Picker page — selecting a patient...');
      await handlePatientPicker(page);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      continue; // Re-check for more interstitials or final redirect
    }

    // Not on a Keycloak page — nothing to handle
    if (!currentUrl.includes('/auth/') && !currentUrl.includes('/realms/')) {
      return;
    }

    const pageContent = await page.content();

    // Handle "Update Account Information" required action
    const hasUpdateProfile = pageContent.includes('Update Account Information') ||
                              pageContent.includes('update-profile') ||
                              pageContent.includes('required-action');
    if (hasUpdateProfile) {
      console.log('  Detected "Update Account Information" page — submitting...');
      // Fill any empty required fields
      const emailField = page.locator('#email, input[name="email"]');
      if (await emailField.count() > 0 && !(await emailField.inputValue())) {
        await emailField.fill(`${KC_USERNAME}@test.proxy-smart.com`);
        console.log('  Filled email field');
      }
      const firstNameField = page.locator('#firstName, input[name="firstName"]');
      if (await firstNameField.count() > 0 && !(await firstNameField.inputValue())) {
        await firstNameField.fill('Test');
        console.log('  Filled firstName field');
      }
      const lastNameField = page.locator('#lastName, input[name="lastName"]');
      if (await lastNameField.count() > 0 && !(await lastNameField.inputValue())) {
        await lastNameField.fill('User');
        console.log('  Filled lastName field');
      }
      // Submit the form
      const submitBtn = page.locator('button[type="submit"], input[type="submit"], #kc-update-profile-form button');
      if (await submitBtn.count() > 0) {
        await submitBtn.first().click();
        console.log('  Clicked submit on Update Account Information');
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        continue; // Re-check for more interstitials
      }
    }

    // Handle OAuth consent grant screen
    const hasConsentPage = pageContent.includes('oauth-grant') ||
                            pageContent.includes('Grant Access') ||
                            pageContent.includes('grant access to') ||
                            pageContent.includes('kc-oauth-grant');
    if (hasConsentPage) {
      console.log('  Detected OAuth consent page — approving...');
      const yesBtn = page.locator('button:has-text("Yes"), input[name="accept"], #kc-login');
      if (await yesBtn.count() > 0) {
        await yesBtn.first().click();
        console.log('  Clicked "Yes" on consent page');
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        continue;
      }
    }

    // Handle Keycloak error page (wrong credentials, account disabled, etc.)
    const hasError = pageContent.includes('kc-feedback-text') ||
                      pageContent.includes('alert-error') ||
                      pageContent.includes('Invalid username or password') ||
                      pageContent.includes('Account is disabled');
    if (hasError) {
      const errorText = await page.locator('.kc-feedback-text, .alert-error, #input-error').first().textContent().catch(() => 'unknown');
      console.error(`  Keycloak error detected: ${errorText.trim()}`);
      throw new Error(`Keycloak login failed: ${errorText.trim()}`);
    }

    // No recognized interstitial — log and break
    console.log(`  Post-login page not recognized (attempt ${i + 1}/${maxAttempts})`);
    console.log(`  URL: ${currentUrl}`);
    console.log(`  Page content (first 500 chars): ${pageContent.substring(0, 500)}`);
    break;
  }
}

/**
 * Handle the Patient Picker page during the OAuth flow.
 * The patient-picker is a React SPA that displays a list of patients.
 * We need to select one and click "Continue" to complete the flow.
 */
async function handlePatientPicker(page) {
  // Wait for the patient list to render (React hydration)
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  // Give React a moment to render patient cards
  await sleep(2000);

  const patientRows = page.locator('[data-testid="patient-row"]');
  await patientRows.first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

  if (await patientRows.count() === 0) {
    console.error('  No patient rows found on page');
    const content = await page.content();
    console.error(`  Page content (first 500 chars): ${content.substring(0, 500)}`);
    throw new Error('Patient Picker: no patient rows found');
  }

  await patientRows.first().click();
  console.log('  Clicked first patient row');

  const continueBtn = page.locator('[data-testid="patient-picker-submit"]');
  await continueBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

  if (await continueBtn.count() === 0) {
    console.error('  No patient submit button found after selection');
    throw new Error('Patient Picker: no submit button found');
  }

  await continueBtn.click();
  console.log('  Clicked patient picker submit button');

  // Wait for the form submission and redirect
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  console.log(`  Post patient-picker URL: ${page.url()}`);
}

/**
 * Open the password disclosure on the proxy-smart login page.
 *
 * The theme leads with the identity providers and keeps username/password in a
 * closed <details> (see keycloak/themes/proxy-smart/login/login.ftl), so the
 * fields exist in the DOM with no box. Playwright waits for visibility, and a
 * closed disclosure is not something it opens on its own.
 *
 * A no-op on any other theme, and on a page the theme already renders open —
 * a failed attempt, or a realm with no provider to choose instead.
 */
async function openPasswordDisclosure(page) {
  const summary = await page.$('summary.ps-password-summary');
  if (!summary) return;

  const alreadyOpen = await page.$eval(
    'details.ps-password-disclosure',
    (el) => el.open,
  ).catch(() => false);
  if (alreadyOpen) return;

  await summary.click();
  console.log('  Opened the password disclosure');
}

/**
 * Regression guard for the Keycloak login THEME.
 *
 * WHY: functional login tests only fill the form, so they stay green even when
 * the themed login page is visually broken. We previously shipped a bug where
 * the Geist font @font-face URLs 404'd (the pinned geist@1.4.0 CDN path did not
 * exist) and CI never noticed. This helper makes those regressions fail the run
 * by asserting deterministically (no pixel/screenshot snapshots — those are flaky):
 *   (a) no Keycloak login-theme static asset returned a 4xx, and
 *   (b) the Geist fonts actually loaded according to the browser font registry.
 */
async function assertLoginThemeHealthy(page) {
  // (a) No 4xx theme assets (woff2/css under /resources/ or our proxy-smart theme).
  const failures = page.__themeAssetFailures || [];
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`  Theme asset failed: ${failure.url} (HTTP ${failure.status})`);
    }
    throw new Error('Login theme asset(s) failed to load: ' + JSON.stringify(failures));
  }

  // (b) Geist actually loaded — both Sans (title/labels) and Mono are used by the page.
  await page.evaluate(() => document.fonts.ready);
  const fontStatus = await page.evaluate(() => ({
    sans: document.fonts.check('300 16px "Geist Sans"'),
    mono: document.fonts.check('400 16px "Geist Mono"'),
    faces: [...document.fonts].map(f => f.family + ':' + f.status),
  }));
  if (!fontStatus.sans || !fontStatus.mono) {
    throw new Error(
      `Geist font failed to load on login page (sans=${fontStatus.sans} mono=${fontStatus.mono}); ` +
      `faces=${JSON.stringify(fontStatus.faces)}`
    );
  }

  console.log(`  ✓ Login theme healthy: Geist Sans + Mono loaded, no 4xx theme assets`);
}

async function handleOAuthFlow(page, authorizeUrl) {
  console.log('Handling OAuth flow...');
  console.log(`  Navigating to: ${authorizeUrl}`);

  // Capture failed Keycloak login-theme static assets (4xx) so we can fail the
  // run if the themed login page is broken. Attach once per page to avoid
  // duplicate listeners across repeated calls/interstitials.
  if (!page.__themeCheckAttached) {
    page.__themeCheckAttached = true;
    page.__themeAssetFailures = [];
    page.on('response', (response) => {
      const status = response.status();
      if (status < 400) return;
      const url = response.url();
      const isThemeAsset =
        (url.includes('/resources/') && (url.endsWith('.woff2') || url.endsWith('.css'))) ||
        url.includes('login/proxy-smart');
      if (isThemeAsset) {
        page.__themeAssetFailures.push({ url, status });
      }
    });
  }

  try {
    // Navigate to the authorize URL
    const response = await page.goto(authorizeUrl, { waitUntil: 'networkidle', timeout: 30000 });
    const httpStatus = response?.status();
    console.log(`  Navigation response status: ${httpStatus}`);
    
    // Check for error responses (503 = service unavailable, 400 = bad request)
    if (httpStatus >= 400) {
      const pageContent = await page.content();
      const isKeycloakError = pageContent.includes('Invalid redirect_uri') || 
                               pageContent.includes('Client not found') ||
                               pageContent.includes('Invalid parameter');
      if (isKeycloakError) {
        console.error(`  Keycloak returned ${httpStatus} — likely invalid redirect_uri or missing client`);
        console.error(`  Page content (first 500 chars): ${pageContent.substring(0, 500)}`);
      } else {
        console.error(`  Server returned ${httpStatus} error`);
      }
      throw new Error(`OAuth endpoint returned HTTP ${httpStatus}`);
    }
    
    // Check if we're on Keycloak login page
    const currentUrl = page.url();
    console.log(`  Current URL after navigation: ${currentUrl}`);
    
    if (currentUrl.includes('keycloak') || currentUrl.includes('/auth/') || currentUrl.includes('/realms/')) {
      console.log('  On Keycloak login page, entering credentials...');
      
      // The proxy-smart theme leads with the identity providers and keeps the
      // credentials form in a closed <details>, so the fields have no box until
      // it is opened and waitForSelector would time out on a hidden #username.
      await openPasswordDisclosure(page);

      // Wait for and fill username
      await page.waitForSelector('#username, input[name="username"]', { timeout: 10000 });

      // The login page is rendered and settled (goto used networkidle) — verify the
      // themed login assets actually loaded. Run once per page so retries don't repeat it.
      if (!page.__themeChecked) {
        page.__themeChecked = true;
        await assertLoginThemeHealthy(page);
      }

      await page.fill('#username, input[name="username"]', KC_USERNAME);
      console.log('  Filled username');
      
      // Fill password
      await page.fill('#password, input[name="password"]', KC_PASSWORD);
      console.log('  Filled password');
      
      // Click login button
      await page.click('#kc-login, button[type="submit"], input[type="submit"]');
      console.log('  Clicked login button');

      // Wait for navigation after login (could be Inferno redirect OR an intermediate page)
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      const infernoHost = new URL(INFERNO_URL).host;
      const postLoginUrl = page.url();
      console.log(`  Post-login URL: ${postLoginUrl}`);

      // Handle intermediate pages (patient-picker, consent, etc.) before expecting Inferno redirect
      await handleKeycloakInterstitials(page);

      // Now wait for redirect back to Inferno
      if (!page.url().includes(infernoHost)) {
        await page.waitForURL(url => url.toString().includes(infernoHost), { timeout: 30000 });
      }
      console.log('  ✓ OAuth flow completed, redirected back to Inferno');
    } else if (currentUrl.includes('/apps/patient-picker') || currentUrl.includes('/patient-picker')) {
      // Already logged in via SSO, landed directly on patient-picker
      console.log('  On Patient Picker page (SSO session active), selecting patient...');
      await handlePatientPicker(page);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      
      // After patient selection, wait for redirect to Inferno
      const infernoHost = new URL(INFERNO_URL).host;
      if (!page.url().includes(infernoHost)) {
        await page.waitForURL(url => url.toString().includes(infernoHost), { timeout: 30000 });
      }
      console.log('  ✓ OAuth flow completed via patient-picker, redirected back to Inferno');
    } else {
      console.log(`  Not on Keycloak login page. Page title: ${await page.title()}`);
    }
  } catch (error) {
    console.error(`  OAuth flow error: ${error.message}`);
    // Log page content for debugging
    try {
      const pageContent = await page.content();
      const title = await page.title();
      console.error(`  Page title: ${title}`);
      console.error(`  Page URL: ${page.url()}`);
      console.error(`  Page content (first 1000 chars): ${pageContent.substring(0, 1000)}`);
    } catch (_) {}
    // Take screenshot for debugging
    try {
      await page.screenshot({ path: '/tmp/oauth-error.png' });
      console.log('  Screenshot saved to /tmp/oauth-error.png');
    } catch (screenshotError) {
      console.log('  Could not save screenshot');
    }
    throw error;
  }
}

/**
 * Build the standalone_smart_auth_info JSON input for Inferno.
 * This AuthInfo object tells Inferno how to perform the SMART Standalone Launch.
 */
function buildStandaloneSmartAuthInfo() {
  return JSON.stringify({
    auth_type: 'public',
    use_discovery: 'true',
    client_id: CLIENT_ID,
    requested_scopes: 'launch/patient openid fhirUser offline_access patient/*.read',
    pkce_support: 'enabled',
    pkce_code_challenge_method: 'S256',
    auth_request_method: 'GET'
  });
}

/**
 * Build the ehr_launch_smart_auth_info JSON input for Inferno.
 * EHR Launch uses the `launch` scope (not `launch/patient`) — patient context
 * comes from the EHR-provided launch context, mapped via Keycloak user attributes.
 */
function buildEhrLaunchSmartAuthInfo() {
  return JSON.stringify({
    auth_type: 'public',
    use_discovery: 'true',
    client_id: CLIENT_ID,
    requested_scopes: 'launch openid fhirUser patient/*.read',
    pkce_support: 'enabled',
    pkce_code_challenge_method: 'S256',
    auth_request_method: 'GET'
  });
}

/**
 * Run the Standalone Launch test group.
 * This is the primary SMART compliance group covering:
 *   - SMART Discovery (.well-known/smart-configuration)
 *   - Standalone Launch (OAuth2 + PKCE)
 *   - OpenID Connect (id_token, fhirUser claim)
 *   - Token Refresh (with and without scopes)
 */
async function runStandaloneLaunchTests(sessionId, browser) {
  console.log('\n=== Running Standalone Launch Tests ===\n');
  
  const standaloneAuthInfo = buildStandaloneSmartAuthInfo();
  console.log('Auth info:', standaloneAuthInfo);
  
  const inputs = [
    { name: 'url', value: FHIR_SERVER_URL },
    { name: 'standalone_smart_auth_info', value: standaloneAuthInfo }
  ];
  
  try {
    const groups = await getTestGroups(TEST_SUITE);
    
    // List all available test groups
    console.log('Available test groups in suite:');
    groups.forEach(g => console.log(`  - ${g.id}: ${g.title || 'No title'}`));
    console.log('');
    
    // Find the Standalone Launch group by known ID
    const standaloneGroup = groups.find(g => g.id === GROUP_IDS.STANDALONE_LAUNCH);
    
    if (!standaloneGroup) {
      // Fallback: try to match by title or run the first group
      const fallbackGroup = groups.find(g => 
        (g.title || '').toLowerCase().includes('standalone')
      ) || groups[0];
      
      if (fallbackGroup) {
        console.log(`Standalone group not found by ID, using fallback: ${fallbackGroup.id}`);
        const run = await runTestGroup(sessionId, fallbackGroup.id, inputs);
        return await waitForSimpleTestCompletion(sessionId, run.id, browser);
      }
      console.log('ERROR: No test groups available');
      return null;
    }
    
    console.log(`Running test group: ${standaloneGroup.id} — ${standaloneGroup.title}`);
    
    const run = await runTestGroup(sessionId, standaloneGroup.id, inputs);
    return await waitForSimpleTestCompletion(sessionId, run.id, browser);
    
  } catch (error) {
    return groupFailure('Standalone Launch', error);
  }
}

/**
 * Run the Token Introspection test group.
 * Uses tokens obtained during Standalone Launch (from the same session).
 * Requires introspection_endpoint in SMART configuration.
 */
async function runTokenIntrospectionTests(sessionId, browser) {
  console.log('\n=== Running Token Introspection Tests ===\n');
  
  try {
    const groups = await getTestGroups(TEST_SUITE);
    const introspectionGroup = groups.find(g => g.id === GROUP_IDS.TOKEN_INTROSPECTION);
    
    if (!introspectionGroup) {
      console.log('Token Introspection group not found, skipping...');
      return null;
    }
    
    console.log(`Running test group: ${introspectionGroup.id} — ${introspectionGroup.title}`);
    
    // Token Introspection requires standalone_smart_auth_info as input
    // (same as Standalone Launch — it uses it to configure the introspection client)
    const standaloneAuthInfo = buildStandaloneSmartAuthInfo();
    const inputs = [
      { name: 'url', value: FHIR_SERVER_URL },
      { name: 'standalone_smart_auth_info', value: standaloneAuthInfo }
    ];
    
    const run = await runTestGroup(sessionId, introspectionGroup.id, inputs);
    return await waitForSimpleTestCompletion(sessionId, run.id, browser);
    
  } catch (error) {
    return groupFailure('Token Introspection', error);
  }
}

/**
 * Build the backend_services_smart_auth_info JSON input for Inferno.
 * Backend Services uses client_credentials grant with asymmetric JWT (RS384).
 * The private JWKS is read from BACKEND_SERVICES_JWKS env var or a fixture file.
 */
function buildBackendServicesSmartAuthInfo() {
  let privateJwksJson = process.env.BACKEND_SERVICES_JWKS;
  if (!privateJwksJson) {
    // Try reading from the fixture file shipped in the repo
    // Check each test stage directory (alpha, dev, etc.)
    const fs = require('fs');
    const path = require('path');
    const testStage = process.env.TEST_STAGE || 'dev';
    const jwksFilename = 'backend-services-private-jwks.json';
    const candidates = [
      // Stage-specific path first (e.g. testing/alpha/)
      path.resolve(__dirname, `../../testing/${testStage}/${jwksFilename}`),
      // Fallback to dev
      path.resolve(__dirname, `../../testing/dev/${jwksFilename}`),
      // CWD-relative
      path.resolve(process.cwd(), `testing/${testStage}/${jwksFilename}`),
      path.resolve(process.cwd(), `testing/dev/${jwksFilename}`),
      // CI copies the script to /tmp/playwright-setup, so try GITHUB_WORKSPACE
      process.env.GITHUB_WORKSPACE
        ? path.resolve(process.env.GITHUB_WORKSPACE, `testing/${testStage}/${jwksFilename}`)
        : null,
      process.env.GITHUB_WORKSPACE
        ? path.resolve(process.env.GITHUB_WORKSPACE, `testing/dev/${jwksFilename}`)
        : null
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        privateJwksJson = fs.readFileSync(candidate, 'utf-8');
        console.log(`  Loaded private JWKS from ${candidate}`);
        break;
      }
    }
  }

  if (!privateJwksJson) {
    throw new Error('Backend Services private JWKS not found. Set BACKEND_SERVICES_JWKS env var or place testing/<stage>/backend-services-private-jwks.json');
  }

  return JSON.stringify({
    auth_type: 'backend_services',
    use_discovery: 'true',
    client_id: BACKEND_SERVICES_CLIENT_ID,
    requested_scopes: 'system/*.read',
    encryption_algorithm: 'RS384',
    jwks: privateJwksJson.trim()
  });
}

/**
 * Mint a signed launch code, the way a real EHR does before handing off to an app.
 *
 * POST /auth/launch needs a Bearer token, so this first takes one via the password
 * grant — the same grant the workflow already uses to smoke-test /auth/token.
 *
 * Returns null (never throws) if either call fails: an EHR launch without patient
 * context still exercises the handshake, and the reason is logged rather than
 * taking the whole group down.
 */
async function mintEhrLaunchCode() {
  try {
    // /auth/launch validates the token against the default audience set, whose FHIR
    // prefix matcher only accepts a token carrying the FHIR base in `aud`. Ask for it
    // via the RFC 8707 `resource` indicator; if this realm/client is not wired for
    // resource indicators the request comes back invalid_target, so fall back to a
    // plain token rather than losing the handshake over it.
    const requestToken = (withResource) => fetch(`${PROXY_BASE_URL}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: CLIENT_ID,
        username: KC_USERNAME,
        password: KC_PASSWORD,
        scope: 'openid',
        ...(withResource ? { resource: FHIR_SERVER_URL } : {}),
      }).toString(),
    });

    let tokenResp = await requestToken(true);
    if (!tokenResp.ok) {
      console.log(`  Token request with resource indicator failed (HTTP ${tokenResp.status}), retrying without`);
      tokenResp = await requestToken(false);
    }

    if (!tokenResp.ok) {
      console.log(`  Could not get a token for /auth/launch: HTTP ${tokenResp.status} ${(await tokenResp.text()).substring(0, 200)}`);
      return null;
    }

    const { access_token: accessToken } = await tokenResp.json();
    if (!accessToken) {
      console.log('  Token response carried no access_token');
      return null;
    }

    const launchResp = await fetch(`${PROXY_BASE_URL}/auth/launch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ patient: EHR_LAUNCH_PATIENT, clientId: CLIENT_ID }),
    });

    if (!launchResp.ok) {
      console.log(`  POST /auth/launch failed: HTTP ${launchResp.status} ${(await launchResp.text()).substring(0, 200)}`);
      return null;
    }

    const { launch } = await launchResp.json();
    if (!launch) {
      console.log('  /auth/launch returned no launch code');
      return null;
    }

    console.log(`  Minted launch code for Patient/${EHR_LAUNCH_PATIENT} (${launch.length} chars)`);
    return launch;
  } catch (error) {
    console.log(`  Could not mint a launch code: ${error.message}`);
    return null;
  }
}

/**
 * Build the URL the EHR sends the browser to, handing the app its launch context.
 *
 * Inferno IS the app here, and its wait message states the contract: it resumes
 * when it receives a launch request at this path carrying an `iss` naming the FHIR
 * server. `launch` is the EHR's opaque handle, which the app echoes back to
 * /authorize — so supplying our own signed code is what gets patient context into
 * the token (see signLaunchCode in @proxy-smart/auth).
 */
function buildInfernoLaunchUrl(launchCode) {
  const url = new URL(`${INFERNO_URL}/custom/${TEST_SUITE}/launch`);
  url.searchParams.set('iss', FHIR_SERVER_URL);
  if (launchCode) url.searchParams.set('launch', launchCode);
  return url.toString();
}

/**
 * Run the EHR Launch test group.
 * EHR Launch differs from Standalone: the EHR initiates. We mint a launch code and
 * send the browser to Inferno's launch URL with `iss` and `launch`; Inferno then
 * redirects to our /authorize → Keycloak → login → callback.
 */
async function runEhrLaunchTests(sessionId, browser) {
  console.log('\n=== Running EHR Launch Tests ===\n');

  try {
    const groups = await getTestGroups(TEST_SUITE);
    const ehrGroup = groups.find(g => g.id === GROUP_IDS.EHR_LAUNCH);

    if (!ehrGroup) {
      console.log('EHR Launch group not found, skipping...');
      return null;
    }

    console.log(`Running test group: ${ehrGroup.id} — ${ehrGroup.title}`);

    const ehrAuthInfo = buildEhrLaunchSmartAuthInfo();
    console.log('Auth info:', ehrAuthInfo);

    const inputs = [
      { name: 'url', value: FHIR_SERVER_URL },
      { name: 'ehr_smart_auth_info', value: ehrAuthInfo }
    ];

    const run = await runTestGroup(sessionId, ehrGroup.id, inputs);
    return await waitForEhrLaunchCompletion(sessionId, run.id, browser);

  } catch (error) {
    return groupFailure('EHR Launch', error);
  }
}

/**
 * Find the authorization URL a waiting test is blocked on.
 *
 * Prefers a recorded outgoing request (an exact URL) over one parsed out of the
 * wait message's prose, which is how the EHR launch URL lost its query string.
 * Returns null if nothing looks like an authorize URL yet.
 */
function findAuthorizeUrl(results) {
  for (const result of results || []) {
    if (result.result !== 'wait') continue;

    for (const req of result.requests || []) {
      if (req.direction === 'outgoing' && req.url && req.url.includes('authorize')) {
        return req.url;
      }
    }

    for (const field of ['wait_message', 'result_message', 'messages']) {
      if (!result[field]) continue;
      const content = typeof result[field] === 'string' ? result[field] : JSON.stringify(result[field]);
      const match = content.match(/https?:\/\/[^\s<>"')]+?authorize[^\s<>"')]*/);
      if (match) return match[0].replace(/[.,;:!?]+$/, '');
    }
  }
  return null;
}

/**
 * Wait for EHR Launch test completion.
 *
 * Two phases, and the loop used to serve only the first: the EHR hands the app its
 * launch context, and THEN the app performs the authorization redirect the user has
 * to complete. Once `launchAttempted` was set nothing acted again, so the run sat in
 * `waiting` until the 3-minute timeout with `smart_app_redirect_stu2` never resolved.
 */
async function waitForEhrLaunchCompletion(sessionId, runId, browser) {
  const maxWait = 180000; // 3 minutes
  const startTime = Date.now();
  let pollCount = 0;
  let page = null;
  let launchAttempted = false;
  let launchAttemptCount = 0;
  let authorizeAttempted = false;
  let authorizeAttemptCount = 0;
  const MAX_LAUNCH_ATTEMPTS = 3;

  console.log(`Waiting for EHR Launch test run ${runId} to complete (timeout: 3 minutes)...`);

  while (Date.now() - startTime < maxWait) {
    pollCount++;
    const response = await fetch(`${INFERNO_URL}/api/test_runs/${runId}?include_results=true`);
    if (!response.ok) {
      throw new Error(`Failed to get test run status: ${response.status} - ${response.statusText}`);
    }
    const runStatus = await response.json();

    console.log(`  [Poll #${pollCount}] Status: ${runStatus.status}`);

    if (runStatus.status === 'done' || runStatus.status === 'error' || runStatus.status === 'cancelled') {
      console.log(`Test completed with status: ${runStatus.status}`);
      if (page) await page.close();
      return runStatus;
    }

    // Handle waiting status — look for Inferno launch URL
    if (runStatus.status === 'waiting' && browser && !launchAttempted && launchAttemptCount < MAX_LAUNCH_ATTEMPTS) {
      launchAttemptCount++;

      if (launchAttemptCount > 1) {
        const backoffMs = (launchAttemptCount - 1) * 15000;
        console.log(`  Waiting ${backoffMs / 1000}s before launch retry (backoff)...`);
        await sleep(backoffMs);
      }

      console.log(`  Test is waiting for EHR launch action (attempt ${launchAttemptCount}/${MAX_LAUNCH_ATTEMPTS})...`);

      const results = runStatus.results || [];
      for (const result of results) {
        if (result.result === 'wait') {
          // Check message fields for the Inferno launch URL
          const messageFields = ['wait_message', 'result_message', 'messages'];
          for (const field of messageFields) {
            if (result[field]) {
              const content = typeof result[field] === 'string'
                ? result[field]
                : JSON.stringify(result[field]);

              // Inferno's wait message names the launch path in prose. Scraping the
              // bare URL out of it dropped the query string entirely, so Inferno got
              // no `iss`, could not correlate the waiting run, and answered 500
              // "Unable to find test run with identifier ''". Build the URL from the
              // contract instead: `iss` is the FHIR server we are already testing.
              if (/\/launch\b/.test(content)) {
                const launchCode = await mintEhrLaunchCode();
                const launchUrl = buildInfernoLaunchUrl(launchCode);
                console.log(`  EHR launch handoff${launchCode ? ' with patient context' : ' WITHOUT patient context'}: ${launchUrl.substring(0, 160)}`);
                try {
                  if (!page) page = await browser.newPage();
                  // Navigate to Inferno's launch URL — it will redirect to /authorize → Keycloak
                  await handleOAuthFlow(page, launchUrl);
                  launchAttempted = true;
                  console.log('  EHR Launch OAuth flow completed, continuing to poll...');
                } catch (launchError) {
                  console.error(`  EHR Launch OAuth flow failed: ${launchError.message}`);
                }
                break;
              }

              // Fallback: also check for authorize URLs (some versions may redirect differently)
              const authUrlMatch = content.match(/https?:\/\/[^\s<>"']+?authorize[^\s<>"')]+/);
              if (authUrlMatch) {
                let url = authUrlMatch[0].replace(/[.,;:!?]+$/, '');
                console.log(`  Found authorize URL in ${field}: ${url}`);
                try {
                  if (!page) page = await browser.newPage();
                  await handleOAuthFlow(page, url);
                  launchAttempted = true;
                  console.log('  OAuth flow completed, continuing to poll...');
                } catch (oauthError) {
                  console.error(`  OAuth flow failed: ${oauthError.message}`);
                }
                break;
              }
            }
          }
          if (launchAttempted) break;

          // Also check requests for launch/authorize URLs
          if (result.requests && result.requests.length > 0) {
            for (const req of result.requests) {
              if (req.direction === 'outgoing' && req.url) {
                if (req.url.includes('/launch') || req.url.includes('authorize')) {
                  console.log(`  Found URL in requests: ${req.url}`);
                  try {
                    if (!page) page = await browser.newPage();
                    await handleOAuthFlow(page, req.url);
                    launchAttempted = true;
                    console.log('  OAuth flow completed via request URL, continuing to poll...');
                  } catch (err) {
                    console.error(`  OAuth flow failed via request URL: ${err.message}`);
                  }
                  break;
                }
              }
            }
          }
        }
        if (launchAttempted) break;
      }

      if (!launchAttempted) {
        const waitResults = results.filter(r => r.result === 'wait');
        console.log(`  Found ${waitResults.length} waiting result(s) but no launch/OAuth URL found`);
        // Debug: dump wait result content
        for (const wr of waitResults) {
          for (const field of ['wait_message', 'result_message']) {
            if (wr[field]) {
              console.log(`    ${field} (first 300 chars): ${wr[field].substring(0, 300)}`);
            }
          }
        }
      }
    } else if (runStatus.status === 'waiting' && browser && launchAttempted && !authorizeAttempted
               && authorizeAttemptCount < MAX_LAUNCH_ATTEMPTS) {
      // Phase 2: the app has its launch context and now redirects the user to
      // authorize. Same handling as the standalone group.
      const authUrl = findAuthorizeUrl(runStatus.results);

      if (!authUrl) {
        // No URL yet is normal for a poll or two. Say what the payload holds so a
        // persistent stall names its own cause instead of timing out silently.
        const waitIds = (runStatus.results || [])
          .filter(r => r.result === 'wait')
          .map(r => r.test_id || 'unknown');
        console.log(`  Post-launch: waiting for an authorization URL (blocked on: ${waitIds.join(', ') || 'nothing'})`);
      } else {
        authorizeAttemptCount++;
        console.log(`  Post-launch authorization (attempt ${authorizeAttemptCount}/${MAX_LAUNCH_ATTEMPTS}): ${authUrl.substring(0, 140)}`);
        try {
          if (!page) page = await browser.newPage();
          await handleOAuthFlow(page, authUrl);
          authorizeAttempted = true;
          console.log('  EHR Launch authorization completed, continuing to poll...');
        } catch (authError) {
          console.error(`  EHR Launch authorization failed: ${authError.message}`);
        }
      }
    } else if (runStatus.status === 'waiting') {
      if (launchAttemptCount >= MAX_LAUNCH_ATTEMPTS) {
        console.error(`  EHR Launch OAuth failed after ${MAX_LAUNCH_ATTEMPTS} attempts — aborting wait`);
        if (page) await page.close();
        throw new Error(`EHR Launch OAuth automation failed after ${MAX_LAUNCH_ATTEMPTS} attempts`);
      }
      console.log(`  Test is waiting (launch ${launchAttempted ? 'already completed' : 'no browser available'})`);
    }

    // Log progress
    if (runStatus.results && runStatus.results.length > 0) {
      const passed = runStatus.results.filter(r => r.result === 'pass').length;
      const failed = runStatus.results.filter(r => r.result === 'fail').length;
      const waiting = runStatus.results.filter(r => r.result === 'wait').length;
      console.log(`  Progress: ${passed} passed, ${failed} failed, ${waiting} waiting, ${runStatus.results.length} total`);
    }

    await sleep(3000);
  }

  throw new Error('EHR Launch test run timed out');
}

/**
 * Run the Backend Services test group.
 * Uses client_credentials grant with JWT client assertion (RS384).
 * This is a machine-to-machine flow — no browser/OAuth needed.
 */
async function runBackendServicesTests(sessionId) {
  console.log('\n=== Running Backend Services Tests ===\n');

  try {
    const groups = await getTestGroups(TEST_SUITE);
    const backendGroup = groups.find(g => g.id === GROUP_IDS.BACKEND_SERVICES);

    if (!backendGroup) {
      console.log('Backend Services group not found, skipping...');
      return null;
    }

    console.log(`Running test group: ${backendGroup.id} — ${backendGroup.title}`);

    const backendAuthInfo = buildBackendServicesSmartAuthInfo();
    console.log('Auth info:', backendAuthInfo);

    const inputs = [
      { name: 'url', value: FHIR_SERVER_URL },
      { name: 'backend_services_smart_auth_info', value: backendAuthInfo }
    ];

    const run = await runTestGroup(sessionId, backendGroup.id, inputs);
    // No browser needed — Backend Services is non-interactive
    return await waitForSimpleTestCompletion(sessionId, run.id);

  } catch (error) {
    return groupFailure('Backend Services', error);
  }
}

async function waitForSimpleTestCompletion(sessionId, runId, browser = null) {
  const maxWait = 180000; // 3 minutes
  const startTime = Date.now();
  let pollCount = 0;
  let page = null;
  let oauthAttempted = false;
  let oauthAttemptCount = 0;
  const MAX_OAUTH_ATTEMPTS = 3;
  
  console.log(`Waiting for test run ${runId} to complete (timeout: 3 minutes)...`);
  
  while (Date.now() - startTime < maxWait) {
    pollCount++;
    // The correct API endpoint is /api/test_runs/:id?include_results=true
    const response = await fetch(`${INFERNO_URL}/api/test_runs/${runId}?include_results=true`);
    if (!response.ok) {
      console.log(`  [Poll #${pollCount}] API error: ${response.status} - ${response.statusText}`);
      throw new Error(`Failed to get test run status: ${response.status} - ${response.statusText}`);
    }
    const runStatus = await response.json();
    
    console.log(`  [Poll #${pollCount}] Status: ${runStatus.status}`);
    
    if (runStatus.status === 'done' || runStatus.status === 'error' || runStatus.status === 'cancelled') {
      console.log(`Test completed with status: ${runStatus.status}`);
      if (page) await page.close();
      return runStatus;
    }
    
    // Handle waiting status (OAuth required)
    if (runStatus.status === 'waiting' && browser && !oauthAttempted && oauthAttemptCount < MAX_OAUTH_ATTEMPTS) {
      oauthAttemptCount++;
      
      // Exponential backoff between retry attempts (0s, 15s, 30s)
      if (oauthAttemptCount > 1) {
        const backoffMs = (oauthAttemptCount - 1) * 15000;
        console.log(`  Waiting ${backoffMs / 1000}s before OAuth retry (backoff)...`);
        await sleep(backoffMs);
      }
      
      console.log(`  Test is waiting for user action (OAuth flow, attempt ${oauthAttemptCount}/${MAX_OAUTH_ATTEMPTS})...`);
      
      // Look for OAuth redirect URL in the waiting results
      const results = runStatus.results || [];
      for (const result of results) {
        if (result.result === 'wait') {
          // Debug: log the wait result structure
          console.log(`  Wait result keys: ${Object.keys(result).join(', ')}`);
          
          // Check all possible message fields
          const messageFields = ['wait_message', 'result_message', 'messages'];
          for (const field of messageFields) {
            if (result[field]) {
              const content = typeof result[field] === 'string' 
                ? result[field] 
                : JSON.stringify(result[field]);
              console.log(`  ${field} (first 500 chars): ${content.substring(0, 500)}`);
            }
          }
          
          // Check for OAuth URL in requests
          if (result.requests && result.requests.length > 0) {
            console.log(`  Checking ${result.requests.length} requests for OAuth URL...`);
            for (const req of result.requests) {
              console.log(`    Request: ${req.direction || 'unknown'} ${req.verb || 'GET'} ${(req.url || '').substring(0, 100)}`);
              if (req.direction === 'outgoing' && req.url && req.url.includes('authorize')) {
                console.log(`  Found OAuth redirect URL in requests: ${req.url}`);
                try {
                  if (!page) page = await browser.newPage();
                  await handleOAuthFlow(page, req.url);
                  oauthAttempted = true;
                  console.log('  OAuth flow completed, continuing to poll...');
                } catch (oauthError) {
                  console.error(`  OAuth flow failed: ${oauthError.message}`);
                }
                break;
              }
            }
          }
          
          // Check all message fields for OAuth URL
          if (!oauthAttempted) {
            for (const field of messageFields) {
              if (result[field]) {
                const content = typeof result[field] === 'string' 
                  ? result[field] 
                  : JSON.stringify(result[field]);
                // Look for authorize URLs - handle markdown link format [text](url)
                // Match URL up to closing ) or whitespace/quotes
                const urlMatch = content.match(/https?:\/\/[^\s<>"']+?authorize[^\s<>"')]+/);
                if (urlMatch) {
                  // Clean up any trailing punctuation
                  let url = urlMatch[0].replace(/[.,;:!?]+$/, '');
                  console.log(`  Found OAuth URL in ${field}: ${url}`);
                  try {
                    if (!page) page = await browser.newPage();
                    await handleOAuthFlow(page, url);
                    oauthAttempted = true;
                    console.log('  OAuth flow completed, continuing to poll...');
                  } catch (oauthError) {
                    console.error(`  OAuth flow failed: ${oauthError.message}`);
                  }
                  break;
                }
              }
            }
          }
        }
        if (oauthAttempted) break;
      }
      
      if (!oauthAttempted) {
        const waitResults = results.filter(r => r.result === 'wait');
        console.log(`  Found ${waitResults.length} waiting result(s) but no OAuth URL found`);
      }
    } else if (runStatus.status === 'waiting') {
      if (oauthAttemptCount >= MAX_OAUTH_ATTEMPTS) {
        console.error(`  OAuth failed after ${MAX_OAUTH_ATTEMPTS} attempts — aborting wait`);
        if (page) await page.close();
        throw new Error(`OAuth automation failed after ${MAX_OAUTH_ATTEMPTS} attempts`);
      }
      console.log(`  Test is waiting (OAuth ${oauthAttempted ? 'already completed' : 'no browser available'})`);
    }
    
    // Log current progress
    if (runStatus.results && runStatus.results.length > 0) {
      const passed = runStatus.results.filter(r => r.result === 'pass').length;
      const failed = runStatus.results.filter(r => r.result === 'fail').length;
      const waiting = runStatus.results.filter(r => r.result === 'wait').length;
      console.log(`  Progress: ${passed} passed, ${failed} failed, ${waiting} waiting, ${runStatus.results.length} total`);
    }
    
    await sleep(3000); // Poll every 3 seconds
  }
  
  throw new Error('Test run timed out');
}

async function getSessionResults(sessionId) {
  const response = await fetch(`${INFERNO_URL}/api/test_sessions/${sessionId}/results`);
  if (!response.ok) {
    throw new Error(`Failed to get session results: ${response.status}`);
  }
  return response.json();
}

/**
 * Record a group that blew up, so the run can report every group's outcome and
 * still fail. Three of the four groups used to log "WARNING: ... but continuing"
 * and return null that nothing inspected, so a run reported success with most of
 * the suite never executed; the fourth threw, which aborted the groups after it.
 */
function groupFailure(group, error) {
  console.error(`${group} tests error:`, error.message);
  return { group, ok: false, error: error.message };
}

async function printResults(results) {
  console.log('\n========================================');
  console.log('          TEST RESULTS SUMMARY          ');
  console.log('========================================\n');
  
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let errors = 0;
  // 'omit' is Inferno declining a test that does not apply here (the TLS tests
  // in local non-TLS mode). Not a failure, but it must be counted: it used to
  // fall through to the default branch, inflating `total` while landing in no
  // bucket at all.
  let omitted = 0;
  // A test that never reached a verdict: still 'wait'ing for a user action the
  // automation never completed, or cancelled. These are the ones that made the
  // job green while a launch flow was broken.
  let incomplete = 0;
  const incompleteTests = [];

  // Collect detailed failure info for later
  const failedTests = [];
  
  for (const result of results) {
    const status = result.result || 'unknown';
    const title = result.test?.title || result.test_id || 'Unknown test';
    
    switch (status) {
      case 'pass':
        passed++;
        console.log(`✓ PASS: ${title}`);
        break;
      case 'fail':
        failed++;
        console.log(`✗ FAIL: ${title}`);
        // Capture detailed failure info
        failedTests.push({
          title,
          test_id: result.test_id,
          result_message: result.result_message,
          messages: result.messages,
          outputs: result.outputs,
          requests: result.requests
        });
        // Print immediate summary
        if (result.result_message) {
          console.log(`    Reason: ${result.result_message.substring(0, 200)}`);
        }
        break;
      case 'skip':
        skipped++;
        console.log(`○ SKIP: ${title}`);
        if (result.result_message) {
          console.log(`    Reason: ${result.result_message.substring(0, 100)}`);
        }
        break;
      case 'error':
        errors++;
        console.log(`⚠ ERROR: ${title}`);
        if (result.result_message) {
          console.log(`    Error: ${result.result_message}`);
        }
        // Log additional context for errors (helps debug Inferno internal failures)
        if (result.messages && result.messages.length > 0) {
          result.messages.forEach((m, i) => {
            console.log(`    Message[${i}]: ${(m.message || m).toString().substring(0, 200)}`);
          });
        }
        break;
      case 'omit':
        omitted++;
        console.log(`− OMIT: ${title}`);
        if (result.result_message) {
          console.log(`    Reason: ${result.result_message.substring(0, 120)}`);
        }
        break;
      case 'wait':
      case 'cancel':
        incomplete++;
        incompleteTests.push({ title, status, test_id: result.test_id });
        console.log(`⧗ INCOMPLETE (${status}): ${title}`);
        break;
      default:
        // An unrecognised status is counted as incomplete rather than ignored:
        // a new Inferno state must not be able to pass the gate by being unknown.
        incomplete++;
        incompleteTests.push({ title, status, test_id: result.test_id });
        console.log(`⧗ INCOMPLETE (unrecognised status "${status}"): ${title}`);
    }
  }
  
  console.log('\n========================================');
  console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed} | Incomplete: ${incomplete} | Skipped: ${skipped} | Omitted: ${omitted} | Errors: ${errors}`);
  const accountedFor = passed + failed + skipped + errors + omitted + incomplete;
  if (accountedFor !== results.length) {
    console.log(`WARNING: ${results.length - accountedFor} result(s) landed in no bucket — the tally is wrong.`);
  }
  console.log('========================================\n');

  if (incompleteTests.length > 0) {
    console.log('The following tests never reached a verdict:');
    for (const t of incompleteTests) {
      console.log(`  ⧗ [${t.status}] ${t.title}`);
    }
    console.log('');
  }
  
  // Print detailed failure analysis
  if (failedTests.length > 0) {
    console.log('\n========================================');
    console.log('       DETAILED FAILURE ANALYSIS        ');
    console.log('========================================\n');
    
    for (const failure of failedTests) {
      console.log(`\n--- ${failure.title} ---`);
      console.log(`Test ID: ${failure.test_id}`);
      
      if (failure.result_message) {
        console.log(`\nResult Message:\n${failure.result_message}`);
      }
      
      if (failure.messages && failure.messages.length > 0) {
        console.log(`\nMessages:`);
        failure.messages.forEach((m, i) => {
          console.log(`  [${i + 1}] ${m.type || 'info'}: ${m.message}`);
        });
      }
      
      if (failure.outputs && Object.keys(failure.outputs).length > 0) {
        console.log(`\nOutputs:`);
        for (const [key, value] of Object.entries(failure.outputs)) {
          const displayValue = typeof value === 'string' && value.length > 200 
            ? value.substring(0, 200) + '...' 
            : value;
          console.log(`  ${key}: ${displayValue}`);
        }
      }
      
      // Show relevant HTTP requests/responses for debugging
      if (failure.requests && failure.requests.length > 0) {
        const relevantRequests = failure.requests.slice(-3); // Last 3 requests
        console.log(`\nRecent HTTP Requests (last ${relevantRequests.length}):`);
        for (const req of relevantRequests) {
          console.log(`  ${req.verb || req.method || 'GET'} ${req.url}`);
          if (req.status) {
            console.log(`    Response Status: ${req.status}`);
          }
          if (req.response_body) {
            const bodyPreview = typeof req.response_body === 'string' 
              ? req.response_body.substring(0, 500) 
              : JSON.stringify(req.response_body).substring(0, 500);
            console.log(`    Response Body: ${bodyPreview}`);
          }
          // Show request body for token/introspect requests (helps debug 400/422 errors)
          if (req.request_body && (req.url?.includes('/token') || req.url?.includes('/introspect'))) {
            const reqBody = typeof req.request_body === 'string'
              ? req.request_body.substring(0, 300)
              : JSON.stringify(req.request_body).substring(0, 300);
            console.log(`    Request Body: ${reqBody}`);
          }
          // Show all available keys for debugging
          const reqKeys = Object.keys(req).filter(k => req[k] != null);
          console.log(`    Available fields: ${reqKeys.join(', ')}`);

          // Fetch full request detail from Inferno API (includes headers + body)
          if (req.id && (req.status >= 400 || (req.url && req.url.includes('/token')))) {
            try {
              const detailResp = await fetch(`${INFERNO_URL}/api/requests/${req.id}`);
              if (detailResp.ok) {
                const detail = await detailResp.json();
                if (detail.request_headers) {
                  console.log(`    Request Headers: ${typeof detail.request_headers === 'string' ? detail.request_headers.substring(0, 300) : JSON.stringify(detail.request_headers).substring(0, 300)}`);
                }
                if (detail.request_body) {
                  // Redact sensitive values but keep parameter names visible
                  const body = typeof detail.request_body === 'string' ? detail.request_body : JSON.stringify(detail.request_body);
                  const redacted = body.replace(/(code|code_verifier|client_secret|password|client_assertion)=([^&]+)/g, '$1=[REDACTED]');
                  console.log(`    Request Body (redacted): ${redacted.substring(0, 500)}`);
                }
                if (detail.response_headers) {
                  console.log(`    Response Headers: ${typeof detail.response_headers === 'string' ? detail.response_headers.substring(0, 300) : JSON.stringify(detail.response_headers).substring(0, 300)}`);
                }
                if (detail.response_body) {
                  console.log(`    Response Body: ${typeof detail.response_body === 'string' ? detail.response_body.substring(0, 500) : JSON.stringify(detail.response_body).substring(0, 500)}`);
                }
              }
            } catch (detailErr) {
              console.log(`    (Could not fetch request detail: ${detailErr.message})`);
            }
          }
        }
      }
      
      console.log('\n' + '-'.repeat(50));
    }
  }
  
  return {
    passed, failed, skipped, errors, omitted, incomplete,
    total: results.length,
    unaccounted: results.length - accountedFor,
  };
}

async function main() {
  console.log('========================================');
  console.log('  Inferno SMART STU2.2 Compliance Tests ');
  console.log('========================================\n');
  
  console.log('Configuration:');
  console.log(`  Inferno URL: ${INFERNO_URL}`);
  console.log(`  FHIR Server: ${FHIR_SERVER_URL}`);
  console.log(`  Test Suite: ${TEST_SUITE}`);
  console.log(`  Client ID: ${CLIENT_ID}`);
  console.log(`  TLS: ${FHIR_SERVER_URL.startsWith('https') ? 'YES' : 'NO (local mode)'}`);
  console.log('');
  console.log('Groups to run:');
  console.log('  1. Standalone Launch (OAuth + OIDC + Token Refresh)');
  console.log('  2. Token Introspection');
  console.log('  3. Backend Services (client_credentials + JWT assertion)');
  console.log('  4. EHR Launch (EHR-initiated launch with patient context)');
  console.log('');
  
  let browser;
  
  try {
    // Wait for Inferno to be ready
    await waitForInferno();
    
    // Pre-flight warm-up: ensure FHIR server endpoints are responsive
    // (deployed services may have gone cold during CI tool setup)
    if (FHIR_SERVER_URL.startsWith('https')) {
      console.log('Pre-flight warm-up (deployed mode)...');
      const smartConfigUrl = `${FHIR_SERVER_URL}/.well-known/smart-configuration`;
      let serviceReady = false;
      
      // Wait for SMART config endpoint (the first thing Inferno hits)
      for (let attempt = 1; attempt <= 24; attempt++) {
        try {
          const resp = await fetch(smartConfigUrl);
          console.log(`  SMART config: ${resp.status} (attempt ${attempt}/24)`);
          if (resp.ok) {
            serviceReady = true;
            break;
          }
        } catch (e) {
          console.log(`  SMART config: ${e.message} (attempt ${attempt}/24)`);
        }
        await sleep(10000); // 10s between attempts = up to 4 minutes total
      }
      
      if (!serviceReady) {
        throw new Error('Deployed SMART configuration endpoint never became healthy — aborting tests');
      }
      
      // Also warm up FHIR metadata
      try {
        const metaResp = await fetch(`${FHIR_SERVER_URL}/metadata`);
        console.log(`  FHIR /metadata: ${metaResp.status}`);
      } catch (e) {
        console.log(`  FHIR /metadata: ${e.message}`);
      }
      console.log('  ✓ Pre-flight warm-up complete');
      console.log('');
    }
    
    // Launch browser for OAuth automation
    console.log('Launching headless Chromium for OAuth automation...');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    // Create test session
    const session = await createTestSession();
    
    // Group 1: Standalone Launch (includes Discovery, OAuth, OIDC, Token Refresh)
    const standaloneResult = await runStandaloneLaunchTests(session.id, browser);
    
    // Group 2: Token Introspection (uses tokens from Standalone Launch)
    const introspectionResult = await runTokenIntrospectionTests(session.id, browser);
    
    // Group 3: Backend Services (client_credentials with JWT assertion — no browser needed)
    const backendServicesResult = await runBackendServicesTests(session.id);
    
    // Group 4: EHR Launch (EHR-initiated launch with patient context)
    const ehrLaunchResult = await runEhrLaunchTests(session.id, browser);
    
    // Get all results across all groups
    const results = await getSessionResults(session.id);
    const summary = await printResults(results);

    const groupFailures = [standaloneResult, introspectionResult, backendServicesResult, ehrLaunchResult]
      .filter(r => r && r.ok === false);

    if (groupFailures.length > 0) {
      console.error('\nTest groups that did not run to completion:');
      for (const f of groupFailures) {
        console.error(`  ✗ ${f.group}: ${f.error}`);
      }
    }

    // Output for GitHub Actions
    if (process.env.GITHUB_OUTPUT) {
      const fs = require('fs');
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `passed=${summary.passed}\n`);
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `failed=${summary.failed}\n`);
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `total=${summary.total}\n`);
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `incomplete=${summary.incomplete}\n`);
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `omitted=${summary.omitted}\n`);
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `group_failures=${groupFailures.length}\n`);
    }

    // A run is only a pass if every test reached a verdict and every group ran.
    // Counting only `failed` let a green result hide tests still stuck in `wait`
    // because their launch flow never completed.
    const reasons = [];
    if (summary.total === 0) reasons.push('no tests ran');
    if (summary.failed > 0) reasons.push(`${summary.failed} failed`);
    if (summary.incomplete > 0) reasons.push(`${summary.incomplete} never reached a verdict`);
    if (summary.unaccounted !== 0) reasons.push(`${summary.unaccounted} unaccounted for`);
    if (groupFailures.length > 0) {
      reasons.push(`${groupFailures.length} group(s) failed to run: ${groupFailures.map(f => f.group).join(', ')}`);
    }

    if (reasons.length > 0) {
      console.error(`\n❌ Compliance run failed — ${reasons.join('; ')} (out of ${summary.total} tests, ${summary.errors} errors)`);
      process.exit(1);
    }

    if (summary.errors > 0) {
      console.warn(`\n⚠️  ${summary.errors} test(s) had internal errors (not compliance failures) — ${summary.passed} passed out of ${summary.total}`);
    }

    console.log(`\n✅ All ${summary.passed} tests passed${summary.omitted > 0 ? ` (${summary.omitted} omitted as not applicable)` : ''}!`);

  } catch (error) {
    console.error('Test execution failed:', error.message);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

main();
