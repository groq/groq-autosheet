import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { POST as groqProxy } from '../web/src/app/api/groq/[...path]/route.js'

const originalFetch = global.fetch

describe('Groq proxy model enforcement', () => {
  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test-key'
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('rejects requests with disallowed model', async () => {
    const req = new Request('http://example.com/api/groq/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'invalid', messages: [] }),
    })
    const res = await groqProxy(req)
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBeDefined()
  })

  it('allows requests with approved model', async () => {
    global.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    const req = new Request('http://example.com/api/groq/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-oss-20b', messages: [] }),
    })
    const res = await groqProxy(req)
    expect(res.status).toBe(200)
  })
})
