import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

function sanitizeTarget(t) {
  try {
    const u = new URL(t)
    // Disallow loopback to our own internal APIs
    if (u.origin === 'null') throw new Error('Invalid URL')
    return u.toString()
  } catch {
    throw new Error('Invalid target URL')
  }
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

    // Forward method, headers and body with strict header allowlist
    const method = req.method
    const body = method === 'GET' || method === 'HEAD' ? undefined : req.body
    const incoming = req.headers
    const forwardedHeaders = new Headers()
    const allow = new Set([
      'accept',
      'authorization',
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

    // For SSE GET, avoid sending a body and keep headers; for POST allow body
    const isGet = method === 'GET'
    const fetchInit = isGet ? { method, headers: forwardedHeaders } : { method, headers: forwardedHeaders, body, duplex: 'half' }
    const res = await fetch(targetUrl, fetchInit)
    
    // Debug log for specific URLs
    if (targetUrl.includes('.well-known/oauth')) {
      console.log('[proxy] Fetched OAuth URL:', {
        url: targetUrl,
        status: res.status,
        contentLength: res.headers.get('content-length'),
        contentType: res.headers.get('content-type')
      })
    }

    // Debug logging for 401 responses (only for debugging, don't consume body in production)
    if (res.status === 401 && targetUrl.includes('githubcopilot')) {
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
    const contentType = res.headers.get('content-type')
    if (contentType && (contentType.includes('application/json') || contentType.includes('text/'))) {
      const text = await res.text()
      // Debug logging for OAuth responses
      if (targetUrl.includes('.well-known/oauth')) {
        console.log('[proxy] OAuth response:', {
          url: targetUrl,
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
    
    // For other content types, stream the response
    const headers = new Headers(res.headers)
    headers.delete('content-encoding')
    headers.delete('transfer-encoding')
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  } catch (err) {
    return NextResponse.json({ error: String(err && (err.message || err)) }, { status: 500 })
  }
}


