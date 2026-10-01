// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import crypto from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { openai } from '@ai-sdk/openai'
import { cosineSimilarity, embed, embedMany } from 'ai'
import { logger } from '../logger'
import { docsSourceDir, ragCachePath } from '../paths'

interface RagDocument {
  title: string
  content: string
  source: string
  relevance_score?: number
  [key: string]: unknown
}

export interface RagSearchResponse {
  documents: RagDocument[]
  query: string
  total_results: number
}

interface CacheChunk {
  text: string
  embedding: number[]
}

interface CacheEntry {
  checksum: string
  chunks: CacheChunk[]
  title: string
}

interface CacheFile {
  version: number
  embedding_model: string
  documents: Record<string, CacheEntry>
}

interface KnowledgeChunk {
  id: string
  docPath: string
  title: string
  text: string
  embedding: number[]
  chunkIndex: number
  source: string
}

const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'
const MAX_BATCH_SIZE = Number.parseInt(process.env.RAG_EMBEDDING_BATCH_SIZE || '64', 10)
const embeddingModel = openai.embedding(EMBEDDING_MODEL)
const TARGET_CHARS = Number.parseInt(process.env.RAG_CHUNK_SIZE || '1200', 10)
const MIN_CHARS = Number.parseInt(process.env.RAG_MIN_CHUNK_SIZE || '200', 10)

// Path policy (docs dir, RAG cache) lives in lib/paths, out of reach of the MCP tests' mock of this module.
const DOCS_DIR = docsSourceDir()

let knowledgeBase: KnowledgeChunk[] = []
let initializationPromise: Promise<void> | null = null

function ensureAPIKey(): boolean {
  if (!process.env.OPENAI_API_KEY) {
    logger.server.error('OPENAI_API_KEY is not configured; documentation search is disabled')
    return false
  }
  return true
}



async function ensureInitialized(): Promise<void> {
  if (knowledgeBase.length > 0) {
    return
  }

  if (initializationPromise) {
    return initializationPromise
  }

  initializationPromise = buildKnowledgeBase()
  await initializationPromise
}

async function buildKnowledgeBase(): Promise<void> {
  if (!ensureAPIKey()) {
    knowledgeBase = []
    return
  }

  const cache = await loadCache()
  const updatedDocuments: Record<string, CacheEntry> = {}
  const chunks: KnowledgeChunk[] = []

  const docFiles = await discoverMarkdownFiles(DOCS_DIR)

  for (const doc of docFiles) {
    const { path: docPath, title, content } = doc
    const checksum = crypto.createHash('sha256').update(content).digest('hex')
    const cacheEntry = cache.documents[docPath]

    let chunkEmbeddings: CacheChunk[]

    const docChunks = chunkMarkdown(content, title)

    if (cacheEntry && cacheEntry.checksum === checksum && cacheEntry.chunks.length === docChunks.length) {
      chunkEmbeddings = cacheEntry.chunks
      logger.server.debug('Using cached embeddings for documentation file', { path: docPath })
    } else {
      logger.server.info('Generating embeddings for documentation file', {
        path: docPath,
        chunks: docChunks.length
      })
      chunkEmbeddings = await generateEmbeddings(docChunks)
    }

    updatedDocuments[docPath] = {
      checksum,
      chunks: chunkEmbeddings,
      title
    }

    chunkEmbeddings.forEach((chunk, idx) => {
      const source = `docs/${docPath.replace(/\\/g, '/')}`
      chunks.push({
        id: `${docPath}#${idx}`,
        docPath,
        title,
        text: chunk.text,
        embedding: chunk.embedding,
        chunkIndex: idx,
        source
      })
    })
  }

  knowledgeBase = chunks

  await persistCache({
    version: 1,
    embedding_model: EMBEDDING_MODEL,
    documents: updatedDocuments
  })

  logger.server.info('Documentation knowledge base initialized', {
    documents: Object.keys(updatedDocuments).length,
    chunks: knowledgeBase.length,
    embeddingModel: EMBEDDING_MODEL
  })
}

async function loadCache(): Promise<CacheFile> {
  try {
    const raw = await readFile(ragCachePath(), 'utf-8')
    const parsed = JSON.parse(raw) as CacheFile

    if (!parsed || parsed.embedding_model !== EMBEDDING_MODEL) {
      return { version: 1, embedding_model: EMBEDDING_MODEL, documents: {} }
    }

    return parsed
  } catch {
    return { version: 1, embedding_model: EMBEDDING_MODEL, documents: {} }
  }
}

async function persistCache(cache: CacheFile): Promise<void> {
  await mkdir(dirname(ragCachePath()), { recursive: true })
  await writeFile(ragCachePath(), JSON.stringify(cache, null, 2), 'utf-8')
}

interface DocFile {
  path: string
  title: string
  content: string
}

async function discoverMarkdownFiles(dir: string, relative = ''): Promise<DocFile[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: DocFile[] = []

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    const relPath = relative ? join(relative, entry.name) : entry.name

    if (entry.isDirectory()) {
      const nested = await discoverMarkdownFiles(fullPath, relPath)
      files.push(...nested)
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const content = await readFile(fullPath, 'utf-8')
      const title = extractTitle(content, entry.name)
      files.push({ path: relPath, title, content })
    }
  }

  return files
}

function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m)
  if (match) {
    return match[1].trim()
  }
  return fallback.replace(/\.md$/i, '')
}

function chunkMarkdown(content: string, title: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n').trim()
  if (!normalized) {
    return []
  }

  const paragraphs = normalized.split(/\n{2,}/)
  const chunks: string[] = []
  let buffer = ''

  const pushBuffer = () => {
    const trimmed = buffer.trim()
    if (trimmed.length >= MIN_CHARS) {
      chunks.push(trimmed)
    }
    buffer = ''
  }

  for (const paragraph of paragraphs) {
    const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph
    if (candidate.length >= TARGET_CHARS) {
      pushBuffer()
      if (paragraph.length >= TARGET_CHARS) {
        const parts = splitLargeParagraph(paragraph)
        for (const part of parts) {
          if (part.length >= MIN_CHARS) {
            chunks.push(part.trim())
          }
        }
      } else {
        buffer = paragraph
      }
    } else {
      buffer = candidate
    }
  }

  if (buffer.length >= MIN_CHARS || (buffer && !chunks.length)) {
    pushBuffer()
  }

  return chunks.map((chunk) => `${title}\n\n${chunk}`)
}

function splitLargeParagraph(paragraph: string): string[] {
  const sentences = paragraph.split(/(?<=[.!?])\s+/)
  const parts: string[] = []
  let buffer = ''

  const pushBuffer = () => {
    const trimmed = buffer.trim()
    if (trimmed) {
      parts.push(trimmed)
    }
    buffer = ''
  }

  for (const sentence of sentences) {
    if ((buffer + ' ' + sentence).length > TARGET_CHARS && buffer.length > MIN_CHARS) {
      pushBuffer()
    }
    buffer = buffer ? `${buffer} ${sentence}` : sentence
  }

  if (buffer) {
    pushBuffer()
  }

  // Merge small trailing parts if needed
  if (parts.length > 1 && parts[parts.length - 1].length < MIN_CHARS) {
    const last = parts.pop() as string
    parts[parts.length - 1] = `${parts[parts.length - 1]} ${last}`.trim()
  }

  return parts
}

async function generateEmbeddings(chunks: string[]): Promise<CacheChunk[]> {
  const embeddingResults: CacheChunk[] = []
  const inputs = chunks.map((chunk) => chunk.replace(/\s+/g, ' ').trim())

  // Process in batches
  for (let i = 0; i < inputs.length; i += MAX_BATCH_SIZE) {
    const batch = inputs.slice(i, i + MAX_BATCH_SIZE)
    
    // Use AI SDK's embedMany for batch processing
    const { embeddings } = await embedMany({
      model: embeddingModel,
      values: batch
    })

    embeddings.forEach((embedding, idx) => {
      embeddingResults.push({
        text: chunks[i + idx],
        embedding
      })
    })
  }

  return embeddingResults
}

export async function searchDocumentation(query: string, limit = 5, category?: string): Promise<RagSearchResponse> {
  if (!query || !query.trim()) {
    return { documents: [], query: '', total_results: 0 }
  }

  await ensureInitialized()

  if (!knowledgeBase.length) {
    return { documents: [], query, total_results: 0 }
  }

  const apiKey = ensureAPIKey()
  if (!apiKey) {
    return { documents: [], query, total_results: 0 }
  }

  const sanitizedQuery = category ? `${category}: ${query}` : query
  
  // Use AI SDK's embed for single query
  const { embedding: queryEmbedding } = await embed({
    model: embeddingModel,
    value: sanitizedQuery.replace(/\s+/g, ' ').trim()
  })

  if (!queryEmbedding) {
    logger.server.warn('Failed to generate query embedding for documentation search', { query })
    return { documents: [], query, total_results: 0 }
  }

  const scored = knowledgeBase
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding)
    }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => b.score - a.score)

  const top = scored.slice(0, Math.min(limit, scored.length))

  const documents: RagDocument[] = top.map(({ chunk, score }) => ({
    title: chunk.title,
    content: chunk.text,
    source: chunk.source,
    relevance_score: Number.isFinite(score) ? Number(score.toFixed(6)) : undefined,
    chunk_index: chunk.chunkIndex,
    document_path: chunk.docPath
  }))

  return {
    documents,
    query,
    total_results: documents.length
  }
}
