import { NextResponse } from 'next/server'

const BASE = 'https://api.groq.com/openai/v1'

export const runtime = 'nodejs'

export async function POST(req) {
  try {
    const url = new URL(req.url)
    // Support sub-path forwarding: /api/groq/chat/completions → /openai/v1/chat/completions
    const forwardPath = url.pathname.replace(/^.*\/api\/groq/, '') || ''
    const target = `${BASE}${forwardPath || '/chat/completions'}`
    const apiKey = process.env.GROQ_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing GROQ_API_KEY' }, { status: 500 })
    }
    const body = await req.text()
    const res = await fetch(target, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    })
    // Pass through status and stream if present
    const headers = new Headers(res.headers)
    headers.delete('content-encoding')
    headers.delete('transfer-encoding')
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    })
  } catch (err) {
    return NextResponse.json({ error: String(err && (err.message || err)) }, { status: 500 })
  }
}


