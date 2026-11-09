// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/native/native-fetch', () => ({ nativeFetch: vi.fn() }))

import { fetchWebPage } from './web-fetch'

function fakeFetch(body: string, init: { status?: number; contentType?: string; url?: string } = {}) {
  return vi.fn(async () => {
    const res = new Response(body, {
      status: init.status ?? 200,
      headers: init.contentType === undefined ? { 'content-type': 'text/html' } : { 'content-type': init.contentType },
    })
    if (init.url) Object.defineProperty(res, 'url', { value: init.url })
    return res
  }) as unknown as typeof fetch
}

const ARTICLE = `<!doctype html><html><head><title>Doc Title</title><script>evil()</script></head><body>
<nav>Home | About</nav><article><h1>Headline</h1>${'<p>The quick brown fox jumps over the lazy dog. '.repeat(40)}</p></article>
</body></html>`

describe('fetchWebPage', () => {
  it('extracts readable text and title from HTML', async () => {
    const result = await fetchWebPage({ url: 'https://example.com/a' }, undefined, fakeFetch(ARTICLE))
    expect(result.title).toBe('Doc Title')
    expect(result.content).toContain('quick brown fox')
    expect(result.content).not.toContain('evil()')
    expect(result.url).toBe('https://example.com/a')
  })

  it('returns plain text and JSON bodies as-is', async () => {
    const result = await fetchWebPage(
      { url: 'https://api.example.com/x' },
      undefined,
      fakeFetch('{"ok":true}', { contentType: 'application/json' })
    )
    expect(result.content).toBe('{"ok":true}')
  })

  it('truncates to maxLength and reports the original length', async () => {
    const result = await fetchWebPage(
      { url: 'https://example.com/t', maxLength: 500 },
      undefined,
      fakeFetch('x'.repeat(2000), { contentType: 'text/plain' })
    )
    expect(result.content).toHaveLength(500)
    expect(result.originalLength).toBe(2000)
    expect(result.truncated).toBe(true)
  })

  it('reports the final URL after redirects', async () => {
    const result = await fetchWebPage(
      { url: 'https://short.link/1' },
      undefined,
      fakeFetch('hi', { contentType: 'text/plain', url: 'https://example.com/final' })
    )
    expect(result.url).toBe('https://example.com/final')
  })

  it('rejects non-http schemes without fetching', async () => {
    const fetcher = fakeFetch('')
    await expect(fetchWebPage({ url: 'file:///etc/passwd' }, undefined, fetcher)).rejects.toThrow(/http and https/)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('surfaces HTTP errors and binary content types', async () => {
    await expect(
      fetchWebPage({ url: 'https://example.com/404' }, undefined, fakeFetch('nope', { status: 404 }))
    ).rejects.toThrow(/HTTP 404/)
    await expect(
      fetchWebPage({ url: 'https://example.com/i.png' }, undefined, fakeFetch('x', { contentType: 'image/png' }))
    ).rejects.toThrow(/Unsupported content type/)
  })
})
