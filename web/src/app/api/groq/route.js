import { NextResponse } from 'next/server'
import { ALLOWED_MODELS } from './allowedModels.js'

const BASE = 'https://api.groq.com/openai/v1'

export const runtime = 'nodejs'

function sanitizeHeaders(headers) {
  const out = new Headers()
  for (const [key, value] of headers) {
    const lower = String(key).toLowerCase()
    if (lower === 'content-encoding' || lower === 'transfer-encoding') continue
    let v = String(value).replace(/[\u00B5\u03BC]/g, 'us')
    if (!/^[\x00-\x7F]*$/.test(v)) continue
    out.set(key, v)
  }
  return out
}

export async function POST(req) {
  try {
    const url = new URL(req.url)
    // Support sub-path forwarding: /api/groq/chat/completions → /openai/v1/chat/completions
    const forwardPath = url.pathname.replace(/^.*\/api\/groq/, '') || ''
    // Only allow chat completions; block other paths like /models
    const allowed = forwardPath === '/chat/completions' || forwardPath === ''
    if (!allowed) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    const target = `${BASE}${'/chat/completions'}`
    const apiKey = process.env.GROQ_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing GROQ_API_KEY' }, { status: 500 })
    }
    const bodyText = await req.text()
    let model
    try {
      model = JSON.parse(bodyText)?.model
    } catch {}
    if (!ALLOWED_MODELS.has(String(model))) {
      return NextResponse.json({ error: 'Model not allowed' }, { status: 400 })
    }
    const res = await fetch(target, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: bodyText,
    })
    // Pass through status and stream if present
    const headers = sanitizeHeaders(res.headers)
    headers.set('access-control-allow-origin', '*')
    headers.set('access-control-allow-methods', 'POST, OPTIONS')
    headers.set('access-control-allow-headers', 'authorization, content-type')
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    })
  } catch (err) {
    return NextResponse.json({ error: String(err && (err.message || err)) }, { status: 500 })
  }
}

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


