import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { GET as proxyGet, POST as proxyPost } from '../web/src/app/api/proxy/route.js'

const originalFetch = global.fetch
const originalAllowedHosts = process.env.MCP_PROXY_ALLOWED_HOSTS
const originalExaApiKey = process.env.EXA_API_KEY

describe('MCP proxy target enforcement', () => {
  beforeEach(() => {
    delete process.env.MCP_PROXY_ALLOWED_HOSTS
    process.env.EXA_API_KEY = 'server-exa-key'
    global.fetch = vi.fn(async () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }))
  })

  afterEach(() => {
    global.fetch = originalFetch
    process.env.MCP_PROXY_ALLOWED_HOSTS = originalAllowedHosts
    process.env.EXA_API_KEY = originalExaApiKey
  })

  it('rejects arbitrary external targets', async () => {
    const req = new Request('http://autosheet.local/api/proxy?target=https%3A%2F%2Fexample.com%2Fmetadata')
    const res = await proxyGet(req)

    expect(res.status).toBe(400)
    expect(global.fetch).not.toHaveBeenCalled()
    await expect(res.json()).resolves.toMatchObject({ error: 'Target host is not allowed' })
  })

  it('rejects non-HTTPS allowed hosts', async () => {
    const req = new Request('http://autosheet.local/api/proxy?target=http%3A%2F%2Fmcp.exa.ai%2Fmcp')
    const res = await proxyGet(req)

    expect(res.status).toBe(400)
    expect(global.fetch).not.toHaveBeenCalled()
    await expect(res.json()).resolves.toMatchObject({ error: 'Target URL must use HTTPS' })
  })

  it('proxies the allowlisted Exa MCP target without forwarding caller authorization', async () => {
    const target = encodeURIComponent('https://mcp.exa.ai/mcp?exaApiKey=<token>')
    const req = new Request(`http://autosheet.local/api/proxy?target=${target}`, {
      headers: {
        accept: 'text/event-stream',
        authorization: 'Bearer caller-secret',
        'mcp-session-id': 'session-1',
      },
    })

    const res = await proxyGet(req)

    expect(res.status).toBe(200)
    expect(global.fetch).toHaveBeenCalledTimes(1)

    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toBe('https://mcp.exa.ai/mcp?exaApiKey=server-exa-key')
    expect(init.redirect).toBe('manual')
    expect(init.headers.get('accept')).toBe('text/event-stream')
    expect(init.headers.get('mcp-session-id')).toBe('session-1')
    expect(init.headers.has('authorization')).toBe(false)
  })

  it('rejects upstream redirects instead of following them server-side', async () => {
    global.fetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    }))
    const target = encodeURIComponent('https://mcp.exa.ai/mcp')
    const req = new Request(`http://autosheet.local/api/proxy?target=${target}`)

    const res = await proxyGet(req)

    expect(res.status).toBe(502)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch.mock.calls[0][1].redirect).toBe('manual')
    await expect(res.json()).resolves.toMatchObject({ error: 'Upstream redirects are not allowed' })
  })

  it('uses explicit proxy host configuration when provided', async () => {
    process.env.MCP_PROXY_ALLOWED_HOSTS = 'mcp.example.test'
    const target = encodeURIComponent('https://mcp.example.test/messages')
    const req = new Request(`http://autosheet.local/api/proxy?target=${target}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0"}',
    })

    const res = await proxyPost(req)

    expect(res.status).toBe(200)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch.mock.calls[0][0]).toBe('https://mcp.example.test/messages')
    expect(global.fetch.mock.calls[0][1].headers.get('content-type')).toBe('application/json')
  })
})
