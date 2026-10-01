// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Documentation API Routes
 * 
 * JSON API for programmatic access to raw markdown documentation:
 * - GET /docs-api → Table of contents
 * - GET /docs-api/:filename → Serve raw markdown files
 * - GET /docs-api/search/keyword → Keyword search with hit counts
 * - GET /docs-api/search/semantic → Semantic search with similarity scores
 *
 * VitePress-built docs are served as static files at /docs (see app-factory.ts)
 */

import { Elysia, t } from 'elysia'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { searchDocumentation } from '../lib/ai/rag-tools'
import { docsSourceDir } from '../lib/paths'
import {
  ErrorResponse,
  TableOfContentsResponse,
  KeywordSearchResponse,
  SemanticSearchResponse,
  SearchQuery,
  SemanticSearchQuery,
  type DocEntryType,
  type KeywordSearchResultType,
  type SemanticSearchResultType,
  type TableOfContentsResponseType,
  type KeywordSearchResponseType,
  type SemanticSearchResponseType
} from '../schemas'

const DOCS_DIR = docsSourceDir()

/**
 * Load all markdown files and build table of contents
 */
async function loadTableOfContents(): Promise<DocEntryType[]> {
  const entries: DocEntryType[] = []
  
  async function scanDir(dir: string, category: string = '') {
    const files = await readdir(dir, { withFileTypes: true })
    
    for (const file of files) {
      const fullPath = join(dir, file.name)
      
      if (file.isDirectory()) {
        // Recursively scan subdirectories
        const subCategory = category ? `${category}/${file.name}` : file.name
        await scanDir(fullPath, subCategory)
      } else if (file.name.endsWith('.md')) {
        // Extract title from first # heading in file
        const content = await readFile(fullPath, 'utf-8')
        const titleMatch = content.match(/^#\s+(.+)$/m)
        const title = titleMatch ? titleMatch[1] : file.name.replace('.md', '')
        
        // Get relative path from docs directory
        const relativePath = relative(DOCS_DIR, fullPath).replace(/\\/g, '/')
        
        entries.push({
          path: relativePath,
          title,
          category: category || 'general',
          url: `/docs-api/${relativePath}`,
        })
      }
    }
  }
  
  await scanDir(DOCS_DIR)
  
  // Sort by category, then title
  entries.sort((a, b) => {
    if (a.category !== b.category) {
      return a.category.localeCompare(b.category)
    }
    return a.title.localeCompare(b.title)
  })
  
  return entries
}

/**
 * Keyword search across all markdown files
 */
async function keywordSearch(query: string): Promise<KeywordSearchResultType[]> {
  const normalizedQuery = query.toLowerCase()
  const results: KeywordSearchResultType[] = []
  
  const toc = await loadTableOfContents()
  
  for (const doc of toc) {
    const fullPath = join(DOCS_DIR, doc.path)
    const content = await readFile(fullPath, 'utf-8')
    const lines = content.split('\n')
    
    let hitCount = 0
    const matches: Array<{ line: number; text: string; context: string }> = []
    
    lines.forEach((line, index) => {
      const normalizedLine = line.toLowerCase()
      // Escape user input to prevent ReDoS attacks
      const escapedQuery = normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const count = (normalizedLine.match(new RegExp(escapedQuery, 'g')) || []).length
      
      if (count > 0) {
        hitCount += count
        
        // Get context (previous and next line)
        const prevLine = index > 0 ? lines[index - 1] : ''
        const nextLine = index < lines.length - 1 ? lines[index + 1] : ''
        const context = [prevLine, line, nextLine].filter(l => l.trim()).join('\n')
        
        matches.push({
          line: index + 1,
          text: line.trim(),
          context,
        })
      }
    })
    
    if (hitCount > 0) {
      results.push({
        document: doc.title,
        hits: hitCount,
        url: doc.url,
        matches: matches.slice(0, 5), // Top 5 matches per document
      })
    }
  }
  
  // Sort by hit count descending
  results.sort((a, b) => b.hits - a.hits)
  
  return results
}

/**
 * Semantic search using RAG
 */
async function semanticSearch(query: string, limit: number = 10): Promise<SemanticSearchResultType[]> {
  // Use existing RAG tool
  const ragResult = await searchDocumentation(query, limit)
  
  // Transform to our format
  const results: SemanticSearchResultType[] = ragResult.documents.map(doc => {
    // Extract filename from source path
    const filename = doc.source.replace('docs/', '')
    
    return {
      document: doc.title,
      similarity: doc.relevance_score || 0,
      url: `/docs/${filename}`,
      title: doc.title,
      content_preview: doc.content.substring(0, 200) + '...',
    }
  })
  
  // Already sorted by similarity (from RAG)
  return results
}

/**
 * Documentation routes
 */
export const docsRoutes = new Elysia({ prefix: '/docs-api' })
  .get(
    '/',
    async (): Promise<TableOfContentsResponseType> => {
      const toc = await loadTableOfContents()
      
      // Group by category
      const grouped = toc.reduce((acc, doc) => {
        if (!acc[doc.category]) {
          acc[doc.category] = []
        }
        acc[doc.category].push(doc)
        return acc
      }, {} as Record<string, DocEntryType[]>)
      
      return {
        total_documents: toc.length,
        categories: Object.keys(grouped).sort(),
        table_of_contents: grouped,
        search: {
          keyword: '/docs-api/search/keyword?q=your+query',
          semantic: '/docs-api/search/semantic?q=your+query',
        },
      }
    },
    {
      response: {
        200: TableOfContentsResponse
      },
      detail: {
        summary: 'Get documentation table of contents',
        description: 'Returns a complete table of contents for all documentation with links to individual files',
        tags: ['Documentation'],
      },
    }
  )
  .get(
    '/search/keyword',
    async ({ query }): Promise<KeywordSearchResponseType> => {
      const results = await keywordSearch(query.q)
      
      return {
        query: query.q,
        total_results: results.length,
        total_hits: results.reduce((sum, r) => sum + r.hits, 0),
        results,
      }
    },
    {
      query: SearchQuery,
      response: {
        200: KeywordSearchResponse
      },
      detail: {
        summary: 'Keyword search in documentation',
        description: 'Search for exact keyword matches in all documentation. Returns documents sorted by hit count (descending).',
        tags: ['Documentation'],
      },
    }
  )
  .get(
    '/search/semantic',
    async ({ query }): Promise<SemanticSearchResponseType> => {
      const limit = query.limit ? parseInt(query.limit) : 10
      const results = await semanticSearch(query.q, limit)
      
      return {
        query: query.q,
        total_results: results.length,
        results,
      }
    },
    {
      query: SemanticSearchQuery,
      response: {
        200: SemanticSearchResponse
      },
      detail: {
        summary: 'Semantic search in documentation',
        description: 'Search documentation using semantic/vector similarity. Returns documents sorted by similarity score (descending).',
        tags: ['Documentation'],
      },
    }
  )
  .get(
    '/*',
    async ({ params, set }) => {
      try {
        // Get the wildcard path (everything after /docs/)
        const filepath = (params as { '*': string })['*']
        
        // Security: prevent directory traversal
        if (filepath.includes('..') || filepath.startsWith('/')) {
          set.status = 400
          return { error: 'Invalid filename' }
        }
        
        const fullPath = join(DOCS_DIR, filepath)
        const content = await readFile(fullPath, 'utf-8')
        
        // Set content type to markdown
        set.headers['content-type'] = 'text/markdown; charset=utf-8'
        
        return content
      } catch {
        set.status = 404
        return { error: 'Document not found' }
      }
    },
    {
      response: {
        200: t.String(),
        400: ErrorResponse,
        404: ErrorResponse
      },
      detail: {
        summary: 'Get markdown document',
        description: 'Returns the raw markdown content of a documentation file. Supports nested paths like admin-ui/dashboard.md',
        tags: ['Documentation'],
      },
    }
  )
