import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function GET(req) {
  // This route is a placeholder for future server-side auth exchanges if needed.
  // Currently, `use-mcp` completes auth on the client and uses window opener messaging.
  return NextResponse.json({ ok: true })
}


