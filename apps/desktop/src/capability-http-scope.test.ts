import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { URLPattern } from 'urlpattern-polyfill'

/**
 * Pins the URLPattern semantics of the `http:default` capability scope.
 * tauri-plugin-http matches request URLs with the same WHATWG URLPattern
 * spec (the Rust `urlpattern` crate), and the spec has a port trap: a
 * pattern that omits the port only matches the scheme's default port, so
 * `https://*` would never cover `http://localhost:1234` (LM Studio) or an
 * https endpoint on a custom port. The wildcard entries must stay spelled
 * `https://*:*` / `http://*:*`.
 */

interface ScopeEntry {
  url: string
}

interface Permission {
  identifier: string
  allow: ScopeEntry[]
}

const capability = JSON.parse(
  readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'),
) as { permissions: (string | Permission)[] }

const httpPermission = capability.permissions.find(
  (permission): permission is Permission =>
    typeof permission === 'object' && permission.identifier === 'http:default',
)

const patterns = (httpPermission?.allow ?? []).map((entry) => new URLPattern(entry.url))

function allowed(url: string): boolean {
  return patterns.some((pattern) => pattern.test(url))
}

describe('http:default capability scope', () => {
  it('reaches OpenAI-compatible endpoints on custom ports and hosts', () => {
    // LM Studio's default endpoint.
    expect(allowed('http://localhost:1234/v1/chat/completions')).toBe(true)
    // Ollama's default endpoint.
    expect(allowed('http://127.0.0.1:11434/v1/models')).toBe(true)
    // A LAN inference server.
    expect(allowed('http://192.168.1.10:8000/v1/models')).toBe(true)
    expect(allowed('https://llm.example.com/v1/chat/completions')).toBe(true)
    expect(allowed('https://llm.example.com:8443/v1/chat/completions')).toBe(true)
  })

  it('still reaches the built-in provider and GitHub endpoints', () => {
    expect(allowed('https://api.openai.com/v1/responses')).toBe(true)
    expect(allowed('https://api.anthropic.com/v1/messages')).toBe(true)
    expect(allowed('https://generativelanguage.googleapis.com/v1beta/models')).toBe(true)
    expect(allowed('https://openrouter.ai/api/v1/chat/completions')).toBe(true)
    expect(allowed('https://github.com/login/device/code')).toBe(true)
    expect(allowed('https://api.github.com/user')).toBe(true)
  })

  it('does not open non-http schemes', () => {
    expect(allowed('file:///etc/passwd')).toBe(false)
    expect(allowed('ftp://example.com/file')).toBe(false)
    expect(allowed('ws://localhost:1234/socket')).toBe(false)
  })
})
