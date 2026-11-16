// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/*
 * Login theme helpers backed by the proxy (base from this script's ?base=, else same-origin):
 * the client's brand accent, the client_id for error.ftl's /auth/return link, and a beacon to
 * /auth/login-error when an error page is shown. Every failure is silent.
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

  function reportError(base) {
    var box = document.getElementById("kc-error-message")
    var nav = window.navigator
    if (!box || !nav || typeof nav.sendBeacon !== "function") return
    var shown = box.querySelector(".instruction")
    var message = ((shown && shown.textContent) || "").trim().slice(0, 300)
    var report = { message: message, page: window.location.pathname.slice(0, 300) }
    var clientId = remembered()
    if (clientId) report.clientId = clientId
    nav.sendBeacon(base + "/auth/login-error", JSON.stringify(report))
  }

  function onPageReady(base) {
    linkReturnToClient(base)
    try { reportError(base) } catch (e) { /* reporting is best effort */ }
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
      document.addEventListener("DOMContentLoaded", function () { onPageReady(base) })
    } else {
      onPageReady(base)
    }
  } catch (e) {
    /* leave the theme defaults in place */
  }
})()
