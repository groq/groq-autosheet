import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

const DEFAULT_ALLOWED_PROXY_HOSTS = ['mcp.exa.ai']

class ProxyError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

function getAllowedProxyHosts() {
  const configuredHosts = process.env.MCP_PROXY_ALLOWED_HOSTS
  const hosts = configuredHosts ? configuredHosts.split(',') : DEFAULT_ALLOWED_PROXY_HOSTS
  return new Set(
    hosts
      .map((host) => String(host).trim().toLowerCase())
      .filter(Boolean)
  )
}

function sanitizeTarget(t) {
  let u
  try {
    u = new URL(t)
  } catch {
    throw new ProxyError('Invalid target URL')
  }

  if (u.protocol !== 'https:') {
    throw new ProxyError('Target URL must use HTTPS')
  }
  if (u.username || u.password) {
    throw new ProxyError('Target URL must not contain credentials')
  }

  const allowedHosts = getAllowedProxyHosts()
  if (!allowedHosts.has(u.hostname.toLowerCase())) {
    throw new ProxyError('Target host is not allowed')
  }

  return u.toString()
}

export async function GET(req) {
  return handleProxy(req)
}

export async function POST(req) {
  return handleProxy(req)
}

export async function OPTIONS() {
  return new Response(null, { status: 204 })
}

async function handleProxy(req) {
  try {
    const url = new URL(req.url)
    const target = url.searchParams.get('target')
    if (!target) return NextResponse.json({ error: 'Missing target' }, { status: 400 })
    const targetUrl = sanitizeTarget(target)

    // Magic substitution for Exa MCP default token
    // If the target is the Exa MCP endpoint and exaApiKey is set to the magic value
    // replace it with the server-side EXA_API_KEY to avoid exposing secrets client-side
    let finalTargetUrl = targetUrl
    try {
      const u = new URL(finalTargetUrl)
      if (u.hostname === 'mcp.exa.ai') {
        const exaApiKeyParam = u.searchParams.get('exaApiKey')
        if (exaApiKeyParam === '<token>') {
          const envKey = process.env.EXA_API_KEY
          if (envKey && typeof envKey === 'string' && envKey.length > 0) {
            u.searchParams.set('exaApiKey', envKey)
            finalTargetUrl = u.toString()
          }
        }
      }
    } catch {}

    // Forward method, headers and body with strict header allowlist
    const method = req.method
    // For debugging 5xx errors, we need to read the body first if it's a POST
    let body = undefined
    let bodyText = undefined
    if (method !== 'GET' && method !== 'HEAD') {
      if (method === 'POST') {
        // Read the body for potential debugging
        try {
          bodyText = await req.text()
          body = bodyText
        } catch {
          body = req.body
        }
      } else {
        body = req.body
      }
    }
    const incoming = req.headers
    const forwardedHeaders = new Headers()
    const allow = new Set([
      'accept',
      'content-type',
      'mcp-session-id',
      'mcp-transport',
      'mcp-protocol-version',
      'x-mcp-session-id',
    ])
    for (const [k, v] of incoming) {
      const key = String(k).toLowerCase()
      if (!allow.has(key)) continue
      if ((method === 'GET' || method === 'HEAD') && key === 'content-type') continue
      forwardedHeaders.set(key, v)
    }

    // For GET, avoid sending a body and keep headers; for POST allow body
    // Important for event-stream endpoints (e.g., SSE or other Streamable HTTP)
    const isGet = method === 'GET'
    const fetchInit = isGet
      ? { method, headers: forwardedHeaders, redirect: 'manual' }
      : { method, headers: forwardedHeaders, body, duplex: 'half', redirect: 'manual' }
    const res = await fetch(finalTargetUrl, fetchInit)

    if (res.status >= 300 && res.status < 400) {
      return NextResponse.json({ error: 'Upstream redirects are not allowed' }, { status: 502 })
    }
    
    // Get content type for various checks
    const contentType = res.headers.get('content-type')
    
    // Debug event-stream connections (SSE or other Streamable HTTP)
    if (contentType && contentType.includes('text/event-stream')) {
      console.log('[proxy] Event-stream connection established (SSE or Streamable HTTP):', {
        url: finalTargetUrl,
        status: res.status,
        contentType,
        headers: Object.fromEntries(res.headers.entries())
      })
    }
    
    // Debug log for specific URLs
    if (finalTargetUrl.includes('.well-known/oauth')) {
      console.log('[proxy] Fetched OAuth URL:', {
        url: finalTargetUrl,
        status: res.status,
        contentLength: res.headers.get('content-length'),
        contentType
      })
    }

    // Debug logging for upstream 5xx responses
    if (res.status >= 500) {
      if (!contentType || !contentType.includes('text/event-stream')) {
        let text = ''
        try {
          text = await res.text()
        } catch (e) {
          // ignore read errors, still return original status
        }
        
        console.error('[proxy] Upstream 5xx error:', {
          url: finalTargetUrl,
          method,
          status: res.status,
          contentType,
          requestHeaders: Object.fromEntries(forwardedHeaders.entries()),
          requestBody: bodyText ? bodyText.substring(0, 1000) : '[No body]',
          responseBody: text.substring(0, 2000)
        })
        const headers = new Headers(res.headers)
        headers.delete('content-encoding')
        headers.delete('transfer-encoding')
        headers.set('content-length', String(text.length))
        return new Response(text, { status: res.status, statusText: res.statusText, headers })
      } else {
        console.error('[proxy] Upstream 5xx error with event-stream content-type; streaming without buffering', {
          url: targetUrl,
          status: res.status,
          contentType
        })
      }
    }

    // Debug logging for 401 responses (only for debugging, don't consume body in production)
    if (res.status === 401 && finalTargetUrl.includes('githubcopilot')) {
      const text = await res.text()
      console.log('[proxy] 401 response from GitHub Copilot:', {
        status: res.status,
        contentType: res.headers.get('content-type'),
        bodyLength: text.length,
        body: text.substring(0, 300)
      })
      const headers = new Headers(res.headers)
      headers.delete('content-encoding')
      headers.delete('transfer-encoding')
      // Update content-length to match actual text length
      headers.set('content-length', String(text.length))
      return new Response(text, { status: res.status, statusText: res.statusText, headers })
    }

    // For non-streaming responses, fully consume the body to avoid truncation issues
    // This is especially important for JSON responses
    // IMPORTANT: Don't buffer text/event-stream responses — these are event streams (SSE or other Streamable HTTP) and need to stream!
    const shouldBuffer = contentType && (
      contentType.includes('application/json') || 
      (contentType.includes('text/') && !contentType.includes('text/event-stream'))
    )
    if (shouldBuffer) {
      const text = await res.text()
      // Debug logging for OAuth responses
      if (finalTargetUrl.includes('.well-known/oauth')) {
        console.log('[proxy] OAuth response:', {
          url: finalTargetUrl,
          contentType,
          textLength: text.length,
          preview: text.substring(0, 100) + '...',
          last100: '...' + text.substring(text.length - 100)
        })
      }
      const headers = new Headers(res.headers)
      headers.delete('content-encoding')
      headers.delete('transfer-encoding')
      // Update content-length to match actual text length
      headers.set('content-length', String(text.length))
      return new Response(text, { status: res.status, statusText: res.statusText, headers })
    }
    
    // For other content types (including text/event-stream), stream the response
    const headers = new Headers(res.headers)
    headers.delete('content-encoding')
    headers.delete('transfer-encoding')
    
    // Log when streaming event-stream
    if (contentType && contentType.includes('text/event-stream')) {
      console.log('[proxy] Streaming text/event-stream response to client')
    }
    
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  } catch (err) {
    return NextResponse.json({ error: String(err && (err.message || err)) }, { status: err && err.status ? err.status : 500 })
  }
}

