import { NextResponse } from 'next/server'

// Use the root API base; the client SDK supplies '/openai/v1/...'
const BASE = 'https://api.groq.com'
export const runtime = 'nodejs'

function sanitizeHeaders(headers) {
  const out = new Headers()
  for (const [key, value] of headers) {
    const lower = String(key).toLowerCase()
    if (lower === 'content-encoding' || lower === 'transfer-encoding') continue
    // Replace common non-ASCII micro symbol with ASCII 'us'
    let v = String(value).replace(/[\u00B5\u03BC]/g, 'us')
    // Drop any headers that still contain non-ASCII
    if (!/^[\x00-\x7F]*$/.test(v)) continue
    out.set(key, v)
  }
  return out
}

async function forward(req) {
  try {
    const apiKey = process.env.GROQ_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'Missing GROQ_API_KEY' }, { status: 500 })
    const url = new URL(req.url)
    const relative = url.pathname.replace(/^.*\/api\/groq/, '') || '/'
    // Only allow chat completions, deny everything else (e.g., /models)
    const allowed = relative === '/openai/v1/chat/completions' || relative === '/chat/completions'
    if (!allowed) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    const target = `${BASE}${relative}${url.search}`
    const headers = new Headers(req.headers)
    headers.set('authorization', `Bearer ${apiKey}`)
    headers.set('content-type', 'application/json')
    headers.delete('host')
    headers.delete('content-length')
    const res = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
      duplex: 'half',
    })
    const out = sanitizeHeaders(res.headers)
    // CORS headers (safe for same-origin and helpful for tools)
    out.set('access-control-allow-origin', '*')
    out.set('access-control-allow-methods', 'POST, OPTIONS')
    out.set('access-control-allow-headers', 'authorization, content-type')
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
  } catch (err) {
    return NextResponse.json({ error: String(err && (err.message || err)) }, { status: 500 })
  }
}

export const POST = forward

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
    },
  })
}


