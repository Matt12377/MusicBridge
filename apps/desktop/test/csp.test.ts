import assert from 'node:assert/strict'
import test from 'node:test'

import { buildContentSecurityPolicy } from '../src/main/security.js'

test('development and production CSP are local-only and never use unsafe-eval', () => {
  for (const mode of ['development', 'production'] as const) {
    const csp = buildContentSecurityPolicy(mode)

    assert.match(csp, /default-src 'self'/)
    assert.match(csp, /script-src 'self'/)
    assert.match(csp, /object-src 'none'/)
    assert.match(csp, /connect-src 'self'/)
    assert.match(csp, /img-src 'self' blob: data: https:\/\/\*\.music\.126\.net/)
    assert.doesNotMatch(csp, /unsafe-eval/)
    assert.doesNotMatch(csp, /connect-src[^;]*https?:\/\//)
    assert.doesNotMatch(csp, /font-src[^;]*https?:\/\//)
  }
})
