import { Readability } from '@mozilla/readability'
import { validatedToolSchema } from '@shared/validated-tool-schema'
import type { ToolSet } from 'ai'
import { nativeFetch } from '@/native/native-fetch'
import { asRecord, numberField, stringField, toTextModelOutput } from './model-output'

export const WEB_FETCH_TOOL_NAME = 'web_fetch'

const DEFAULT_MAX_CHARS = 12_000
const MIN_MAX_CHARS = 500
const MAX_MAX_CHARS = 100_000
const MAX_BODY_BYTES = 5 * 1024 * 1024
const TEXTUAL_TYPE = /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json|javascript))/i

export interface WebFetchResult {
  url: string
  title: string
  contentType: string
  content: string
  originalLength: number
  truncated: boolean
}

/** Turns an HTML document into readable text: Readability article first, whole body as fallback. */
export function extractReadableText(html: string, url: string): { title: string; text: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const base = doc.createElement('base')
  base.href = url
  doc.head?.prepend(base)
  const fallbackTitle = doc.title?.trim() ?? ''
  try {
    const article = new Readability(doc.cloneNode(true) as Document).parse()
    const text = article?.textContent?.replace(/\n{3,}/g, '\n\n').trim()
    if (text) return { title: article?.title?.trim() || fallbackTitle, text }
  } catch {
    // fall through to raw body text
  }
  doc.querySelectorAll('script,style,noscript,template,svg').forEach((el) => el.remove())
  const text = (doc.body?.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
  return { title: fallbackTitle, text }
}

export async function fetchWebPage(
  input: { url: string; maxLength?: number },
  abortSignal: AbortSignal | undefined,
  fetcher: typeof fetch = nativeFetch
): Promise<WebFetchResult> {
  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    throw new Error(`Invalid URL: ${input.url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http and https URLs can be fetched, got ${parsed.protocol}`)
  }
  const maxLength = Math.min(Math.max(input.maxLength ?? DEFAULT_MAX_CHARS, MIN_MAX_CHARS), MAX_MAX_CHARS)

  const response = await fetcher(parsed.href, {
    method: 'GET',
    redirect: 'follow',
    signal: abortSignal,
    headers: {
      Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
    },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${parsed.href}`)

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (contentType && !TEXTUAL_TYPE.test(contentType)) {
    throw new Error(`Unsupported content type "${contentType}"; web_fetch only reads text and HTML pages`)
  }
  const declaredLength = Number(response.headers.get('content-length'))
  if (declaredLength > MAX_BODY_BYTES) {
    throw new Error(`Response too large (${declaredLength} bytes, limit ${MAX_BODY_BYTES})`)
  }
  const body = await response.text()
  if (body.length > MAX_BODY_BYTES) throw new Error(`Response too large (limit ${MAX_BODY_BYTES} bytes)`)

  const finalUrl = response.url || parsed.href
  const isHtml = !contentType || contentType.includes('html') || /^\s*<(!doctype html|html)/i.test(body)
  const { title, text } = isHtml ? extractReadableText(body, finalUrl) : { title: '', text: body.trim() }
  const content = text.slice(0, maxLength)
  return {
    url: finalUrl,
    title,
    contentType: contentType || 'text/html',
    content,
    originalLength: text.length,
    truncated: text.length > content.length,
  }
}

function formatWebFetchOutput(output: unknown): string {
  const record = asRecord(output)
  const error = stringField(record, 'error')
  if (error) return `Error: ${error}`
  const title = stringField(record, 'title')
  const url = stringField(record, 'url')
  const content = stringField(record, 'content') ?? ''
  const originalLength = numberField(record, 'originalLength')
  const header = [title ? `Title: ${title}` : undefined, url ? `URL: ${url}` : undefined, 'Content:']
    .filter(Boolean)
    .join('\n')
  const hint =
    record?.truncated === true && originalLength !== undefined
      ? `\n\n[Content truncated. Showing ${content.length} of ${originalLength} characters. Call again with a larger maxLength for more.]`
      : ''
  return `${header}\n${content}${hint}`
}

/** Fetches a URL directly from the device (native HTTP, no CORS, no MCP server or search provider). */
export const webFetchTool: ToolSet[string] = {
  description:
    'Fetches a web page or text URL directly from the device and returns its readable text. Use it to read a URL the user shared or one returned by web_search.',
  inputSchema: validatedToolSchema({
    type: 'object',
    properties: {
      url: {
        type: 'string',
        format: 'uri',
        description: 'The http or https URL to fetch, including the scheme, e.g. https://example.com',
      },
      maxLength: {
        type: 'integer',
        minimum: MIN_MAX_CHARS,
        maximum: MAX_MAX_CHARS,
        description: `Optional maximum number of characters to return (default ${DEFAULT_MAX_CHARS}).`,
      },
    },
    required: ['url'],
    additionalProperties: false,
  }),
  execute: async (input, { abortSignal }) => fetchWebPage(input as { url: string; maxLength?: number }, abortSignal),
  toModelOutput: toTextModelOutput(formatWebFetchOutput),
}
