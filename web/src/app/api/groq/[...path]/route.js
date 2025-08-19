import { NextResponse } from 'next/server'

// Use the root API base; the client SDK supplies '/openai/v1/...'
const BASE = 'https://api.groq.com'
export const runtime = 'nodejs'

async function forward(req) {
  try {
    const apiKey = process.env.GROQ_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'Missing GROQ_API_KEY' }, { status: 500 })
    const url = new URL(req.url)
    const relative = url.pathname.replace(/^.*\/api\/groq/, '') || '/'
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
    const out = new Headers(res.headers)
    out.delete('content-encoding')
    out.delete('transfer-encoding')
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
  } catch (err) {
    return NextResponse.json({ error: String(err && (err.message || err)) }, { status: 500 })
  }
}

export const GET = forward
export const POST = forward
export const PUT = forward
export const DELETE = forward
export const PATCH = forward
export const HEAD = forward
export const OPTIONS = forward


