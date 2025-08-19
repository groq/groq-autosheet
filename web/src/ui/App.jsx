import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { SpreadsheetEngine, registerBuiltins } from 'autosheet'
import { Grid } from './Grid.jsx'
import ScriptEditor, { loadScriptsFromStorage, saveScriptsToStorage } from './ScriptEditor.jsx'
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
  const [viewMode, setViewMode] = useState('split') // 'sheet' | 'scripts' | 'split'
  const containerRef = useRef(null)
  const [splitRatio, setSplitRatio] = useState(() => {
    try {
      const v = Number(localStorage.getItem('autosheet.splitRatio'))
      if (!Number.isNaN(v) && v > 0.05 && v < 0.95) return v
    } catch {}
    return 0.6
  })
  const splitRatioRef = useRef(splitRatio)
  useEffect(() => { splitRatioRef.current = splitRatio }, [splitRatio])

  const clampAndSetSplitRatio = useCallback((ratio) => {
    const el = containerRef.current
    const minSheet = 320
    const minEditor = 280
    if (el && el.clientWidth > 0) {
      const minR = minSheet / el.clientWidth
      const maxR = 1 - (minEditor / el.clientWidth)
      ratio = Math.min(Math.max(ratio, minR), maxR)
    } else {
      ratio = Math.min(Math.max(ratio, 0.1), 0.9)
    }
    setSplitRatio(ratio)
    try { localStorage.setItem('autosheet.splitRatio', String(ratio)) } catch {}
  }, [])

  useEffect(() => {
    const onResize = () => {
      clampAndSetSplitRatio(splitRatioRef.current)
    }
    window.addEventListener('resize', onResize)
    // Initial clamp after first paint
    setTimeout(() => clampAndSetSplitRatio(splitRatioRef.current), 0)
    return () => window.removeEventListener('resize', onResize)
  }, [clampAndSetSplitRatio])

  const beginSplitDrag = useCallback((e) => {
    e.preventDefault()
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const onMove = (ev) => {
      const x = ev.clientX - rect.left
      const r = x / rect.width
      clampAndSetSplitRatio(r)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [clampAndSetSplitRatio])

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
      const bag = Function(wrapper)()
      const NewRegistryClass = engine.registry.constructor
      const newRegistry = new NewRegistryClass()
      registerBuiltins(newRegistry)
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
          <button className={viewMode === 'sheet' ? 'tab active' : 'tab'} onClick={() => setViewMode('sheet')}>Sheet</button>
          <button className={viewMode === 'scripts' ? 'tab active' : 'tab'} onClick={() => setViewMode('scripts')}>Scripts</button>
          <button className={viewMode === 'split' ? 'tab active' : 'tab'} onClick={() => setViewMode('split')}>Split</button>
        </div>
      </div>
      {(viewMode === 'sheet' || viewMode === 'split') && (
        <FormulaBar
          selection={selection}
          getCellRaw={getCellRaw}
          onSubmit={(text) => setCell(selection.row, selection.col, normalizeInput(text))}
        />
      )}
      <div className={viewMode === 'split' ? 'main split' : 'main'} ref={containerRef}>
        {(viewMode === 'sheet' || viewMode === 'split') && (
          <div className="sheet-pane" style={viewMode === 'split' ? { width: `${splitRatio * 100}%` } : undefined}>
            <Grid
              rows={20}
              cols={10}
              selection={selection}
              setSelection={setSelection}
              getCellDisplay={getCellDisplay}
              getCellRaw={getCellRaw}
              onEdit={(r, c, text) => setCell(r, c, normalizeInput(text))}
            />
          </div>
        )}
        {viewMode === 'split' && (
          <div
            className="split-resizer"
            onMouseDown={beginSplitDrag}
            title="Drag to resize"
            onDoubleClick={() => clampAndSetSplitRatio(0.6)}
          />
        )}
        {(viewMode === 'scripts' || viewMode === 'split') && (
          <div className="editor-pane" style={viewMode === 'split' ? { width: `${(1 - splitRatio) * 100}%` } : undefined}>
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
          </div>
        )}
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


