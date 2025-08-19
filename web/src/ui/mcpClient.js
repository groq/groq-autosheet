"use client"
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'

function sanitizeUrl(u) {
  try { return new URL(u).toString() } catch { return '' }
}

function hashString(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(16)
}

class ProxyingBrowserOAuthProvider {
  constructor(serverUrl, options = {}) {
    this.serverUrl = sanitizeUrl(serverUrl)
    this.storageKeyPrefix = options.storageKeyPrefix || 'mcp:auth'
    this.serverUrlHash = hashString(this.serverUrl)
    this.clientName = options.clientName || 'Autosheet MCP Client'
    this.clientUri = options.clientUri || (typeof window !== 'undefined' ? window.location.origin : '')
    this.callbackUrl = options.callbackUrl || (typeof window !== 'undefined' ? new URL('/oauth/callback', window.location.origin).toString() : '/oauth/callback')
    this.preventAutoAuth = !!options.preventAutoAuth
    this.onPopupWindow = options.onPopupWindow
    // For pre-registered OAuth apps (like GitHub)
    this.preRegisteredClientId = options.clientId
    this.preRegisteredClientSecret = options.clientSecret
  }
  get redirectUrl() {
    return this.callbackUrl
  }
  get clientMetadata() {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code','refresh_token'],
      response_types: ['code'],
      client_name: this.clientName,
      client_uri: this.clientUri,
    }
  }
  async clientInformation() {
    // If pre-registered client credentials are provided, use them
    if (this.preRegisteredClientId) {
      return {
        client_id: this.preRegisteredClientId,
        client_secret: this.preRegisteredClientSecret,
        // GitHub doesn't require client_secret for public clients
        token_endpoint_auth_method: this.preRegisteredClientSecret ? 'client_secret_post' : 'none',
      }
    }
    // Otherwise, check for dynamically registered client
    const key = this._key('client_info')
    const raw = localStorage.getItem(key)
    if (!raw) return undefined
    try { return JSON.parse(raw) } catch { localStorage.removeItem(key); return undefined }
  }
  async saveClientInformation(info) {
    localStorage.setItem(this._key('client_info'), JSON.stringify(info))
  }
  async tokens() {
    const key = this._key('tokens')
    const raw = localStorage.getItem(key)
    if (!raw) return undefined
    try { return JSON.parse(raw) } catch { localStorage.removeItem(key); return undefined }
  }
  async saveTokens(tokens) {
    localStorage.setItem(this._key('tokens'), JSON.stringify(tokens))
    localStorage.removeItem(this._key('code_verifier'))
    localStorage.removeItem(this._key('last_auth_url'))
  }
  async saveCodeVerifier(verifier) {
    localStorage.setItem(this._key('code_verifier'), verifier)
  }
  async codeVerifier() {
    const v = localStorage.getItem(this._key('code_verifier'))
    if (!v) throw new Error(`[${this.storageKeyPrefix}] Missing code_verifier`)
    return v
  }
  async prepareAuthorizationUrl(authorizationUrl) {
    const state = crypto.randomUUID()
    const stateKey = `${this.storageKeyPrefix}:state_${state}`
    const stateData = {
      serverUrlHash: this.serverUrlHash,
      expiry: Date.now() + 10 * 60 * 1000,
      providerOptions: {
        serverUrl: this.serverUrl,
        storageKeyPrefix: this.storageKeyPrefix,
        clientName: this.clientName,
        clientUri: this.clientUri,
        callbackUrl: this.callbackUrl,
      },
    }
    localStorage.setItem(stateKey, JSON.stringify(stateData))
    authorizationUrl.searchParams.set('state', state)
    const urlStr = authorizationUrl.toString()
    localStorage.setItem(this._key('last_auth_url'), urlStr)
    return urlStr
  }
  async redirectToAuthorization(authorizationUrl) {
    if (this.preventAutoAuth) return
    const urlStr = await this.prepareAuthorizationUrl(authorizationUrl)
    const features = 'width=600,height=700,resizable=yes,scrollbars=yes,status=yes'
    try {
      const popup = window.open(urlStr, `mcp_auth_${this.serverUrlHash}`, features)
      if (this.onPopupWindow) this.onPopupWindow(urlStr, features, popup)
      if (popup && !popup.closed) popup.focus()
    } catch {}
  }
  getLastAttemptedAuthUrl() {
    return localStorage.getItem(this._key('last_auth_url'))
  }
  clearStorage() {
    const prefixPattern = `${this.storageKeyPrefix}_${this.serverUrlHash}_`
    const statePattern = `${this.storageKeyPrefix}:state_`
    const remove = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k) continue
      if (k.startsWith(prefixPattern)) remove.push(k)
      else if (k.startsWith(statePattern)) {
        try {
          const s = localStorage.getItem(k)
          if (s) {
            const obj = JSON.parse(s)
            if (obj.serverUrlHash === this.serverUrlHash) remove.push(k)
          }
        } catch {}
      }
    }
    let count = 0
    for (const k of new Set(remove)) { localStorage.removeItem(k); count++ }
    return count
  }
  _key(suffix) { return `${this.storageKeyPrefix}_${this.serverUrlHash}_${suffix}` }
}



async function proxyFetch(input, init = {}) {
  let urlStr = ''
  if (typeof input === 'string') urlStr = input
  else if (input && typeof input.url === 'string') urlStr = input.url
  else if (input && typeof input.href === 'string') urlStr = input.href
  else {
    try { urlStr = String(input) } catch { urlStr = '' }
  }
  
  // Check if URL is already proxied to avoid double-proxying
  try {
    const curOrigin = typeof window !== 'undefined' ? window.location.origin : ''
    const abs = new URL(urlStr, curOrigin)
    if (abs.origin === curOrigin && abs.pathname.startsWith('/api/proxy')) {
      // Already proxied, use as-is
      return fetch(abs.toString(), init)
    }
  } catch {}
  
  // Only proxy absolute HTTP(S) URLs
  let absolute = ''
  try {
    const u = new URL(urlStr)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      // Not HTTP(S), don't proxy
      return fetch(urlStr, init)
    }
    absolute = u.toString()
  } catch {
    // Not an absolute URL; use normal fetch (likely internal path)
    return fetch(urlStr, init)
  }
  
    const target = `/api/proxy?target=${encodeURIComponent(absolute)}`
  const method = init.method || (typeof input === 'object' && input.method) || 'GET'
  const headers = new Headers(init.headers || (typeof input === 'object' && input.headers) || {})
  // Don't send body for GET/HEAD requests
  const body = (method === 'GET' || method === 'HEAD') ? undefined :
    (init.body || (typeof input === 'object' && input.body) || undefined)

  const response = await fetch(target, { method, headers, body })
  
  // Debug OAuth metadata responses
  if (absolute.includes('.well-known/oauth')) {
    const clonedResponse = response.clone()
    try {
      const text = await clonedResponse.text()
      console.log('[proxyFetch] OAuth metadata response:', {
        url: absolute,
        status: response.status,
        bodyLength: text.length,
        bodyPreview: text.substring(0, 250)
      })
    } catch (e) {
      console.log('[proxyFetch] Could not read OAuth response:', e)
    }
  }
  
  return response
}

export function useMcpClient(options) {
  const {
    url,
    clientName,
    clientUri,
    callbackUrl = (typeof window !== 'undefined' ? new URL('/oauth/callback', window.location.origin).toString() : '/oauth/callback'),
    storageKeyPrefix = 'mcp:auth',
    customHeaders = {},
    autoReconnect = 3000,
    autoRetry = false,
    transportType = 'auto',
    preventAutoAuth = false,
    clientConfig = {},
  } = options || {}

  const [state, setState] = useState('discovering')
  const [tools, setTools] = useState([])
  const [error, setError] = useState(undefined)
  const [authUrl, setAuthUrl] = useState(undefined)

  const clientRef = useRef(null)
  const transportRef = useRef(null)
  const providerRef = useRef(null)
  const connectingRef = useRef(false)
  const isMountedRef = useRef(true)
  const stateRef = useRef(state)

  useEffect(() => { stateRef.current = state }, [state])



  const disconnect = useCallback(async () => {
    connectingRef.current = false
    const t = transportRef.current
    transportRef.current = null
    clientRef.current = null
    if (t && t.close) { try { await t.close() } catch {} }
    if (isMountedRef.current) {
      setState('discovering')
      setTools([])
      setError(undefined)
      setAuthUrl(undefined)
    }
  }, [])

  const ensureProvider = useCallback(() => {
    if (!providerRef.current || providerRef.current.serverUrl !== url) {
      // Check if this is GitHub and we have a client ID configured
      let clientId = undefined
      if (url.includes('githubcopilot')) {
        // Try to get GitHub OAuth client ID from localStorage
        clientId = localStorage.getItem('github_oauth_client_id')
        if (!clientId) {
          console.log('[MCP] GitHub Copilot requires a pre-registered OAuth app.')
          console.log('[MCP] Please create one at: https://github.com/settings/applications/new')
          console.log('[MCP] Then set it with: localStorage.setItem("github_oauth_client_id", "YOUR_CLIENT_ID")')
        }
      }
      
      providerRef.current = new ProxyingBrowserOAuthProvider(url, {
        storageKeyPrefix,
        clientName,
        clientUri,
        callbackUrl,
        preventAutoAuth,
        clientId,
      })
    }
    return providerRef.current
  }, [url, storageKeyPrefix, clientName, clientUri, callbackUrl, preventAutoAuth])

  const connect = useCallback(async () => {
    if (connectingRef.current) return
    connectingRef.current = true
    setError(undefined)
    setAuthUrl(undefined)
    setState('connecting')
    try {
      ensureProvider()
      if (!clientRef.current) {
        clientRef.current = new Client({ name: clientConfig.name || 'autosheet-mcp', version: clientConfig.version || '0.1.0' }, { capabilities: {} })
      }
      const tryWith = async (mode) => {
        if (transportRef.current) { try { await transportRef.current.close() } catch {} transportRef.current = null }
        // Use raw server URL, let proxyFetch handle the proxying
        const serverUrl = new URL(url)
        
        // For OAuth discovery, we need to use the origin only (no path)
        // The SDK incorrectly appends the server path to discovery URLs
        const resourceMetadataUrl = new URL('/.well-known/oauth-protected-resource', serverUrl.origin).toString()
        
        // Transport config with proxyFetch for ALL network requests
        const transportConfig = {
          authProvider: providerRef.current,
          requestInit: {
            headers: {
              Accept: 'application/json, text/event-stream',
              ...customHeaders,
            },
          },
          // Use proxyFetch for all transport and auth requests
          fetch: proxyFetch,
        }
        const t = mode === 'http' ? new StreamableHTTPClientTransport(serverUrl, transportConfig) : new SSEClientTransport(serverUrl, transportConfig)
        
        // Monkey-patch the transport to use the correct resource metadata URL
        // The SDK doesn't accept this in options, so we have to set it manually
        t._resourceMetadataUrl = resourceMetadataUrl
        
        // Also override the _authThenStart method to ensure it uses our resourceMetadataUrl
        const originalAuthThenStart = t._authThenStart
        if (originalAuthThenStart) {
          t._authThenStart = async function() {
            // Ensure our resourceMetadataUrl is set before calling the original method
            this._resourceMetadataUrl = resourceMetadataUrl
            return originalAuthThenStart.call(this)
          }
        }
        
        transportRef.current = t
        t.onmessage = (msg) => { 
          console.log('[MCP] Transport message:', msg)
          // The SSE transport already parses messages, just pass them through
          clientRef.current?.handleMessage?.(msg)
        }
        t.onerror = (e) => { 
          console.warn(`Transport error for ${mode}:`, e)
          // Don't propagate 405 errors for streamable HTTP - it's expected when SSE isn't supported
          if (mode === 'http' && e && e.code === 405) return
          // Check if this is an auth error that should trigger OAuth
          const errorMsg = e && (e.message || String(e))
          if (errorMsg && (errorMsg.includes('401') || errorMsg.includes('Unauthorized') || errorMsg.includes('Authorization header') || errorMsg.includes('JSON'))) {
            console.log(`[MCP ${mode}] Auth error detected in transport, will trigger OAuth`)
            // Don't log the full error, it will be handled by the catch block
            return
          }
          // Log more details about the error
          if (e) {
            console.error(`[MCP ${mode}] Transport error details:`, {
              code: e.code,
              message: e.message,
              error: e,
              url: url,
              state: stateRef.current
            })
          }
        }
        t.onclose = () => {
          if (!isMountedRef.current) return
          if (state !== 'ready') return
          if (autoReconnect) setTimeout(() => { isMountedRef.current && connect() }, typeof autoReconnect === 'number' ? autoReconnect : 3000)
        }
        
        try {
          console.log(`[MCP] Connecting client with ${mode} transport...`)
          await clientRef.current.connect(t)
          console.log(`[MCP] Client connected with ${mode} transport, state:`, clientRef.current)
          setState('loading')
        } catch (connectError) {
          const errorMsg = connectError && (connectError.message || String(connectError))
          console.log(`[MCP] Connection failed during connect:`, errorMsg)
          // Check if this is an auth-related error
          if (errorMsg && (errorMsg.includes('401') || errorMsg.includes('Unauthorized') || errorMsg.includes('Authorization') || errorMsg.includes('JSON'))) {
            throw new Error('AUTH_REQUIRED')
          }
          throw connectError
        }
      }

      if (transportType === 'http') {
        try {
          await tryWith('http')
        } catch (e) {
          const msg = e && (e.message || String(e))
          if (String(msg).includes('405')) {
            await tryWith('sse')
          } else {
            throw e
          }
        }
      } else if (transportType === 'sse') {
        await tryWith('sse')
      } else {
        try { await tryWith('http') } catch { await tryWith('sse') }
      }

      // Load tools with timeout
      console.log('[MCP] Requesting tools list...')
      try {
        // Add a timeout for the tools request
        const toolsPromise = clientRef.current.listTools()
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Tools request timed out after 10s')), 10000)
        )
        
        const toolsResp = await Promise.race([toolsPromise, timeoutPromise])
        console.log('[MCP] Tools response:', toolsResp)
        if (isMountedRef.current) {
          setTools(toolsResp.tools || [])
          setState('ready')
          console.log(`[MCP] Connection ready with ${(toolsResp.tools || []).length} tools`)
        }
      } catch (toolsError) {
        console.error('[MCP] Failed to load tools:', toolsError)
        throw toolsError
      }
    } catch (e) {
      const msg = e && (e.message || String(e))
      console.log('[MCP] Connection error:', msg, 'Full error:', e)
      
      // Special handling for GitHub's lack of dynamic registration
      if (String(msg).includes('does not support dynamic client registration')) {
        console.error('[MCP] GitHub OAuth Setup Required:')
        console.log('1. Go to https://github.com/settings/applications/new')
        console.log('2. Create an OAuth App with:')
        console.log('   - Homepage URL: http://localhost:3000')
        console.log('   - Callback URL: http://localhost:3000/oauth/callback')
        console.log('3. Copy the Client ID and run in console:')
        console.log('   localStorage.setItem("github_oauth_client_id", "YOUR_CLIENT_ID")')
        console.log('4. Reload the page and try connecting again')
        setState('failed')
        setError('GitHub OAuth app registration required. See console for instructions.')
        return
      }
      
      // Check for various 401/auth error patterns, including JSON parse errors on auth responses
      if (e instanceof UnauthorizedError || 
          String(msg).includes('AUTH_REQUIRED') ||
          String(msg).includes('401') || 
          String(msg).includes('Unauthorized') ||
          String(msg).includes('missing required Authorization header') ||
          (String(msg).includes('JSON') && String(msg).includes('parse'))) {
        console.log('[MCP] Auth error detected, starting OAuth flow...')
        try {
          setState('authenticating')
          // GitHub Copilot uses /mcp/ path in its OAuth metadata URLs
          // The SDK should extract this from the WWW-Authenticate header, but for manual auth
          // we need to provide the correct URL
          let resourceMetadataUrl
          if (url.includes('githubcopilot')) {
            // GitHub Copilot specific path
            resourceMetadataUrl = 'https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/'
          } else {
            // Default pattern for other servers
            const serverOrigin = new URL(url).origin
            resourceMetadataUrl = new URL('/.well-known/oauth-protected-resource', serverOrigin).toString()
          }
          console.log('[MCP] Attempting OAuth with resourceMetadataUrl:', resourceMetadataUrl)
          const result = await auth(ensureProvider(), {
            serverUrl: url,
            resourceMetadataUrl,
            fetchFn: proxyFetch
          })
          console.log('[MCP] Auth result:', result)
          if (!isMountedRef.current) return
          if (result === 'AUTHORIZED') {
            connectingRef.current = false
            connect()
            return
          }
          if (result === 'REDIRECT') {
            // Wait for popup callback listener to reconnect
            const authUrl = providerRef.current.getLastAttemptedAuthUrl?.()
            console.log('[MCP] OAuth redirect required, auth URL:', authUrl)
            setAuthUrl(authUrl)
            // Open the auth URL in a popup
            if (authUrl && typeof window !== 'undefined') {
              const popup = window.open(authUrl, 'mcp_oauth', 'width=800,height=600')
              if (popup) {
                providerRef.current.onPopupWindow?.(popup)
              }
            }
            return
          }
        } catch (authErr) {
          console.error('[MCP] OAuth failed:', authErr)
          if (isMountedRef.current) {
            setState('failed')
            const errorMsg = authErr && (authErr.message || String(authErr))
            setError(errorMsg)
            // If it's a registration error, provide more context
            if (errorMsg && errorMsg.includes('register')) {
              console.log('[MCP] Note: This server may require pre-registered OAuth clients. Dynamic registration failed.')
            }
          }
          return
        }
      }
      if (isMountedRef.current) {
        setState('failed')
        setError(msg)
      }
    } finally {
      connectingRef.current = false
    }
  }, [url, transportType, autoReconnect, customHeaders, clientConfig, ensureProvider, state])

    const authenticate = useCallback(async () => {
    try {
      setState('authenticating')
      // GitHub Copilot uses /mcp/ path in its OAuth metadata URLs
      let resourceMetadataUrl
      if (url.includes('githubcopilot')) {
        // GitHub Copilot specific path
        resourceMetadataUrl = 'https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/'
      } else {
        // Default pattern for other servers
        const serverOrigin = new URL(url).origin
        resourceMetadataUrl = new URL('/.well-known/oauth-protected-resource', serverOrigin).toString()
      }
      console.log('[MCP] Manual auth triggered, resourceMetadataUrl:', resourceMetadataUrl)
      const res = await auth(ensureProvider(), {
        serverUrl: url,
        resourceMetadataUrl,
        fetchFn: proxyFetch
      })
      console.log('[MCP] Manual auth result:', res)
      if (!isMountedRef.current) return
      if (res === 'AUTHORIZED') {
        connect()
      } else if (res === 'REDIRECT') {
        const authUrl = providerRef.current.getLastAttemptedAuthUrl?.()
        console.log('[MCP] Manual auth redirect, URL:', authUrl)
        setAuthUrl(authUrl)
        // Open the auth URL in a popup
        if (authUrl && typeof window !== 'undefined') {
          const popup = window.open(authUrl, 'mcp_oauth', 'width=800,height=600')
          if (popup) {
            providerRef.current.onPopupWindow?.(popup)
          }
        }
      }
    } catch (e) {
      console.error('[MCP] Manual auth failed:', e)
      if (isMountedRef.current) { setState('failed'); setError(e && (e.message || String(e))) }
    }
  }, [url, ensureProvider, connect])

  const callTool = useCallback(async (name, args) => {
    if (!clientRef.current) throw new Error('MCP client not connected')
    return clientRef.current.callTool({ name, arguments: args })
  }, [])

  const retry = useCallback(() => { if (stateRef.current === 'failed') connect() }, [connect])

  useEffect(() => {
    isMountedRef.current = true
    connect()
    return () => { isMountedRef.current = false; disconnect() }
  }, [url])

  useEffect(() => {
    const handler = (event) => {
      if (event.origin !== (typeof window !== 'undefined' ? window.location.origin : '')) return
      if (event.data?.type === 'mcp_auth_callback') {
        console.log('[MCP] Received auth callback:', event.data)
        if (event.data.success) {
          console.log('[MCP] Auth successful, reconnecting...')
          // Reset state and reconnect with auth
          setState('connecting')
          setError(undefined)
          connect()
        } else {
          setState('failed')
          setError(event.data.error || 'Authentication failed')
        }
      }
    }
    if (typeof window !== 'undefined') window.addEventListener('message', handler)
    return () => { if (typeof window !== 'undefined') window.removeEventListener('message', handler) }
  }, [connect])

  return { state, tools, error, authUrl, callTool, retry, disconnect, authenticate }
}

export { ProxyingBrowserOAuthProvider, proxyFetch }


