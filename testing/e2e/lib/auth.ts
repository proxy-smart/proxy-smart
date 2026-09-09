import { type Page, expect } from "@playwright/test"
import { env, testUsers } from "./env"

/** Matched on the protocol name, so a change to the button's wording does not break the flow. */
const SIGN_IN_BUTTON = /SMART/i

/**
 * Performs Keycloak login on the current page.
 * Expects the page to be on the Keycloak login form.
 */
export async function keycloakLogin(
  page: Page,
  user: keyof typeof testUsers = "patient",
): Promise<void> {
  const creds = testUsers[user]

  /*
   * The proxy-smart theme leads with the identity providers and keeps
   * username/password in a closed <details>, so the fields exist with no box
   * until it is opened (keycloak/themes/proxy-smart/login/login.ftl).
   *
   * Skipped when the theme already renders it open — a failed attempt, or a
   * realm with no provider to choose instead — and on any other theme.
   */
  const disclosure = page.locator("details.ps-password-disclosure")
  if ((await disclosure.count()) > 0) {
    const isOpen = await disclosure.evaluate((el) => (el as HTMLDetailsElement).open)
    if (!isOpen) await disclosure.locator("summary").click()
  }

  // Wait for the Keycloak login form
  const usernameField = page.locator("#username")
  await expect(usernameField).toBeVisible({ timeout: 15_000 })

  await usernameField.fill(creds.username)
  await page.locator("#password").fill(creds.password)
  await page.locator("#kc-login").click()
}

/**
 * Navigate to patient-portal and perform full SMART login flow:
 * 1. Go to patient portal
 * 2. Click the SMART login button
 * 3. Handle Keycloak login
 * 4. Wait for callback redirect and authenticated state
 *
 * Returns the page in authenticated state.
 */
export async function smartLogin(
  page: Page,
  user: keyof typeof testUsers = "patient",
): Promise<void> {
  // Navigate to patient portal
  await page.goto(env.patientPortalURL, { waitUntil: "domcontentloaded" })

  // Check if we're already authenticated (e.g. from stored state)
  const signOutButton = page.getByRole("button", { name: "Sign Out" })
  if (await signOutButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
    return // Already logged in
  }

  // Click sign in
  const signInButton = page.getByRole("button", { name: SIGN_IN_BUTTON })
  await expect(signInButton).toBeVisible({ timeout: 10_000 })
  await signInButton.click()

  // Handle Keycloak login form
  await keycloakLogin(page, user)

  // Handle Keycloak "Update Account Information" page if it appears
  // (shown for new users missing required profile fields)
  const updateHeading = page.getByRole("heading", { name: "Update Account Information" })
  if (await updateHeading.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const creds = testUsers[user]
    const emailField = page.getByLabel("Email")
    if (await emailField.inputValue() === "") {
      await emailField.fill(`${creds.username}@proxy-smart.test`)
    }
    const firstNameField = page.getByLabel("First name")
    if (await firstNameField.inputValue() === "") {
      await firstNameField.fill("Test")
    }
    const lastNameField = page.getByLabel("Last name")
    if (await lastNameField.inputValue() === "") {
      await lastNameField.fill("User")
    }
    await page.getByRole("button", { name: "Submit" }).click()
  }

  // Handle Keycloak OAuth consent screen if it appears
  const grantButton = page.getByRole("button", { name: "Yes", exact: true })
  if (await grantButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await grantButton.click()
  }

  // Wait for redirect back to patient portal in authenticated state
  await expect(signOutButton).toBeVisible({ timeout: 30_000 })
}

/**
 * Perform a full logout from the patient portal.
 */
export async function smartLogout(page: Page): Promise<void> {
  const signOutButton = page.getByRole("button", { name: "Sign Out" })
  await expect(signOutButton).toBeVisible()
  await signOutButton.click()

  // Should return to unauthenticated state
  await expect(
    page.getByRole("button", { name: SIGN_IN_BUTTON }),
  ).toBeVisible({ timeout: 15_000 })
}

/**
 * Navigate to consent-app and perform full SMART login flow.
 * Returns the page in authenticated state showing the Consent Manager dashboard.
 */
export async function consentLogin(
  page: Page,
  user: keyof typeof testUsers = "patient",
): Promise<void> {
  await page.goto(env.consentAppURL, { waitUntil: "domcontentloaded" })

  // Check if already authenticated
  const signOutButton = page.getByRole("button", { name: "Sign Out" })
  if (await signOutButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
    return
  }

  // Click sign in
  const signInButton = page.getByRole("button", { name: SIGN_IN_BUTTON })
  await expect(signInButton).toBeVisible({ timeout: 10_000 })
  await signInButton.click()

  // Handle Keycloak login
  await keycloakLogin(page, user)

  // Handle "Update Account Information" page if it appears
  const updateHeading = page.getByRole("heading", { name: "Update Account Information" })
  if (await updateHeading.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const creds = testUsers[user]
    const emailField = page.getByLabel("Email")
    if (await emailField.inputValue() === "") {
      await emailField.fill(`${creds.username}@proxy-smart.test`)
    }
    const firstNameField = page.getByLabel("First name")
    if (await firstNameField.inputValue() === "") {
      await firstNameField.fill("Test")
    }
    const lastNameField = page.getByLabel("Last name")
    if (await lastNameField.inputValue() === "") {
      await lastNameField.fill("User")
    }
    await page.getByRole("button", { name: "Submit" }).click()
  }

  // Handle Keycloak OAuth consent screen if it appears
  const grantButton = page.getByRole("button", { name: "Yes", exact: true })
  if (await grantButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await grantButton.click()
  }

  // Wait for authenticated state
  await expect(signOutButton).toBeVisible({ timeout: 30_000 })
}
