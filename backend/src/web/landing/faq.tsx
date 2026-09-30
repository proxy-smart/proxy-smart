// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { FC } from 'hono/jsx'
import type { JSX } from 'hono/jsx/jsx-runtime'
import { ENFORCEMENT_DEFAULTS } from '@/lib/enforcement-mode'
import { renderToString } from '../render'
import { PRODUCT } from './content'
import type { LandingData } from './index'

interface FaqItem {
  question: string
  answer: JSX.Element
}

function faqItems(data: LandingData): FaqItem[] {
  return [
    {
      question: `What is ${PRODUCT.name}?`,
      answer: <>A stateless proxy that sits between SMART on FHIR apps and your FHIR servers. It adds OAuth 2.0 and SMART App Launch 2.2.0 authorization to servers that do not support it natively, and manages scopes, launch context and access control in one place.</>,
    },
    {
      question: `Does ${PRODUCT.name} store clinical data?`,
      answer: <>No. FHIR requests pass through to your existing servers and the proxy keeps none of the responses. PostgreSQL only holds Keycloak's users and configuration, which keeps the attack surface small and simplifies HIPAA and GDPR compliance.</>,
    },
    {
      question: 'Which FHIR servers does it work with?',
      answer: <>Any FHIR R4 or R4B server, for example HAPI FHIR, Microsoft FHIR Server or AWS HealthLake. Register as many as you need in the admin UI; each one gets its own SMART configuration under <code>/.well-known/smart-configuration</code>.</>,
    },
    {
      question: 'How do you verify SMART App Launch compliance?',
      answer: <>The ONC Inferno SMART App Launch suite runs in CI against every release channel. PKCE, v1 and v2 scope syntax, token introspection, backend services authorization and user-access brands are all covered; the <a href="/docs/SMART_2.2.0_CHECKLIST">implementation checklist</a> tracks each requirement.</>,
    },
    {
      question: 'Can I enforce patient-level data isolation?',
      answer: <>Yes. Role-based filtering narrows results by the token's <code>fhirUser</code>, so patients only see their own data and practitioners only their assigned patients. It starts in {ENFORCEMENT_DEFAULTS.roleBasedFiltering} mode; set <code>ROLE_BASED_FILTERING_MODE=enforce</code> or switch it at runtime through the admin API once the audit logs look right.</>,
    },
    {
      question: 'Can AI agents use it?',
      answer: <>Yes. {PRODUCT.name} runs an MCP server over streamable HTTP at <code>{data.mcpPath}</code>. Its tools are derived from the admin API and protected by the same OAuth flows, so an agent can only do what its token allows.</>,
    },
    {
      question: 'Does it cover medical imaging?',
      answer: <>Yes. The built-in DICOMweb proxy at <code>/dicomweb</code> forwards QIDO-RS and WADO-RS requests to Orthanc or any other PACS. The same SMART token authorizes imaging and FHIR access, and every DICOM UID is validated before forwarding.</>,
    },
    {
      question: 'How do I deploy it?',
      answer: <>With Docker Compose, as a single mono-container or as separate containers, behind a Caddy reverse proxy. AWS CDK infrastructure is included for cloud deployments. The <a href="/docs/deployment">deployment guide</a> walks through each option.</>,
    },
    {
      question: `How is ${PRODUCT.name} licensed?`,
      answer: <>It is dual licensed: AGPL-3.0 for open-source use, and a commercial license for proprietary deployments. Every running instance serves its exact source at <a href="/source">/source</a>, and the code lives at <a href={data.source.repositoryUrl}>{data.source.repositoryUrl.replace(/^https:\/\//, '')}</a>.</>,
    },
  ]
}

export function faqJsonLd(data: LandingData) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${data.siteUrl}/#faq`,
    mainEntity: faqItems(data).map(item => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: renderToString(item.answer) },
    })),
  }
}

export const Faq: FC<{ data: LandingData }> = ({ data }) => (
  <section id="faq">
    <div class="section-label">FAQ</div>
    <h2 class="section-title">Questions people ask <span class="dim">before they deploy.</span></h2>
    <div class="faq">
      {faqItems(data).map(item => (
        <details class="faq-item">
          <summary class="faq-q">{item.question}</summary>
          <div class="faq-a">{item.answer}</div>
        </details>
      ))}
    </div>
  </section>
)
