// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Proxy Smart',
  description: 'Healthcare interoperability proxy — SMART App Launch 2.2.0, OAuth 2.0 & MCP',
  base: process.env.VITEPRESS_BASE || '/docs/',
  cleanUrls: true,
  ignoreDeadLinks: true,

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${process.env.VITEPRESS_BASE || '/docs/'}logo.svg` }],
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Home', link: '/' },
      { text: 'Core', link: '/fhir-proxy' },
      { text: 'Admin UI', link: '/admin-ui/dashboard' },
      { text: 'AI & MCP', link: '/MCP_HTTP_SERVER' },
      { text: 'Imaging', link: '/dicomweb-proxy' },
      { text: 'SMART on FHIR', link: '/SMART_2.2.0_CHECKLIST' },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Deployment', link: '/deployment' },
          { text: 'Environment Variables', link: '/environment-variables' },
          { text: 'Packages', link: '/packages' },
        ],
      },
      {
        text: 'Core',
        collapsed: false,
        items: [
          { text: 'FHIR Proxy', link: '/fhir-proxy' },
          { text: 'OAuth & Authentication', link: '/oauth-authentication' },
          { text: 'Patient API', link: '/patient-api' },
        ],
      },
      {
        text: 'Admin UI',
        collapsed: false,
        items: [
          { text: 'Dashboard', link: '/admin-ui/dashboard' },
          { text: 'User Management', link: '/admin-ui/user-management' },
          { text: 'User Federation', link: '/admin-ui/user-federation' },
          { text: 'SMART Apps', link: '/admin-ui/smart-apps' },
          { text: 'FHIR Servers', link: '/admin-ui/fhir-servers' },
          { text: 'Organizations', link: '/admin-ui/organizations' },
          { text: 'Identity Providers', link: '/admin-ui/identity-providers' },
          { text: 'AI Tools', link: '/admin-ui/ai-tools' },
          { text: 'Scope Management', link: '/admin-ui/scope-management' },
          { text: 'Launch Context', link: '/admin-ui/launch-context' },
          { text: 'Brand Management', link: '/admin-ui/branding' },
          { text: 'Monitoring', link: '/admin-ui/monitoring' },
        ],
      },
      {
        text: 'SMART Apps',
        collapsed: false,
        items: [
          { text: 'Admin UI', link: '/apps/admin-ui' },
          { text: 'Consent App', link: '/apps/consent-app' },
          { text: 'DTR App', link: '/apps/dtr-app' },
          { text: 'Patient Picker', link: '/apps/patient-picker' },
          { text: 'Patient Portal', link: '/apps/patient-portal' },
          { text: 'SMART DICOM Template', link: '/apps/smart-dicom-template' },
          { text: 'Shared UI Library', link: '/shared-ui' },
        ],
      },
      {
        text: 'Imaging & DICOMweb',
        collapsed: false,
        items: [
          { text: 'DICOMweb Proxy', link: '/dicomweb-proxy' },
          { text: 'Patient Portal Imaging', link: '/patient-portal-imaging' },
        ],
      },
      {
        text: 'MCP',
        collapsed: false,
        items: [
          { text: 'MCP HTTP Server', link: '/MCP_HTTP_SERVER' },
          { text: 'Backend API Tools', link: '/BACKEND_API_TOOLS' },
        ],
      },
      {
        text: 'SMART on FHIR',
        collapsed: false,
        items: [
          { text: 'SMART 2.2.0 Checklist', link: '/SMART_2.2.0_CHECKLIST' },
          { text: 'Compliance Reports', link: '/compliance-reports' },
        ],
      },
      {
        text: 'Guides',
        collapsed: false,
        items: [
          { text: 'Version Management', link: '/tutorials/version-management' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/proxy-smart/proxy-smart' },
    ],

    search: {
      provider: 'local',
    },

    footer: {
      message: 'Proxy Smart — Healthcare Interoperability Platform',
      copyright: '© 2024–2026 Max Health Inc.',
    },
  },
})
