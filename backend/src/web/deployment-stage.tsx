// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { maxhealth } from 'brandc'
import type { HtmlDecorator } from '../lib/docs-files'
import { DEPLOYMENT_STAGE_META, TestEnvironmentBanner, isTestStage, renderToString, type DeploymentStage } from '@proxy-smart/site-kit'

const HEAD_CLOSE = /<\/head\s*>/i
const BODY_OPEN = /<body\b[^>]*>/i
const DOCTYPE = /^\s*<!doctype[^>]*>/i

function token(name: 'warning' | 'warning-foreground'): string {
  const { light, dark } = maxhealth.colors[name]
  return `light-dark(${light}, ${dark})`
}

const DOCS_BANNER_CSS = [
  `.stage-banner{position:fixed;top:0;left:0;right:0;z-index:100;background:${token('warning')};color:${token('warning-foreground')};padding:.4rem 1rem;font:400 13px/1.45 var(--vp-font-family-base,system-ui,sans-serif);text-align:center;overflow-wrap:anywhere}`,
  '.stage-banner strong{font-weight:600;margin-right:.25em}',
  ':root{--vp-layout-top-height:3.75rem}',
  '@media (min-width:768px){:root{--vp-layout-top-height:2.25rem}}',
].join('')

const DOCS_BANNER_SCRIPT = `(function(){var b=document.querySelector('.stage-banner');if(!b)return;var r=document.documentElement;function f(){r.style.setProperty('--vp-layout-top-height',b.offsetHeight+'px')}f();if('ResizeObserver' in window)new ResizeObserver(f).observe(b)})();`

function insertIntoHead(html: string, fragment: string): string {
  const close = HEAD_CLOSE.exec(html)
  if (close) return html.slice(0, close.index) + fragment + html.slice(close.index)
  const doctype = DOCTYPE.exec(html)
  const at = doctype ? doctype.index + doctype[0].length : 0
  return html.slice(0, at) + fragment + html.slice(at)
}

function insertAtBodyStart(html: string, fragment: string): string {
  const open = BODY_OPEN.exec(html)
  if (!open) return html + fragment
  const at = open.index + open[0].length
  return html.slice(0, at) + fragment + html.slice(at)
}

export function stageMetaTag(stage: DeploymentStage): string {
  return isTestStage(stage) ? renderToString(<meta name={DEPLOYMENT_STAGE_META} content={stage} />) : ''
}

export function withStageMeta(html: string, stage: DeploymentStage): string {
  const tag = stageMetaTag(stage)
  return tag ? insertIntoHead(html, tag) : html
}

export function withDocsStageBanner(html: string, stage: DeploymentStage): string {
  if (!isTestStage(stage)) return html
  const head = stageMetaTag(stage) + renderToString(<style dangerouslySetInnerHTML={{ __html: DOCS_BANNER_CSS }} />)
  const banner = renderToString(
    <>
      <TestEnvironmentBanner />
      <script dangerouslySetInnerHTML={{ __html: DOCS_BANNER_SCRIPT }} />
    </>,
  )
  return insertAtBodyStart(insertIntoHead(html, head), banner)
}

export function docsStageDecorator(stage: DeploymentStage): HtmlDecorator | undefined {
  return isTestStage(stage) ? html => withDocsStageBanner(html, stage) : undefined
}
