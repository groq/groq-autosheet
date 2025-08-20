"use client"
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Groq from 'groq-sdk'
import { useMcpClient } from './mcpClient.js'
import { getSpreadsheetTools, isSpreadsheetToolName, runSpreadsheetTool } from './spreadsheetMcp.js'

function McpConnector({ index, name, url, transport, onSnapshot }) {
  if (transport !== 'http' && transport !== 'sse') return null
  const conn = useMcpClient({
    url,
    clientName: 'Autosheet',
    storageKeyPrefix: `mcp:autosheet:${index}`,
    callbackUrl: (typeof window !== 'undefined' ? window.location.origin : '') + '/oauth/callback',
    autoReconnect: true,
    autoRetry: false,
    preventAutoAuth: false,
    transportType: transport,
  })
  useEffect(() => {
    onSnapshot(index, {
      name: name || `Server ${index + 1}`,
      url: url || '',
      enabled: true,
      state: conn.state,
      tools: conn.tools,
      error: conn.error,
      authUrl: conn.authUrl,
      retry: conn.retry,
      authenticate: conn.authenticate,
      callTool: conn.callTool,
    })
  }, [index, name, url, conn.state, conn.tools, conn.error, conn.authUrl, onSnapshot])
  return null
}

const SYSTEM_PROMPT_STORAGE_KEY = 'autosheet.chat.systemPrompt'
const MODEL_STORAGE_KEY = 'autosheet.chat.model'
const MCP_SERVERS_STORAGE_KEY = 'autosheet.mcp.servers'
// Transport is per-server; stored on each item in MCP_SERVERS_STORAGE_KEY
// Multiple MCP servers supported
const CHATS_STORAGE_KEY = 'autosheet.chats.v1'
const ACTIVE_CHAT_ID_STORAGE_KEY = 'autosheet.chats.activeId'

function createNewChat(title) {
  const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(16) + Math.random().toString(16).slice(2))
  return {
    id,
    title: title || 'New chat',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  }
}

function getNextChatTitle(existingChats) {
  let maxNum = 0
  try {
    for (const c of (Array.isArray(existingChats) ? existingChats : [])) {
      const t = c && c.title ? String(c.title) : ''
      const m = /^\s*Chat\s+(\d+)\s*$/i.exec(t)
      if (m) {
        const n = Number(m[1])
        if (Number.isFinite(n) && n > maxNum) maxNum = n
      }
    }
  } catch {}
  const next = (maxNum || 0) + 1
  return `Chat ${next}`
}

export default function Chat({ engine, activeSheet, onEngineMutated }) {
  const [systemPrompt, setSystemPrompt] = useState(() => {
    try {
      return localStorage.getItem(SYSTEM_PROMPT_STORAGE_KEY) || 'You are a helpful assistant.'
    } catch { return 'You are a helpful assistant.' }
  })
  const [model, setModel] = useState(() => {
    try { return localStorage.getItem(MODEL_STORAGE_KEY) || 'openai/gpt-oss-20b' } catch { return 'openai/gpt-oss-20b' }
  })
  const [chats, setChats] = useState(() => {
    try {
      const raw = localStorage.getItem(CHATS_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          return parsed.map((c) => ({
            id: c && c.id ? c.id : (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(16) + Math.random().toString(16).slice(2))),
            title: c && c.title ? String(c.title) : 'New chat',
            createdAt: Number(c && c.createdAt) || Date.now(),
            updatedAt: Number(c && c.updatedAt) || Date.now(),
            messages: Array.isArray(c && c.messages) ? c.messages : [],
          }))
        }
      }
    } catch {}
    return [createNewChat('Chat 1')]
  })
  const [activeChatId, setActiveChatId] = useState(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_CHAT_ID_STORAGE_KEY)
      if (saved) return saved
    } catch {}
    try {
      const raw = localStorage.getItem(CHATS_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed[0] && parsed[0].id) return parsed[0].id
      }
    } catch {}
    return null
  })
  const activeChatIndex = useMemo(() => chats.findIndex((c) => c && c.id === activeChatId) , [chats, activeChatId])
  const messages = useMemo(() => (activeChatIndex >= 0 ? (chats[activeChatIndex].messages || []) : (chats[0] ? chats[0].messages || [] : [])), [chats, activeChatIndex])
  const setMessages = useCallback((updater) => {
    setChats((prev) => {
      const idx = prev.findIndex((c) => c && c.id === (activeChatId || (prev[0] && prev[0].id)))
      if (idx === -1) return prev
      const current = prev[idx]
      const prevMsgs = Array.isArray(current.messages) ? current.messages : []
      const nextMsgs = typeof updater === 'function' ? updater(prevMsgs) : updater
      const updated = prev.slice()
      updated[idx] = {
        ...current,
        messages: nextMsgs,
        updatedAt: Date.now(),
      }
      return updated
    })
  }, [activeChatId])
  const [userInput, setUserInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Settings dialog drafts
  const [draftSystemPrompt, setDraftSystemPrompt] = useState('')
  const [draftModel, setDraftModel] = useState('openai/gpt-oss-20b')
  // no global transport; per-server instead
  const [mcpServers, setMcpServers] = useState(() => {
    try {
      const raw = localStorage.getItem(MCP_SERVERS_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          return parsed.map((s) => ({
            name: s?.name || 'MCP',
            url: s?.url || '',
            enabled: s?.enabled !== false,
            transport: s?.transport || 'http',
          }))
        }
      }
    } catch {}
    return []
  })
  // Track live MCP connector snapshots
  const mcpSnapshotsRef = useRef([])
  const [mcpSnapshotsVersion, setMcpSnapshotsVersion] = useState(0)
  const upsertMcpSnapshot = useCallback((index, snapshot) => {
    const arr = Array.isArray(mcpSnapshotsRef.current) ? mcpSnapshotsRef.current.slice() : []
    arr[index] = { index, ...snapshot }
    mcpSnapshotsRef.current = arr
    setMcpSnapshotsVersion((v) => v + 1)
  }, [])

  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)
  const backdropMouseDownRef = useRef(false)
  const scrollToBottom = useCallback(() => {
    const el = messagesEndRef.current
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [])
  useEffect(() => { scrollToBottom() }, [messages, scrollToBottom])

  const groq = useMemo(() => {
    try {
      const origin = typeof window !== 'undefined' ? window.location.origin : ''
      const baseURL = origin ? `${origin}/api/groq` : '/api/groq'
      return new Groq({ apiKey: 'dummy', baseURL, dangerouslyAllowBrowser: true })
    } catch {
      return null
    }
  }, [])

  // Keep snapshots bounded to current server list length (trim removed indices)
  useEffect(() => {
    const arr = Array.isArray(mcpSnapshotsRef.current) ? mcpSnapshotsRef.current.slice(0, mcpServers.length) : []
    mcpSnapshotsRef.current = arr
    setMcpSnapshotsVersion((v) => v + 1)
  }, [mcpServers.length])

  // Reflect disabled servers in snapshots immediately so UI and tool list are accurate
  useEffect(() => {
    for (let i = 0; i < mcpServers.length; i++) {
      const srv = mcpServers[i]
      if (srv?.enabled === false) {
        upsertMcpSnapshot(i, {
          name: srv?.name || `Server ${i + 1}`,
          url: srv?.url || '',
          enabled: false,
          state: 'disabled',
          tools: [],
          error: undefined,
          authUrl: undefined,
          retry: undefined,
          authenticate: undefined,
          callTool: undefined,
        })
      }
    }
  }, [mcpServers, upsertMcpSnapshot])

  const spreadsheetTools = useMemo(() => getSpreadsheetTools(), [])

  // Build tool list from Spreadsheet tools + current snapshots
  const toolsDef = useMemo(() => {
    const snapshots = Array.isArray(mcpSnapshotsRef.current) ? mcpSnapshotsRef.current : []
    const merged = [...spreadsheetTools]
    for (let i = 0; i < snapshots.length; i++) {
      const snap = snapshots[i]
      const toolList = Array.isArray(snap?.tools) ? snap.tools : []
      for (const t of toolList) {
        merged.push({
          type: 'function',
          function: {
            name: t?.name,
            description: t?.description || '',
            parameters: t?.inputSchema || { type: 'object', properties: {} },
          },
          __serverIndex: i,
        })
      }
    }
    return merged
  }, [mcpSnapshotsVersion, spreadsheetTools])

  const saveSystemPrompt = useCallback((val) => {
    try { localStorage.setItem(SYSTEM_PROMPT_STORAGE_KEY, val) } catch {}
  }, [])

  // Persist chats and active chat id
  useEffect(() => {
    try { localStorage.setItem(CHATS_STORAGE_KEY, JSON.stringify(chats)) } catch {}
  }, [chats])
  useEffect(() => {
    const id = activeChatId || (chats[0] && chats[0].id) || ''
    try { localStorage.setItem(ACTIVE_CHAT_ID_STORAGE_KEY, id) } catch {}
  }, [activeChatId, chats])

  const handleNewChat = useCallback(() => {
    const chat = createNewChat(getNextChatTitle(chats))
    setChats((prev) => [chat, ...prev])
    setActiveChatId(chat.id)
    setUserInput('')
    setError(null)
  }, [chats])

  const handleDeleteChat = useCallback(() => {
    if (isStreaming) return
    try {
      if (typeof window !== 'undefined') {
        const ok = window.confirm('Delete this chat? This cannot be undone.')
        if (!ok) return
      }
    } catch {}
    const idToDelete = activeChatId || (chats[0] && chats[0].id)
    const idx = chats.findIndex((c) => c && c.id === idToDelete)
    const nextArr = chats.filter((c) => c && c.id !== idToDelete)
    if (nextArr.length === 0) {
      const newChat = createNewChat(getNextChatTitle(nextArr))
      setChats([newChat])
      setActiveChatId(newChat.id)
    } else {
      let nextActive = null
      if (idx !== -1) nextActive = (chats[idx + 1] || chats[idx - 1] || null)
      if (!nextActive) nextActive = nextArr[0]
      setChats(nextArr)
      setActiveChatId(nextActive && nextActive.id ? nextActive.id : nextArr[0].id)
    }
    setUserInput('')
    setError(null)
  }, [isStreaming, activeChatId, chats])

  const openSettings = useCallback(() => {
    setDraftSystemPrompt(systemPrompt)
    setDraftModel(model)
    
    setSettingsOpen(true)
  }, [systemPrompt, model])

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
  }, [])

  // Close on Escape only when settings are open
  useEffect(() => {
    if (!settingsOpen) return
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeSettings()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settingsOpen, closeSettings])

  const saveSettings = useCallback(() => {
    try { localStorage.setItem(SYSTEM_PROMPT_STORAGE_KEY, draftSystemPrompt) } catch {}
    try { localStorage.setItem(MODEL_STORAGE_KEY, draftModel) } catch {}
    try { localStorage.setItem(MCP_SERVERS_STORAGE_KEY, JSON.stringify(mcpServers)) } catch {}
    setSystemPrompt(draftSystemPrompt)
    setModel(draftModel)
    setSettingsOpen(false)
  }, [draftSystemPrompt, draftModel, mcpServers])

  const handleSend = useCallback(async () => {
    if (!userInput.trim()) return
    if (!groq) { setError('Chat service unavailable.'); return }
    setError(null)
    const prompt = userInput
    setUserInput('')
    // Keep focus in the textarea for rapid follow-ups
    if (inputRef.current) inputRef.current.focus()
    // Append user message and a placeholder assistant message
    setMessages((prev) => [...prev, { role: 'user', content: prompt }, { role: 'assistant', content: '' }])
    setIsStreaming(true)
    try {
      const reqMessages = []
      if (systemPrompt && systemPrompt.trim()) {
        reqMessages.push({ role: 'system', content: systemPrompt.trim() })
      }
      // Include history and the just-added user message
      const hist = [...messages, { role: 'user', content: prompt }]
      for (const m of hist) {
        const base = { role: m.role, content: m.content }
        if (m.reasoning) base.reasoning = m.reasoning
        if (m.role === 'assistant' && m.tool_calls) {
          reqMessages.push({ ...base, tool_calls: m.tool_calls })
        } else if (m.role === 'tool') {
          const toolMsg = { role: 'tool', content: m.content, tool_call_id: m.tool_call_id }
          reqMessages.push(toolMsg)
        } else {
          reqMessages.push(base)
        }
      }

      // Use a loop to allow multiple rounds of tool calls until the model stops calling tools
      const sampling = { temperature: 1, top_p: 1, max_completion_tokens: 2048, reasoning_effort: "high"}

      // Start conversation with the built request messages (system + history + user)
      const conv = reqMessages.slice()
      let round = 0
      while (true) {
        // For rounds after the first, add a fresh assistant bubble for streaming
        if (round > 0) {
          setMessages((prev) => ([...prev, { role: 'assistant', content: '', reasoning: '' }]))
        }

        const stream = await groq.chat.completions.create({
          messages: conv,
          model,
          ...sampling,
          tool_choice: 'auto',
          tools: toolsDef,
          stream: true,
        })

        // Collect tool calls for this round
        const pendingToolCallsById = new Map()
        let assistantAccumulatedContent = ''
        let assistantAccumulatedReasoning = ''
        let sawToolCalls = false

        // Helper: validate JSON quickly
        const isValidJson = (s) => {
          try { JSON.parse(s); return true } catch { return false }
        }
        // Helper: merge incremental argument fragments without duplicating full objects
        const mergeArgFragments = (existingArgs, deltaArgs) => {
          const prev = String(existingArgs || '')
          const next = String(deltaArgs || '')
          if (!prev) return next
          const candidate = prev + next
          if (isValidJson(next) && !isValidJson(candidate)) {
            return next
          }
          return candidate
        }

        for await (const chunk of stream) {
          const choice = chunk?.choices?.[0]
          const deltaObj = choice?.delta || {}
          const finish = choice?.finish_reason || null

          const contentDelta = deltaObj?.content || ''
          const reasoningDelta = deltaObj?.reasoning || ''
          if (contentDelta) {
            assistantAccumulatedContent += contentDelta
            setMessages((prev) => {
              if (prev.length === 0) return prev
              const updated = prev.slice()
              const lastIdx = updated.length - 1
              if (updated[lastIdx]?.role !== 'assistant') return updated
              updated[lastIdx] = { ...updated[lastIdx], content: (updated[lastIdx].content || '') + contentDelta }
              return updated
            })
          }
          if (reasoningDelta) {
            assistantAccumulatedReasoning += reasoningDelta
            setMessages((prev) => {
              if (prev.length === 0) return prev
              const updated = prev.slice()
              const lastIdx = updated.length - 1
              if (updated[lastIdx]?.role !== 'assistant') return updated
              updated[lastIdx] = { ...updated[lastIdx], reasoning: (updated[lastIdx].reasoning || '') + reasoningDelta }
              return updated
            })
          }

          const toolCallsDelta = deltaObj?.tool_calls || []
          if (toolCallsDelta.length > 0) {
            sawToolCalls = true
            for (const call of toolCallsDelta) {
              if (!call?.id) continue
              const existing = pendingToolCallsById.get(call.id) || call
              const merged = {
                ...existing,
                function: {
                  name: call?.function?.name || existing?.function?.name,
                  arguments: mergeArgFragments(existing?.function?.arguments, call?.function?.arguments),
                },
              }
              pendingToolCallsById.set(call.id, merged)
            }
            // Reflect partial tool_calls on the last assistant bubble for correctness
            setMessages((prev) => {
              if (prev.length === 0) return prev
              const updated = prev.slice()
              const lastIdx = updated.length - 1
              if (updated[lastIdx]?.role !== 'assistant') return updated
              const tool_calls = Array.from(pendingToolCallsById.values())
              updated[lastIdx] = { ...updated[lastIdx], tool_calls }
              return updated
            })
          }

          if (finish === 'tool_calls') {
            // The model intends to call tools; end this stream round
            break
          }
        }

        const toolCalls = Array.from(pendingToolCallsById.values())
        if (toolCalls.length === 0 && !sawToolCalls) {
          // No tool calls this round; finalize assistant content in conversation and exit loop
          conv.push({ role: 'assistant', content: assistantAccumulatedContent, reasoning: assistantAccumulatedReasoning })
          break
        }

        // Add the assistant message that requested tools to conversation
        conv.push({ role: 'assistant', content: assistantAccumulatedContent, reasoning: assistantAccumulatedReasoning, tool_calls: toolCalls })

        // Execute tools via Spreadsheet virtual server or remote MCP; add outputs to UI and conversation
        const safeParseArgs = (argStr) => {
          try { return JSON.parse(argStr || '{}') } catch {}
          const s = String(argStr || '')
          const lastStart = s.lastIndexOf('{')
          const lastEnd = s.lastIndexOf('}')
          if (lastStart !== -1 && lastEnd !== -1 && lastEnd > lastStart) {
            try { return JSON.parse(s.slice(lastStart, lastEnd + 1)) } catch {}
          }
          return {}
        }
        for (const call of toolCalls) {
          const functionName = call?.function?.name
          const toolCallId = call?.id
          const parsedArgs = safeParseArgs(call?.function?.arguments)

          let result
          try {
            // First try local spreadsheet tools
            let called = false
            if (isSpreadsheetToolName(functionName)) {
              result = await runSpreadsheetTool(functionName, parsedArgs, { engine, activeSheet, onEngineMutated })
              called = true
            }

            // If not a Spreadsheet tool, find origin connection by name across snapshots
            const snaps = Array.isArray(mcpSnapshotsRef.current) ? mcpSnapshotsRef.current : []
            for (const snap of snaps) {
              const toolList = Array.isArray(snap?.tools) ? snap.tools : []
              const found = toolList.some((t) => t?.name === functionName)
              if (found) {
                if (snap.state !== 'ready') throw new Error(`MCP server '${snap.name}' not ready (state: ${snap.state})`)
                result = await snap.callTool(functionName, parsedArgs)
                called = true
                break
              }
            }
            if (!called) throw new Error(`Unknown MCP tool: ${functionName}`)
          } catch (e) {
            result = { error: String(e && (e.message || e)) }
          }

          const content = typeof result === 'string' ? result : JSON.stringify(result)
          conv.push({ role: 'tool', content, tool_call_id: toolCallId })

          setMessages((prev) => ([
            ...prev,
            { role: 'tool', content, tool_call_id: toolCallId, name: functionName, args: parsedArgs },
          ]))
        }

        // Continue to the next round; the loop will add a fresh assistant bubble
        round += 1
      }
    } catch (err) {
      const msg = String(err && (err.message || err))
      setError(msg)
    } finally {
      setIsStreaming(false)
      // Return focus to the textarea for rapid follow-ups
      if (inputRef.current) inputRef.current.focus()
    }
  }, [groq, userInput, systemPrompt, messages, model, setMessages])

  return (
    <div className="chat-pane">
      {/* Mount one McpConnector per enabled server to establish connections */}
      {mcpServers.map((srv, i) => (
        srv.enabled !== false && srv.url ? (
          <McpConnector
            key={`conn-${i}`}
            index={i}
            name={srv.name}
            url={srv.url}
            transport={srv.transport === 'sse' ? 'sse' : 'http'}
            onSnapshot={upsertMcpSnapshot}
          />
        ) : null
      ))}
      <div className="chat-toolbar">
        <div className="chat-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <select
            className="chat-select"
            value={(activeChatIndex >= 0 ? chats[activeChatIndex].id : (chats[0] && chats[0].id)) || ''}
            onChange={(e) => setActiveChatId(e.target.value)}
            disabled={isStreaming}
            title={isStreaming ? 'Wait for response to finish before switching' : 'Select a chat'}
          >
            {chats.map((c) => (
              <option key={c.id} value={c.id}>{c.title || 'Untitled chat'}</option>
            ))}
          </select>
          <button className="btn" onClick={handleNewChat} disabled={isStreaming} title="Start a new chat">New</button>
          <button className="btn" onClick={handleDeleteChat} disabled={isStreaming || chats.length === 0} title="Delete current chat">Delete</button>
        </div>
        <div style={{ flex: 1 }} />
        <div className="mcp-status" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {(Array.isArray(mcpSnapshotsRef.current) ? mcpSnapshotsRef.current : []).map((snap, i) => (
            <div key={i} title={`${snap?.name || `Server ${i+1}`} — ${snap?.state || 'unknown'}${snap?.error ? ` — ${String(snap.error)}` : ''}`} style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: 4,
                marginRight: 6,
                background: snap?.state === 'ready' ? '#1aaa55' : snap?.state === 'failed' ? '#d33' : snap?.state === 'disabled' ? '#bbb' : '#f0ad4e',
              }} />
              <span style={{ fontSize: 12 }}>{snap?.name || `Server ${i+1}`}</span>
            </div>
          ))}
        </div>
        <button className="btn" title="Chat settings" onClick={openSettings}>⚙️</button>
      </div>

      {settingsOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.button !== 0) return
            if (e.target === e.currentTarget) backdropMouseDownRef.current = true
          }}
          onMouseUp={(e) => {
            try {
              if (e.button !== 0) return
              if (backdropMouseDownRef.current && e.target === e.currentTarget) {
                closeSettings()
              }
            } finally {
              backdropMouseDownRef.current = false
            }
          }}
        >
          <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">Chat Settings</div>
              <button className="btn" onClick={closeSettings}>✕</button>
            </div>
            <div className="modal-body">
              
              <div className="form-row">
                <label>MCP servers</label>
                <div>
                  {mcpServers.map((srv, i) => (
                    <div key={i} className="inline-input-action" style={{ marginBottom: 6 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginRight: 10 }}>
                        <input
                          type="checkbox"
                          checked={srv.enabled !== false}
                          onChange={(e) => {
                            const checked = e.target.checked
                            setMcpServers((prev) => prev.map((s, idx) => idx === i ? { ...s, enabled: checked } : s))
                          }}
                        />
                        <span style={{ fontSize: 12 }}>Enabled</span>
                      </label>
                      <input
                        type="text"
                        value={srv.name}
                        onChange={(e) => {
                          const val = e.target.value
                          setMcpServers((prev) => {
                            const next = prev.slice()
                            next[i] = { ...next[i], name: val }
                            return next
                          })
                        }}
                        placeholder="Name"
                        style={{ width: 140, marginRight: 6 }}
                      />
                      <select
                        value={srv.transport === 'sse' ? 'sse' : 'http'}
                        onChange={(e) => {
                          const t = e.target.value === 'sse' ? 'sse' : 'http'
                          setMcpServers((prev) => {
                            const next = prev.slice()
                            next[i] = { ...next[i], transport: t }
                            return next
                          })
                        }}
                        title="Transport"
                        style={{ width: 160, marginRight: 6 }}
                      >
                        <option value="http">Streamable HTTP</option>
                        <option value="sse">SSE</option>
                      </select>
                      <input
                        type="text"
                        value={srv.url}
                        onChange={(e) => {
                          const val = e.target.value
                          setMcpServers((prev) => {
                            const next = prev.slice()
                            next[i] = { ...next[i], url: val }
                            return next
                          })
                        }}
                        placeholder="https://server.example.com/mcp"
                        style={{ flex: 1 }}
                      />
                      <button type="button" className="btn" onClick={() => {
                        setMcpServers((prev) => prev.filter((_, idx) => idx !== i))
                      }}>Remove</button>
                    </div>
                  ))}
                  <div>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setMcpServers((prev) => ([...prev, { name: 'New MCP', url: '', enabled: true }]))}
                    >
                      Add server
                    </button>
                  </div>
                </div>
              </div>
              <div className="form-row">
                <label>Model</label>
                <select value={draftModel} onChange={(e) => setDraftModel(e.target.value)}>
                  <option value="openai/gpt-oss-20b">OpenAI GPT-OSS 20B</option>
                  <option value="openai/gpt-oss-120b">OpenAI GPT-OSS 120B</option>
                </select>
                <div style={{ marginTop: 6, fontSize: 12, color: '#666' }}>
                  Tools are executed exclusively via MCP servers.
                </div>
              </div>
              {/* Per-server transport selector exists above; no global transport setting */}
              <div className="form-row">
                <label>System message</label>
                <textarea
                  value={draftSystemPrompt}
                  onChange={(e) => setDraftSystemPrompt(e.target.value)}
                  placeholder="You are a helpful assistant."
                  rows={4}
                />
              </div>
              <div className="form-row">
                <label>Connections</label>
                <div>
                  {(Array.isArray(mcpSnapshotsRef.current) ? mcpSnapshotsRef.current : []).map((snap, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{
                        display: 'inline-block', width: 8, height: 8, borderRadius: 4,
                        background: snap?.state === 'ready' ? '#1aaa55' : snap?.state === 'failed' ? '#d33' : '#f0ad4e',
                      }} />
                      <span style={{ minWidth: 120 }}>{snap?.name || `Server ${i+1}`}</span>
                      <span style={{ fontSize: 12, color: '#666' }}>{snap?.state || 'unknown'}{snap?.enabled === false ? ' (disabled)' : ''}</span>
                      {snap?.state === 'failed' && (
                        <button type="button" className="btn" onClick={() => snap?.retry && snap.retry()}>Retry</button>
                      )}
                      {snap?.state === 'pending_auth' && (
                        <button type="button" className="btn" onClick={() => snap?.authenticate && snap.authenticate()}>Authenticate</button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <div style={{ flex: 1 }} />
              <button className="btn" onClick={saveSettings}>Save</button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="chat-error">{error}</div>
      )}

      <div className="chat-body">
        <div className="chat-messages">
          {(() => {
            const toolOutputsById = new Map()
            for (const msg of messages) {
              if (msg && msg.role === 'tool' && msg.tool_call_id) {
                toolOutputsById.set(msg.tool_call_id, msg)
              }
            }
            return messages.map((m, idx) => {
              if (m.role === 'tool') {
                return (
                  <ToolCallBubble
                    key={idx}
                    name={m.name}
                    args={m.args}
                    content={m.content}
                  />
                )
              }
              if (m.role === 'assistant') {
                const hasText = String(m.content || '').trim().length > 0
                const hasReasoning = String(m.reasoning || '').trim().length > 0
                const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : []
                return (
                  <React.Fragment key={idx}>
                    {hasReasoning ? <ReasoningBubble content={m.reasoning} isStreaming={isStreaming} /> : null}
                    {hasText ? <MessageBubble role={m.role} content={m.content} /> : null}
                    {toolCalls.map((tc, i) => {
                      const id = tc && tc.id
                      const fnName = tc && tc.function && tc.function.name
                      const fnArgs = tc && tc.function && tc.function.arguments
                      const hasOutput = id ? toolOutputsById.has(id) : false
                      if (hasOutput) return null
                      return (
                        <ToolCallBubble
                          key={`tc-${idx}-${i}`}
                          name={fnName}
                          args={fnArgs}
                          content={'Waiting for tool response…'}
                          pending
                        />
                      )
                    })}
                  </React.Fragment>
                )
              }
              return <MessageBubble key={idx} role={m.role} content={m.content} />
            })
          })()}
          <div ref={messagesEndRef} />
        </div>
        <div className="chat-input">
          <textarea
            ref={inputRef}
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            placeholder="Ask a question..."
            disabled={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
          />
          <button className="btn" onClick={handleSend} disabled={isStreaming || !userInput.trim()}>
            {isStreaming ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

function MessageBubble({ role, content }) {
  return (
    <div className={role === 'user' ? 'msg msg-user' : role === 'assistant' ? 'msg msg-assistant' : 'msg msg-system'}>
      <div className="msg-role">{role}</div>
      <div className="msg-content">
        {role === 'user' || role === 'assistant' ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {String(content || '')}
          </ReactMarkdown>
        ) : (
          content
        )}
      </div>
    </div>
  )
}


function ReasoningBubble({ content, isStreaming }) {
  const [expanded, setExpanded] = useState(false)
  const lines = String(content || '').split(/\r?\n/)
  const first3 = lines.slice(0, 3).join('\n')
  const show = expanded ? content : first3
  const hasMore = lines.length > 3
  // Auto-collapse once streaming completes to save space
  useEffect(() => {
    if (!isStreaming) setExpanded(false)
  }, [isStreaming, content])
  return (
    <div className="msg msg-reasoning">
      <div className="reasoning-header">
        <span className="msg-role">reasoning</span>
        {isStreaming && (
          <span className="reasoning-loading">Thinking<span className="dot">.</span><span className="dot">.</span><span className="dot">.</span></span>
        )}
        {hasMore && (
          <button className="expand-btn" onClick={() => setExpanded(v => !v)}>{expanded ? 'Collapse' : 'Expand'}</button>
        )}
      </div>
      <pre className="reasoning-content">{show}</pre>
    </div>
  )
}

function ToolCallBubble({ name, args, content, pending }) {
  const [expanded, setExpanded] = useState(false)

  // Build a one-line preview from the content
  let preview = ''
  try {
    const parsed = JSON.parse(content)
    preview = JSON.stringify(parsed)
  } catch {
    preview = String(content || '')
  }
  if (preview.length > 140) preview = preview.slice(0, 140) + '…'

  // Only show expand button if expanding will reveal more than the preview
  const hasMore = String(content || '').length > preview.length

  const argsText = (() => {
    try {
      const obj = typeof args === 'string' ? JSON.parse(args) : args
      return JSON.stringify(obj)
    } catch { return '' }
  })()

  return (
    <div className="msg msg-tool">
      <div className="tool-header">
        <span className="msg-role">tool</span>
        <span className="tool-name">{name || 'function'}</span>
        {argsText ? <span className="tool-args">{argsText}</span> : null}
        {pending ? (
          <span className="reasoning-loading">Waiting<span className="dot">.</span><span className="dot">.</span><span className="dot">.</span></span>
        ) : (
          hasMore ? (
            <button className="expand-btn" onClick={() => setExpanded(v => !v)}>{expanded ? 'Collapse' : 'Expand'}</button>
          ) : null
        )}
      </div>
      {pending ? (
        <div className="tool-preview">{preview}</div>
      ) : expanded ? (
        <pre className="tool-details">{content}</pre>
      ) : (
        <div className="tool-preview">{preview}</div>
      )}
    </div>
  )
}


