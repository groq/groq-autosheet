"use client"
import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { SpreadsheetEngine, registerBuiltins } from 'autosheet'
import { Grid } from './Grid.jsx'
import ScriptEditor, { loadScriptsFromStorage, saveScriptsToStorage } from './ScriptEditor.jsx'
import Chat from './Chat.jsx'
import * as acorn from 'acorn'

export default function App() {
  const engine = useMemo(() => {
    const e = new SpreadsheetEngine()
    registerBuiltins(e.registry)
    e.addSheet('Sheet1')
    return e
  }, [])

  const [activeSheet] = useState('Sheet1')
  const [selection, setSelection] = useState({ row: 1, col: 1 })
  const [gridVersion, setGridVersion] = useState(0)
  // Independent view toggles (initialize from storage immediately on client to avoid flicker/races)
  const [showSheet, setShowSheet] = useState(() => {
    try { const ss = localStorage.getItem('autosheet.showSheet'); return ss == null ? true : ss !== 'false' } catch { return true }
  })
  const [showScripts, setShowScripts] = useState(() => {
    try { const sp = localStorage.getItem('autosheet.showScripts'); return sp == null ? true : sp !== 'false' } catch { return true }
  })
  const [showChat, setShowChat] = useState(() => {
    try { const sc = localStorage.getItem('autosheet.showChat'); return sc == null ? false : sc !== 'false' } catch { return false }
  })
  const containerRef = useRef(null)
  // Dynamic widths for visible panes (left-to-right: sheet, scripts, chat)
  const [paneWidths, setPaneWidths] = useState(() => {
    // Initialize based on prior 2-pane split ratio if available
    try {
      const saved = localStorage.getItem('autosheet.paneWidths')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.every((n) => typeof n === 'number')) return parsed
      }
    } catch {}
    try {
      const r = Number(localStorage.getItem('autosheet.splitRatio'))
      if (!Number.isNaN(r) && r > 0.05 && r < 0.95) return [r, 1 - r]
    } catch {}
    return [0.6, 0.4]
  })
  const paneWidthsRef = useRef(paneWidths)
  useEffect(() => { paneWidthsRef.current = paneWidths }, [paneWidths])

  const getVisiblePanes = useCallback(() => {
    const panes = []
    if (showSheet) panes.push('sheet')
    if (showScripts) panes.push('scripts')
    if (showChat) panes.push('chat')
    return panes
  }, [showSheet, showScripts, showChat])

  const getMinWidthPx = useCallback((pane) => {
    if (pane === 'sheet') return 320
    if (pane === 'scripts') return 280
    if (pane === 'chat') return 280
    return 240
  }, [])

  const clampAndSetPaneWidths = useCallback((widths) => {
    const el = containerRef.current
    const panes = getVisiblePanes()
    const RESIZER_PX = 6
    if (!el || el.clientWidth <= 0) {
      const normalized = (() => {
        const clamped = widths.map((w) => (Number.isFinite(w) ? Math.min(Math.max(w, 0.05), 0.95) : 0))
        const sum = clamped.reduce((a, b) => a + b, 0) || 1
        return clamped.map((w) => w / sum)
      })()
      setPaneWidths(normalized)
      try { localStorage.setItem('autosheet.paneWidths', JSON.stringify(normalized)) } catch {}
      return
    }
    const resizerTotalPx = Math.max(0, (panes.length - 1) * RESIZER_PX)
    const totalPx = Math.max(1, el.clientWidth - resizerTotalPx)
    const minRatios = panes.map((p) => getMinWidthPx(p) / totalPx)

    // If minimums cannot all fit, scale them proportionally to fill available space
    const minSum = minRatios.reduce((a, b) => a + b, 0)
    if (minSum >= 1) {
      const scaled = minRatios.map((r) => (r / minSum))
      setPaneWidths(scaled)
      try { localStorage.setItem('autosheet.paneWidths', JSON.stringify(scaled)) } catch {}
      return
    }

    // Start with provided widths (normalized) or equal distribution
    let adjusted = (() => {
      const src = widths.length === panes.length ? widths.slice() : Array.from({ length: panes.length }, () => 1 / panes.length)
      const safe = src.map((w) => (Number.isFinite(w) ? Math.max(w, 0) : 0))
      const sum = safe.reduce((a, b) => a + b, 0) || 1
      return safe.map((w) => w / sum)
    })()

    // Ensure minimums by redistributing from others proportionally
    for (let i = 0; i < adjusted.length; i++) {
      if (adjusted[i] < minRatios[i]) {
        const deficit = minRatios[i] - adjusted[i]
        let pool = 0
        for (let j = 0; j < adjusted.length; j++) if (j !== i) pool += Math.max(0, adjusted[j] - minRatios[j])
        if (pool > 0) {
          for (let j = 0; j < adjusted.length; j++) {
            if (j === i) continue
            const avail = Math.max(0, adjusted[j] - minRatios[j])
            const take = (avail / pool) * deficit
            adjusted[j] -= take
            adjusted[i] += take
          }
        } else {
          // No pool to borrow from; fallback to minimums and renormalize later
          adjusted[i] = minRatios[i]
        }
      }
    }
    const sum = adjusted.reduce((a, b) => a + b, 0) || 1
    adjusted = adjusted.map((w) => w / sum)
    setPaneWidths(adjusted)
    try { localStorage.setItem('autosheet.paneWidths', JSON.stringify(adjusted)) } catch {}
  }, [getMinWidthPx, getVisiblePanes])

  useEffect(() => {
    const onResize = () => {
      clampAndSetPaneWidths(paneWidthsRef.current)
    }
    window.addEventListener('resize', onResize)
    // Initial clamp after first paint
    setTimeout(() => clampAndSetPaneWidths(paneWidthsRef.current), 0)
    return () => window.removeEventListener('resize', onResize)
  }, [clampAndSetPaneWidths])

  const beginResizeDrag = useCallback((e, index) => {
    e.preventDefault()
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const startX = e.clientX
    const startWidths = paneWidthsRef.current.slice()
    const panes = getVisiblePanes()
    const RESIZER_PX = 6
    const totalPx = Math.max(1, rect.width - (panes.length - 1) * RESIZER_PX)
    const minRatios = panes.map((p) => getMinWidthPx(p) / totalPx)

    const onMove = (ev) => {
      const deltaPx = ev.clientX - startX
      const delta = deltaPx / totalPx
      const leftMaxShrink = startWidths[index] - minRatios[index]
      const rightMaxShrink = startWidths[index + 1] - minRatios[index + 1]
      const clampedDelta = Math.max(-leftMaxShrink, Math.min(delta, rightMaxShrink))
      const next = startWidths.slice()
      next[index] += clampedDelta
      next[index + 1] -= clampedDelta
      clampAndSetPaneWidths(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [clampAndSetPaneWidths, getMinWidthPx, getVisiblePanes])

  // Persist toggles: handled inline in togglePane to avoid double-writes/races

  const togglePane = useCallback((pane) => {
    const visible = getVisiblePanes()
    const isLast = visible.length === 1 && visible[0] === pane
    if (isLast) return // prevent hiding all
    if (pane === 'sheet') {
      setShowSheet((prev) => {
        const next = !prev
        try { localStorage.setItem('autosheet.showSheet', String(next)) } catch {}
        return next
      })
      return
    }
    if (pane === 'scripts') {
      setShowScripts((prev) => {
        const next = !prev
        try { localStorage.setItem('autosheet.showScripts', String(next)) } catch {}
        return next
      })
      return
    }
    if (pane === 'chat') {
      setShowChat((prev) => {
        const next = !prev
        try { localStorage.setItem('autosheet.showChat', String(next)) } catch {}
        return next
      })
      return
    }
  }, [getVisiblePanes])

  // When visible panes change, adjust paneWidths length and distribution
  useEffect(() => {
    const visible = getVisiblePanes()
    if (visible.length === paneWidthsRef.current.length) return
    let widths = paneWidthsRef.current.slice()
    if (visible.length < widths.length) {
      // Remove extra widths by merging proportionally into remaining
      const keep = widths.slice(0, visible.length)
      const drop = widths.slice(visible.length).reduce((a, b) => a + b, 0)
      const sumKeep = keep.reduce((a, b) => a + b, 0) || 1
      widths = keep.map((w) => w + (w / sumKeep) * drop)
    } else {
      // Add new panes with a small share, renormalize
      const addCount = visible.length - widths.length
      const extra = 0.25
      for (let i = 0; i < addCount; i++) widths.push(extra)
      const sum = widths.reduce((a, b) => a + b, 0)
      widths = widths.map((w) => w / sum)
    }
    // Defer clamping to the next frame so container measurements are up to date
    const id = window.requestAnimationFrame(() => clampAndSetPaneWidths(widths))
    return () => window.cancelAnimationFrame(id)
  }, [showSheet, showScripts, showChat, clampAndSetPaneWidths, getVisiblePanes])

  // Script editor state
  const [scripts, setScripts] = useState(() => loadScriptsFromStorage())
  const [activeScriptId, setActiveScriptId] = useState(() => {
    const init = loadScriptsFromStorage()
    return (init[0] && init[0].id) || null
  })
  const [liveReload, setLiveReload] = useState(true)
  const [scriptError, setScriptError] = useState(null)

  const setCell = useCallback((row, col, value) => {
    const addr = toA1(row, col)
    engine.setCell(activeSheet, addr, value)
    setGridVersion((v) => v + 1)
  }, [engine, activeSheet])

  const getCellDisplay = useCallback((row, col) => {
    const addr = toA1(row, col)
    const raw = engine.getCell(activeSheet, addr)
    if (typeof raw === 'string' && raw.startsWith('=')) {
      const v = engine.evaluateCell(activeSheet, addr)
      return formatValue(v)
    }
    return formatValue(raw)
  }, [engine, activeSheet, gridVersion])

  const getCellRaw = useCallback((row, col) => {
    const addr = toA1(row, col)
    const raw = engine.getCell(activeSheet, addr)
    return raw ?? ''
  }, [engine, activeSheet, gridVersion])

  const compileAndRegisterScripts = useCallback((allScripts) => {
    try {
      const combined = allScripts.map((s) => String(s.content || '')).join('\n\n')
      // Syntax validation + collect top-level function declarations
      const ast = acorn.parse(combined, { ecmaVersion: 'latest', sourceType: 'script' })
      const fnNames = []
      for (const node of ast.body) {
        if (node.type === 'FunctionDeclaration' && node.id && node.id.name && !node.id.name.startsWith('_')) {
          fnNames.push(node.id.name)
        }
      }
      // Evaluate and stage functions into a fresh registry (atomic swap on success)
      const exportList = fnNames.map((n) => `${n}: typeof ${n} !== 'undefined' ? ${n} : undefined`).join(', ')
      const wrapper = `"use strict";\n${combined}\n;return { ${exportList} };`
      const NewRegistryClass = engine.registry.constructor
      const newRegistry = new NewRegistryClass()
      registerBuiltins(newRegistry)
      // Build BUILTINS helper for user scripts to call built-in spreadsheet functions directly
      const builtinsHelper = {}
      for (const name of newRegistry.names()) {
        if (name === 'BUILTINS') continue
        builtinsHelper[name] = (...fnArgs) => newRegistry.get(name)(fnArgs)
      }
      const bag = Function('BUILTINS', wrapper)(builtinsHelper)
      for (const name of fnNames) {
        const fn = bag[name]
        if (typeof fn === 'function') newRegistry.register(name, fn)
      }
      engine.registry = newRegistry
      setScriptError(null)
      setGridVersion((v) => v + 1)
    } catch (err) {
      setScriptError({ message: 'Script error', details: String(err && (err.message || err)) })
    }
  }, [engine])

  // Initial load
  useEffect(() => {
    compileAndRegisterScripts(scripts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Live reload on change
  const handleScriptsChange = useCallback((arr) => {
    saveScriptsToStorage(arr)
    if (liveReload) compileAndRegisterScripts(arr)
  }, [liveReload, compileAndRegisterScripts])

  const handleScriptsBlur = useCallback((arr) => {
    if (!liveReload) compileAndRegisterScripts(arr)
  }, [liveReload, compileAndRegisterScripts])

  return (
    <div className="app">
      <div className="toolbar">
        <div className="title">Autosheet</div>
        <div style={{ flex: 1 }} />
        <div className="tabs">
          <button className={showSheet ? 'tab active' : 'tab'} onClick={() => togglePane('sheet')}>Sheet</button>
          <button className={showScripts ? 'tab active' : 'tab'} onClick={() => togglePane('scripts')}>Scripts</button>
          <button className={showChat ? 'tab active' : 'tab'} onClick={() => togglePane('chat')}>Chat</button>
        </div>
      </div>
      
      <div className="main" ref={containerRef}>
        {(() => {
          const panes = getVisiblePanes()
          const resizerTotalPx = (panes.length - 1) * 6
          return panes.map((pane, idx) => (
          <React.Fragment key={pane}>
            <div
              className="pane"
              style={{ flex: `0 0 calc((100% - ${resizerTotalPx}px) * ${(paneWidths[idx] || (1 / panes.length))})` }}
            >
              {pane === 'sheet' && (
                <>
                  <FormulaBar
                    selection={selection}
                    getCellRaw={getCellRaw}
                    onSubmit={(text) => setCell(selection.row, selection.col, normalizeInput(text))}
                  />
                  <Grid
                    rows={100}
                    cols={26}
                    selection={selection}
                    setSelection={setSelection}
                    getCellDisplay={getCellDisplay}
                    getCellRaw={getCellRaw}
                    onEdit={(r, c, text) => setCell(r, c, normalizeInput(text))}
                  />
                </>
              )}
              {pane === 'scripts' && (
                <ScriptEditor
                  scripts={scripts}
                  setScripts={setScripts}
                  activeId={activeScriptId}
                  setActiveId={setActiveScriptId}
                  onChangeContent={handleScriptsChange}
                  onBlurContent={handleScriptsBlur}
                  liveReload={liveReload}
                  setLiveReload={setLiveReload}
                  error={scriptError}
                  onReloadNow={() => compileAndRegisterScripts(scripts)}
                />
              )}
              {pane === 'chat' && (
                <Chat
                  engine={engine}
                  activeSheet={activeSheet}
                  onEngineMutated={() => setGridVersion((v) => v + 1)}
                />
              )}
            </div>
            {idx < panes.length - 1 && (
              <div
                className="split-resizer"
                onMouseDown={(e) => beginResizeDrag(e, idx)}
                title="Drag to resize"
              />
            )}
          </React.Fragment>
          ))
        })()}
      </div>
    </div>
  )
}

function toA1(row, col) {
  let c = col
  let colStr = ''
  while (c > 0) {
    const rem = (c - 1) % 26
    colStr = String.fromCharCode(65 + rem) + colStr
    c = Math.floor((c - 1) / 26)
  }
  return `${colStr}${row}`
}

function formatValue(v) {
  if (v == null) return ''
  if (typeof v === 'object' && v.code) return v.code
  if (Array.isArray(v)) return `[${v.join(', ')}]`
  return String(v)
}

function normalizeInput(input) {
  if (typeof input !== 'string') return input
  const trimmed = input.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('=')) return trimmed
  const n = Number(trimmed)
  return Number.isNaN(n) ? input : n
}

function FormulaBar({ selection, getCellRaw, onSubmit }) {
  const [value, setValue] = useState('')

  React.useEffect(() => {
    setValue(getCellRaw(selection.row, selection.col))
  }, [selection, getCellRaw])

  return (
    <div className="formula-bar">
      <div className="name">
        {toA1(selection.row, selection.col)}
      </div>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit(value)
        }}
        placeholder="Enter a value or =formula"
      />
      <button onClick={() => onSubmit(value)}>Set</button>
    </div>
  )
}


