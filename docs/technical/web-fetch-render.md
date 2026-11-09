# web_fetch rendered mode (Android)

Status: draft spec, 2026-11-09. Builds on the plain-fetch `web_fetch` tool
(`src/renderer/packages/model-calls/toolsets/web-fetch.ts`).

## Problem

`web_fetch` does a native HTTP GET plus Readability. SPA and web-component pages return an empty
shell (`<div id="root">`) because no JavaScript runs, so shadow DOM content never exists.

## Goal / user story

As a Chatbox Android user, when the model reads a JS-rendered page, it gets the rendered text and
an accessibility-style outline (including open shadow roots), with no MCP server and no paid
parse_link provider.

## Out of scope

- iOS (needs a WKWebView twin of the plugin; same TS contract).
- Interaction (click/type), logins, cookies shared with the user's browser, screenshots.
- Closed shadow roots (unreachable from page scripts by design).

## Design

### 1. Tool contract (TS, renderer)

`web_fetch` input gains `render?: 'auto' | 'always' | 'never'` (default `auto`).

- `never`: current behaviour.
- `always`: skip the plain fetch, render.
- `auto`: plain fetch first; render if any holds:
  - extracted text < 200 chars, or
  - HTML contains an SPA shell marker (`id="root"|"app"|"__next"` with < 200 chars of text,
    `<noscript>` mentioning JavaScript), or
  - content type is HTML and the HTTP layer succeeded but Readability returned nothing.
- Render is only attempted when `platform.type === 'mobile'` and the native plugin reports
  available; otherwise return the plain result.

Output adds `mode: 'fetch' | 'render'` and, for render, `outline` (snapshot lines) alongside
`content` (readable text). Same truncation rules (`maxLength` applies to `content + outline`).

### 2. Native plugin `WebRender` (Kotlin, Capacitor 7)

Location: `android/app/src/main/java/.../webrender/WebRenderPlugin.kt`, registered in
`MainActivity`. TS wrapper: `src/renderer/native/web-render.ts` via `registerPlugin('WebRender')`.

```ts
render(opts: {
  url: string
  script: string          // JS expression evaluated after settle; must return JSON-serializable
  settleMs?: number       // DOM quiet window, default 800
  timeoutMs?: number      // hard cap, default 15000, max 30000
}): Promise<{ finalUrl: string; title: string; result: unknown }>
cancel(): Promise<void>
```

Behaviour:
- One WebView per call, created on the main thread, **not attached to the view hierarchy**
  (size forced via `layout(0,0,1280,2400)` so layout-dependent pages render). Destroyed in
  `finally` (`stopLoading`, `removeAllViews`, `destroy`).
- Settings: JS on, DOM storage on, no file/content access, no `addJavascriptInterface`,
  mixed content blocked, separate (incognito) cookie handling — cookies cleared after call.
  Desktop-class user agent off (mobile UA keeps pages lighter).
- `shouldOverrideUrlLoading`: allow http/https only; block `intent:`, custom schemes, downloads.
- Settle detection: after `onPageFinished`, inject a MutationObserver that resolves when no
  mutations for `settleMs` (and `document.readyState === 'complete'`); bounded by `timeoutMs`.
- Then `evaluateJavascript(script)`; the result string is JSON-parsed in Kotlin and returned.
- On timeout: still run `script` on whatever rendered (partial result, `timedOut: true`).
- Concurrency: at most 2 live WebViews; extra calls queue. `cancel()` / JS AbortSignal destroys.

### 3. Snapshot script reuse

`pageSnapshotSource()` (`src/main/built-in-browser/page-snapshot.ts:71`) is a pure string builder
that already walks open shadow roots. `node:crypto` is only used at line 304 (view id), outside
the source. Move `PAGE_REFS_SOURCE`, `pageSnapshotSource`, and constants to
`src/shared/page-snapshot-source.ts`; desktop re-exports from there (no behaviour change, its
tests must still pass). The render script = snapshot outline + `document.body.innerText`
(innerText does not pierce shadow roots, so text is also collected by a shadow-aware walker).

## Acceptance criteria

1. Unit: `auto` triggers render for an SPA shell fixture and not for an article fixture.
2. Unit: render path output formatting, truncation, and fallback to plain result when plugin
   unavailable or errors.
3. Desktop `page-snapshot.test.ts` passes unchanged after the move.
4. Device (manual, documented with logcat + screenshot of chat):
   - a React SPA page returns its rendered text,
   - a page with open-shadow-root web components returns text from inside them,
   - a never-settling page returns a partial result in ≤ 15 s,
   - an `intent:` redirect is blocked.
5. No WebView leak: 20 sequential renders, `adb shell dumpsys meminfo` WebView count back to
   baseline.

## Verification plan

`pnpm exec vitest run` on the new/moved test files; `tsc --noEmit`; `npx cap sync android` +
`gradlew assembleDebug`; install on device, run criteria 4–5, capture output.

## Open questions

- Should rendered fetches be allowed with web browsing off? (Current answer: no, same gate.)
- Prompt the user before rendering a page (privacy: JS runs from arbitrary sites)? Default: no,
  matches a browser visit; no cookies are shared with the user's browser.
