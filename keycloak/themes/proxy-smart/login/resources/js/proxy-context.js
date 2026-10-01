// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/*
 * What the login theme needs from the proxy, which knows the launching client when Keycloak's
 * static theme does not.
 *
 * Accent: a <link> to /auth/login-brand.css?client_id=... answers `:root{--brand-accent: ...}`
 * for that client's organization. It runs synchronously from <head> and appends a plain
 * stylesheet, so the browser blocks paint on it; an async fetch would flash the wrong brand.
 *
 * Back to application: a failed identity-provider callback renders the error page with no client
 * in context. The client_id is remembered for this tab while it is on the login URL, and the
 * error page's fallback link (PROXY_PUBLIC_URL/auth/return, rendered by error.ftl) gets it
 * appended. The proxy only ever redirects to that client's registered home.
 *
 * Origin: Keycloak and the proxy are on different hosts in production, so the proxy base arrives
 * on this script's own src (`?base=${env.PROXY_PUBLIC_URL}`, substituted by Keycloak). Unset,
 * Keycloak emits the placeholder verbatim, so only an absolute http(s) base is used; otherwise
 * same-origin. Every failure is silent: the theme defaults are a working page.
 */
(function () {
  var STORAGE_KEY = "proxy-smart.login-client"

  function proxyBase() {
    var self = document.currentScript
    if (!self || !self.src) return ""
    var declared = new URL(self.src).searchParams.get("base") || ""
    return /^https?:\/\//.test(declared) ? declared.replace(/\/$/, "") : ""
  }

  function remember(clientId) {
    try { window.sessionStorage.setItem(STORAGE_KEY, clientId) } catch (e) { /* storage blocked */ }
  }

  function remembered() {
    try { return window.sessionStorage.getItem(STORAGE_KEY) || "" } catch (e) { return "" }
  }

  function linkReturnToClient(base) {
    var link = document.getElementById("backToApplication")
    var clientId = remembered()
    if (!link || !clientId) return
    var target = new URL(link.getAttribute("href"), window.location.href)
    var returnUrl = new URL(base + "/auth/return", window.location.href)
    if (target.origin + target.pathname !== returnUrl.origin + returnUrl.pathname) return
    target.searchParams.set("client_id", clientId)
    link.setAttribute("href", target.href)
  }

  try {
    var base = proxyBase()
    var clientId = new URLSearchParams(window.location.search).get("client_id")

    if (clientId) {
      remember(clientId)
      var link = document.createElement("link")
      link.rel = "stylesheet"
      link.href = base + "/auth/login-brand.css?client_id=" + encodeURIComponent(clientId)
      document.head.appendChild(link)
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { linkReturnToClient(base) })
    } else {
      linkReturnToClient(base)
    }
  } catch (e) {
    /* leave the theme defaults in place */
  }
})()
