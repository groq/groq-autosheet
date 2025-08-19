import React, { useMemo, useState, useEffect, useCallback } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'

const STORAGE_KEY = 'autosheet.scriptFiles.v1'

export function loadScriptsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr) && arr.length > 0) return sanitizeScripts(arr)
    }
  } catch {}
  return [
    {
      id: crypto.randomUUID(),
      name: 'script1.js',
      content: defaultTemplate()
    }
  ]
}

export function saveScriptsToStorage(scripts) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeScripts(scripts))) } catch {}
}

function sanitizeScripts(scripts) {
  return scripts.map((s) => ({ id: s.id || crypto.randomUUID(), name: s.name || 'script.js', content: s.content || '' }))
}

export default function ScriptEditor({ scripts, setScripts, activeId, setActiveId, onChangeContent, onBlurContent, liveReload, setLiveReload, error, onReloadNow }) {
  const [renamingId, setRenamingId] = useState(null)

  const active = useMemo(() => scripts.find((s) => s.id === activeId) || scripts[0], [scripts, activeId])

  useEffect(() => {
    if (!active && scripts.length > 0) setActiveId(scripts[0].id)
  }, [active, scripts, setActiveId])

  const addFile = useCallback(() => {
    const base = 'script'
    let i = scripts.length + 1
    let name = `${base}${i}.js`
    const used = new Set(scripts.map((s) => s.name))
    while (used.has(name)) { i++; name = `${base}${i}.js` }
    const next = { id: crypto.randomUUID(), name, content: defaultTemplate() }
    const arr = [...scripts, next]
    setScripts(arr)
    saveScriptsToStorage(arr)
    setActiveId(next.id)
  }, [scripts, setScripts, setActiveId])

  const removeFile = useCallback((id) => {
    if (scripts.length <= 1) return
    const idx = scripts.findIndex((s) => s.id === id)
    if (idx === -1) return
    const file = scripts[idx]
    const ok = window.confirm(`Delete ${file.name}? This cannot be undone.`)
    if (!ok) return
    const arr = scripts.filter((s) => s.id !== id)
    setScripts(arr)
    saveScriptsToStorage(arr)
    if (activeId === id) setActiveId(arr[Math.max(0, idx - 1)].id)
  }, [scripts, activeId, setScripts, setActiveId])

  const startRename = useCallback((id) => setRenamingId(id), [])

  const commitRename = useCallback((id, name) => {
    if (!name || !/^[^\s]+\.js$/.test(name)) return setRenamingId(null)
    const arr = scripts.map((s) => (s.id === id ? { ...s, name } : s))
    setScripts(arr)
    saveScriptsToStorage(arr)
    setRenamingId(null)
  }, [scripts, setScripts])

  return (
    <div className="scripts-pane">
      <div className="scripts-toolbar">
        <div className="scripts-title">Scripts</div>
        <div style={{ flex: 1 }} />
        <label className="toggle">
          <input type="checkbox" checked={liveReload} onChange={(e) => setLiveReload(e.target.checked)} /> Live reload
        </label>
        {!liveReload && <button className="btn" onClick={onReloadNow}>Reload</button>}
      </div>
      <div className="scripts-body">
        <div className="file-tree">
          <div className="file-tree-header">
            <button className="btn" onClick={addFile}>+ File</button>
          </div>
          <div className="file-list">
            {scripts.map((file) => (
              <div key={file.id} className={"file-item" + (active && active.id === file.id ? ' active' : '')}>
                {renamingId === file.id ? (
                  <input
                    autoFocus
                    defaultValue={file.name}
                    onBlur={(e) => commitRename(file.id, e.target.value.trim())}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitRename(file.id, e.currentTarget.value.trim()); if (e.key === 'Escape') setRenamingId(null) }}
                  />
                ) : (
                  <button className="file-name" onClick={() => setActiveId(file.id)} title={file.name}>{file.name}</button>
                )}
                <div className="file-actions">
                  <button className="icon" title="Rename" onClick={() => startRename(file.id)}>✏️</button>
                  <button className="icon" title="Delete" onClick={() => removeFile(file.id)}>🗑️</button>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="editor-area">
          {active && (
            <CodeMirror
              value={active.content}
              height="100%"
              extensions={[javascript({ jsx: false, typescript: false })]}
              onChange={(val) => {
                const arr = scripts.map((s) => (s.id === active.id ? { ...s, content: val } : s))
                setScripts(arr)
                saveScriptsToStorage(arr)
                onChangeContent && onChangeContent(arr)
              }}
              onBlur={() => onBlurContent && onBlurContent(scripts)}
              theme={undefined}
              basicSetup={{ lineNumbers: true, foldGutter: true }}
            />
          )}
        </div>
      </div>
      {error && (
        <div className="scripts-error" title={error.details || ''}>{String(error.message || error)}</div>
      )}
    </div>
  )
}

function defaultTemplate() {
  return `// Custom functions guide
// - Define top-level functions: function Name(args, ctx) { ... }
// - They become available in formulas by name; names starting with '_' are ignored.
// - args: array of evaluated arguments from the cell formula
// - ctx: { sheetName, engine, registry }
// Example:
function Abc(args) {
  const x = Number(args?.[0] ?? 0)
  return x + 1
}
`
}


