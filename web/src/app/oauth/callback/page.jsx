"use client"
import React, { useEffect, useRef } from 'react'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { ProxyingBrowserOAuthProvider, proxyFetch } from '../../../ui/mcpClient.js'

export default function OAuthCallback() {
  const [status, setStatus] = React.useState('processing')
  const [error, setError] = React.useState(null)
  const processedRef = useRef(false)
  
  useEffect(() => {
    if (processedRef.current) return // Prevent double execution in StrictMode
    processedRef.current = true
    
    ;(async () => {
      const params = new URLSearchParams(window.location.search)
      const code = params.get('code')
      const state = params.get('state')
      const error = params.get('error')
      const errorDescription = params.get('error_description')
      const logPrefix = '[mcp-callback]'
      try {
        if (error) throw new Error(`OAuth error: ${error} - ${errorDescription || ''}`)
        if (!code) throw new Error('Missing authorization code')
        if (!state) throw new Error('Missing state')
        
        // Try to find the state with any prefix pattern
        // The state might be stored as mcp:auth:state_... or mcp:autosheet:N:state_...
        let storedStateJSON = null
        let stateKey = null
        
        // First try the default pattern
        stateKey = `mcp:auth:state_${state}`
        storedStateJSON = localStorage.getItem(stateKey)
        
        // If not found, search for it with other prefixes
        if (!storedStateJSON) {
          const allKeys = Object.keys(localStorage)
          const possibleKeys = allKeys.filter(k => k.includes(`:state_${state}`))
          console.log(`${logPrefix} Looking for state ${state}, found possible keys:`, possibleKeys)
          
          if (possibleKeys.length > 0) {
            stateKey = possibleKeys[0]
            storedStateJSON = localStorage.getItem(stateKey)
          }
        }
        
        if (!storedStateJSON) {
          const allStateKeys = Object.keys(localStorage).filter(k => k.includes(':state_'))
          console.log(`${logPrefix} State ${state} not found. Available state keys:`, allStateKeys)
          throw new Error('Invalid or expired state')
        }
        let stored
        try { stored = JSON.parse(storedStateJSON) } catch { throw new Error('Corrupt stored state') }
        if (!stored.expiry || stored.expiry < Date.now()) {
          localStorage.removeItem(stateKey)
          throw new Error('State expired')
        }
        const { providerOptions } = stored || {}
        const serverUrl = providerOptions?.serverUrl
        if (!serverUrl) throw new Error('Missing serverUrl in state')
        const provider = new ProxyingBrowserOAuthProvider(serverUrl, providerOptions || {})
        console.log(`${logPrefix} Exchanging code for token...`)
        const result = await auth(provider, { serverUrl, authorizationCode: code, fetchFn: proxyFetch })
        console.log(`${logPrefix} Auth result:`, result)
        if (result === 'AUTHORIZED') {
          localStorage.removeItem(stateKey)
          setStatus('success')
          if (window.opener && !window.opener.closed) {
            console.log(`${logPrefix} Sending success message to opener`)
            window.opener.postMessage({ type: 'mcp_auth_callback', success: true }, window.location.origin)
            setTimeout(() => window.close(), 100)
          } else {
            console.log(`${logPrefix} No opener, redirecting to home`)
            setTimeout(() => { window.location.href = '/' }, 1000)
          }
        } else {
          throw new Error(`Unexpected auth result: ${result}`)
        }
      } catch (err) {
        console.error(`${logPrefix} Error:`, err)
        const errorMsg = String(err && (err.message || err))
        setStatus('error')
        setError(errorMsg)
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({ type: 'mcp_auth_callback', success: false, error: errorMsg }, window.location.origin)
        }
      }
    })()
  }, [])
  
  return (
    <div style={{ padding: 20 }}>
      <h1>OAuth Callback</h1>
      {status === 'processing' && <p>Completing authentication… You can close this window.</p>}
      {status === 'success' && <p>Authentication successful! This window will close automatically.</p>}
      {status === 'error' && (
        <div>
          <p style={{ color: 'red' }}>Authentication failed:</p>
          <pre style={{ background: '#f5f5f5', padding: 10, borderRadius: 4 }}>{error}</pre>
          <p>You can close this window and try again.</p>
        </div>
      )}
    </div>
  )
}


