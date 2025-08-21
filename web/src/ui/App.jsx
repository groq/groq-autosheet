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
    // Only create a default sheet if no saved sheets exist
    try {
      const raw = localStorage.getItem('autosheet.sheets.v1')
      if (raw) {
        const parsed = JSON.parse(raw)
        const sheetsObj = parsed && parsed.sheets && typeof parsed.sheets === 'object' ? parsed.sheets : {}
        const names = Object.keys(sheetsObj)
        if (names.length === 0) {
          e.addSheet('Sheet1')
        }
      } else {
        e.addSheet('Sheet1')
      }
    } catch {
      e.addSheet('Sheet1')
    }
    // Re-render when async AI cache updates
    e.onAsyncChange = () => {
      setGridVersion((v) => v + 1)
    }
    return e
  }, [])

  const [activeSheet, setActiveSheet] = useState(() => {
    try {
      const saved = localStorage.getItem('autosheet.activeSheet')
      if (saved) return String(saved)
      const raw = localStorage.getItem('autosheet.sheets.v1')
      if (raw) {
        const parsed = JSON.parse(raw)
        const sheetsObj = parsed && parsed.sheets && typeof parsed.sheets === 'object' ? parsed.sheets : {}
        const names = Object.keys(sheetsObj)
        if (names.length > 0) return names[0]
      }
    } catch {}
    return 'Sheet1'
  })
  const [selection, setSelection] = useState({ row: 1, col: 1 })
  const [gridVersion, setGridVersion] = useState(0)
  const displayCacheRef = useRef(new Map())
  const invalidateDisplayCache = useCallback(() => {
    try { displayCacheRef.current.clear() } catch {}
  }, [])
  // Dynamic grid dimensions
  const [gridRows, setGridRows] = useState(100)
  const [gridCols, setGridCols] = useState(26)
  // ===== Cell formatting state =====
  const [cellFormats, setCellFormats] = useState(() => {
    try {
      const raw = localStorage.getItem('autosheet.cellFormats.v1')
      if (raw) return JSON.parse(raw)
    } catch {}
    return {}
  })
  // ===== Sheet content persistence =====
  const SHEETS_STORAGE_KEY = 'autosheet.sheets.v1'
  const ACTIVE_SHEET_STORAGE_KEY = 'autosheet.activeSheet'
  const CELL_FORMATS_STORAGE_KEY = 'autosheet.cellFormats.v1'
  const saveTimerRef = useRef(null)
  const activeSheetRef = useRef(activeSheet)
  useEffect(() => { activeSheetRef.current = activeSheet }, [activeSheet])
  // Keep latest formats in a ref for unload persistence
  const cellFormatsRef = useRef(cellFormats)
  useEffect(() => { cellFormatsRef.current = cellFormats }, [cellFormats])

  // Ensure async changes invalidate display cache before re-render
  useEffect(() => {
    if (!engine) return
    engine.onAsyncChange = () => {
      try { displayCacheRef.current.clear() } catch {}
      setGridVersion((v) => v + 1)
    }
  }, [engine])

  const serializeSheets = useCallback(() => {
    const out = { sheets: {}, activeSheet, formats: cellFormats }
    try {
      for (const [name, dataMap] of engine.sheets.entries()) {
        const obj = {}
        for (const [addr, val] of dataMap.entries()) {
          if (val == null) continue
          const s = String(val)
          if (s === '') continue
          obj[addr] = val
        }
        out.sheets[name] = obj
      }
    } catch {}
    return out
  }, [engine, activeSheet, cellFormats])

  const persistSheetsNow = useCallback(() => {
    try {
      const payload = serializeSheets()
      localStorage.setItem(SHEETS_STORAGE_KEY, JSON.stringify(payload))
      localStorage.setItem(ACTIVE_SHEET_STORAGE_KEY, String(activeSheet || ''))
      localStorage.setItem(CELL_FORMATS_STORAGE_KEY, JSON.stringify(cellFormats || {}))
    } catch {}
  }, [serializeSheets, activeSheet, cellFormats])

  const schedulePersistSheets = useCallback(() => {
    try { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) } catch {}
    saveTimerRef.current = setTimeout(() => { persistSheetsNow() }, 300)
  }, [persistSheetsNow])

  // Load persisted sheets on first mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SHEETS_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        const sheetsObj = parsed && parsed.sheets && typeof parsed.sheets === 'object' ? parsed.sheets : {}
        const names = Object.keys(sheetsObj)
        if (names.length > 0) {
          // Ensure all saved sheets exist and restore contents
          for (const name of names) {
            if (!engine.sheets.has(name)) engine.addSheet(name)
            const addrMap = sheetsObj[name] || {}
            for (const addr of Object.keys(addrMap)) {
              engine.setCell(name, addr, addrMap[addr])
            }
          }
          // Restore cell formats if available
          if (parsed.formats && typeof parsed.formats === 'object') {
            setCellFormats(parsed.formats)
          }
          // If we pre-created Sheet1 but it's not part of saved sheets, remove it when empty
          if (engine.sheets.has('Sheet1') && !names.includes('Sheet1')) {
            const defaultMap = engine.sheets.get('Sheet1')
            if (!defaultMap || defaultMap.size === 0) {
              engine.sheets.delete('Sheet1')
            }
          }
          const savedActive = String(localStorage.getItem(ACTIVE_SHEET_STORAGE_KEY) || '')
          if (savedActive && engine.sheets.has(savedActive)) {
            setActiveSheet(savedActive)
          } else if (names[0]) {
            setActiveSheet(names[0])
          }
          setSelection({ row: 1, col: 1 })
          setGridVersion((v) => v + 1)
        }
      }
    } catch {}
    // Persist on unload as a safeguard
    const onBeforeUnload = () => {
      try {
        const out = { sheets: {}, activeSheet: activeSheetRef.current, formats: cellFormatsRef.current || {} }
        for (const [name, dataMap] of engine.sheets.entries()) {
          const obj = {}
          for (const [addr, val] of dataMap.entries()) {
            if (val == null) continue
            const s = String(val)
            if (s === '') continue
            obj[addr] = val
          }
          out.sheets[name] = obj
        }
        localStorage.setItem(SHEETS_STORAGE_KEY, JSON.stringify(out))
        localStorage.setItem(ACTIVE_SHEET_STORAGE_KEY, String(activeSheetRef.current || ''))
        localStorage.setItem(CELL_FORMATS_STORAGE_KEY, JSON.stringify(cellFormatsRef.current || {}))
      } catch {}
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [engine])
  // Independent view toggles (initialize from storage immediately on client to avoid flicker/races)
  const [showSheet, setShowSheet] = useState(() => {
    try { const ss = localStorage.getItem('autosheet.showSheet'); return ss == null ? true : ss !== 'false' } catch { return true }
  })
  const [showScripts, setShowScripts] = useState(() => {
    try { const sp = localStorage.getItem('autosheet.showScripts'); return sp == null ? true : sp !== 'false' } catch { return true }
  })
  const [showChat, setShowChat] = useState(() => {
    try { const sc = localStorage.getItem('autosheet.showChat'); return sc == null ? true : sc !== 'false' } catch { return true }
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

  // Reflect external script changes (e.g., via MCP tools) in the editor UI
  useEffect(() => {
    const onScriptsUpdated = (e) => {
      const next = (e && e.detail && Array.isArray(e.detail.scripts)) ? e.detail.scripts : []
      setScripts(next)
      setActiveScriptId((prev) => (next.some((s) => s && s.id === prev) ? prev : (next[0] && next[0].id) || null))
    }
    window.addEventListener('autosheet:scripts_updated', onScriptsUpdated)
    return () => window.removeEventListener('autosheet:scripts_updated', onScriptsUpdated)
  }, [])

  const setCell = useCallback((row, col, value) => {
    const addr = toA1(row, col)
    engine.setCell(activeSheet, addr, value)
    invalidateDisplayCache()
    setGridVersion((v) => v + 1)
    schedulePersistSheets()
  }, [engine, activeSheet, invalidateDisplayCache])

  // Clear cached displays whenever data context changes
  useEffect(() => {
    try { displayCacheRef.current.clear() } catch {}
  }, [engine, activeSheet, gridVersion])

  const getCellDisplay = useCallback((row, col) => {
    const addr = toA1(row, col)
    const key = `${activeSheet}:${addr}`
    if (displayCacheRef.current.has(key)) {
      return displayCacheRef.current.get(key)
    }
    const raw = engine.getCell(activeSheet, addr)
    const cellFormatKey = `${activeSheet}:${addr}`
    const format = cellFormats[cellFormatKey] || {}
    let out
    if (typeof raw === 'string' && raw.startsWith('=')) {
      const v = engine.evaluateCell(activeSheet, addr)
      out = formatValue(v, format)
    } else {
      out = formatValue(raw, format)
    }
    displayCacheRef.current.set(key, out)
    return out
  }, [engine, activeSheet, cellFormats])

  const getCellRaw = useCallback((row, col) => {
    const addr = toA1(row, col)
    const raw = engine.getCell(activeSheet, addr)
    return raw ?? ''
  }, [engine, activeSheet])

  const getCellFormat = useCallback((row, col) => {
    const addr = toA1(row, col)
    const key = `${activeSheet}:${addr}`
    return cellFormats[key] || {}
  }, [activeSheet, cellFormats])

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
      invalidateDisplayCache()
      setGridVersion((v) => v + 1)
    } catch (err) {
      setScriptError({ message: 'Script error', details: String(err && (err.message || err)) })
    }
  }, [engine, invalidateDisplayCache])

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

  // ===== Sheets handling =====
  const sheetNames = useMemo(() => Array.from(engine.sheets.keys()), [engine, gridVersion])
  const addNewSheet = useCallback(() => {
    // Generate next SheetN name not in use
    let idx = sheetNames.length + 1
    const existing = new Set(sheetNames)
    while (existing.has(`Sheet${idx}`)) idx++
    const name = `Sheet${idx}`
    engine.addSheet(name)
    setActiveSheet(name)
    setSelection({ row: 1, col: 1 })
    invalidateDisplayCache()
    setGridVersion((v) => v + 1)
    schedulePersistSheets()
  }, [engine, sheetNames, invalidateDisplayCache])
  const selectSheet = useCallback((name) => {
    if (!name || name === activeSheet) return
    if (!engine.sheets.has(name)) engine.addSheet(name)
    setActiveSheet(name)
    setSelection({ row: 1, col: 1 })
    // Ensure dependent selectors recompute
    invalidateDisplayCache()
    setGridVersion((v) => v + 1)
    try { localStorage.setItem(ACTIVE_SHEET_STORAGE_KEY, String(name)) } catch {}
  }, [engine, activeSheet, invalidateDisplayCache])

  const isValidSheetName = useCallback((name) => /^[A-Za-z0-9_]+$/.test(name), [])

  const renameSheet = useCallback((oldName, newName) => {
    const src = String(oldName || '').trim()
    const dst = String(newName || '').trim()
    if (!src || !dst || src === dst) return false
    if (!isValidSheetName(dst)) { alert('Sheet names must be letters, numbers, or underscore only.'); return false }
    if (!engine.sheets.has(src)) return false
    if (engine.sheets.has(dst)) { alert('A sheet with that name already exists.'); return false }
    // Move data map
    const data = engine.sheets.get(src)
    engine.sheets.set(dst, data)
    engine.sheets.delete(src)
    // Best-effort: update sheet-qualified references in formulas across all sheets
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])${src}!`, 'g')
    for (const [sheetName, sheetMap] of engine.sheets.entries()) {
      for (const [addr, val] of sheetMap.entries()) {
        if (typeof val === 'string' && val.startsWith('=')) {
          const replaced = val.replace(pattern, (m, p1) => `${p1}${dst}!`)
          if (replaced !== val) sheetMap.set(addr, replaced)
        }
      }
    }
    if (activeSheet === src) setActiveSheet(dst)
    invalidateDisplayCache()
    setGridVersion((v) => v + 1)
    schedulePersistSheets()
    return true
  }, [engine, activeSheet, isValidSheetName, invalidateDisplayCache])

  const deleteSheet = useCallback((name) => {
    const target = String(name || '').trim()
    if (!engine.sheets.has(target)) return false
    if (engine.sheets.size <= 1) { alert('Cannot delete the only sheet.'); return false }
    engine.sheets.delete(target)
    if (activeSheet === target) {
      const first = engine.sheets.keys().next().value
      setActiveSheet(first || 'Sheet1')
      setSelection({ row: 1, col: 1 })
    }
    invalidateDisplayCache()
    setGridVersion((v) => v + 1)
    schedulePersistSheets()
    return true
  }, [engine, activeSheet, invalidateDisplayCache])

  const promptRename = useCallback((name) => {
    const current = String(name || activeSheet)
    const next = window.prompt('Rename sheet', current)
    if (next && next.trim() && next.trim() !== current) renameSheet(current, next.trim())
  }, [activeSheet, renameSheet])

  const confirmDelete = useCallback((name) => {
    const target = String(name || activeSheet)
    if (window.confirm(`Delete sheet "${target}"? This cannot be undone.`)) deleteSheet(target)
  }, [activeSheet, deleteSheet])

  // ===== Format actions (menu) =====
  const applyFormatToSelection = useCallback((formatType, value) => {
    const { row, col, focus } = selection
    const top = focus ? Math.min(row, focus.row) : row
    const left = focus ? Math.min(col, focus.col) : col
    const bottom = focus ? Math.max(row, focus.row) : row
    const right = focus ? Math.max(col, focus.col) : col
    
    const newFormats = { ...cellFormats }
    for (let r = top; r <= bottom; r++) {
      for (let c = left; c <= right; c++) {
        const addr = toA1(r, c)
        const key = `${activeSheet}:${addr}`
        
        if (formatType === 'clear') {
          // Remove all formatting for this cell
          delete newFormats[key]
        } else {
          const existing = newFormats[key] || {}
          if (formatType === 'bold' || formatType === 'italic' || formatType === 'underline' || formatType === 'strikethrough') {
            newFormats[key] = { ...existing, [formatType]: value !== undefined ? value : !existing[formatType] }
          } else {
            newFormats[key] = { ...existing, [formatType]: value }
          }
        }
      }
    }
    setCellFormats(newFormats)
    invalidateDisplayCache()
    setGridVersion((v) => v + 1)
    schedulePersistSheets()
  }, [selection, activeSheet, cellFormats, invalidateDisplayCache, schedulePersistSheets])

  // ===== Edit actions (menu) =====
  const clearSelectionValues = useCallback(() => {
    const { row, col, focus } = selection
    const top = focus ? Math.min(row, focus.row) : row
    const left = focus ? Math.min(col, focus.col) : col
    const bottom = focus ? Math.max(row, focus.row) : row
    const right = focus ? Math.max(col, focus.col) : col
    for (let r = top; r <= bottom; r++) {
      for (let c = left; c <= right; c++) {
        setCell(r, c, null)
      }
    }
  }, [selection, setCell])

  const deleteRowAt = useCallback((rowIndex) => {
    const sheet = engine.sheets.get(activeSheet) || new Map()
    const next = new Map()
    for (const [addr, val] of sheet.entries()) {
      const { row: r, col: c } = parseA1(addr)
      if (r === rowIndex) continue
      const destRow = r > rowIndex ? r - 1 : r
      const nextAddr = toA1(destRow, c)
      next.set(nextAddr.toUpperCase(), val)
    }
    engine.sheets.set(activeSheet, next)
    setSelection((sel) => ({ row: Math.max(1, sel.row > rowIndex ? sel.row - 1 : sel.row), col: sel.col }))
    invalidateDisplayCache()
    setGridVersion((v) => v + 1)
    schedulePersistSheets()
  }, [engine, activeSheet, schedulePersistSheets, setSelection, invalidateDisplayCache])

  const deleteColumnAt = useCallback((colIndex) => {
    const sheet = engine.sheets.get(activeSheet) || new Map()
    const next = new Map()
    for (const [addr, val] of sheet.entries()) {
      const { row: r, col: c } = parseA1(addr)
      if (c === colIndex) continue
      const destCol = c > colIndex ? c - 1 : c
      const nextAddr = toA1(r, destCol)
      next.set(nextAddr.toUpperCase(), val)
    }
    engine.sheets.set(activeSheet, next)
    setSelection((sel) => ({ row: sel.row, col: Math.max(1, sel.col > colIndex ? sel.col - 1 : sel.col) }))
    invalidateDisplayCache()
    setGridVersion((v) => v + 1)
    schedulePersistSheets()
  }, [engine, activeSheet, schedulePersistSheets, setSelection, invalidateDisplayCache])

  return (
    <div className="app">
      <div className="toolbar">
        <Menubar
          onDownloadCsv={() => {
            try {
              const csv = generateCsv(engine, activeSheet)
              triggerCsvDownload(csv, `${activeSheet}.csv`)
            } catch (e) {
              console.error('CSV download failed:', e)
            }
          }}
          onImportCsv={(csvText) => {
            try {
              const matrix = parseCsv(csvText)
              if (!matrix || matrix.length === 0) { alert('No rows found in CSV.'); return }
              const width = Math.max(0, ...matrix.map((r) => r.length))
              const height = matrix.length
              if (!window.confirm(`Importing will replace all values in sheet "${activeSheet}". Continue?`)) return
              // Ensure grid can display imported data
              setGridRows((r) => Math.max(r, height))
              setGridCols((c) => Math.max(c, width))
              // Replace sheet contents atomically
              const map = new Map()
              for (let r = 0; r < height; r++) {
                const row = matrix[r] || []
                for (let c = 0; c < width; c++) {
                  const raw = row[c] == null ? '' : row[c]
                  const normalized = normalizeInput(String(raw))
                  const addr = toA1(r + 1, c + 1)
                  if (normalized !== null && normalized !== '') map.set(addr.toUpperCase(), normalized)
                }
              }
              engine.sheets.set(activeSheet, map)
              setSelection({ row: 1, col: 1 })
              invalidateDisplayCache()
              setGridVersion((v) => v + 1)
              schedulePersistSheets()
            } catch (e) {
              console.error('CSV import failed:', e)
              alert('CSV import failed: ' + (e && (e.message || String(e))))
            }
          }}
          selection={selection}
          onDeleteValues={clearSelectionValues}
          onDeleteRow={() => deleteRowAt(selection.row)}
          onDeleteColumn={() => deleteColumnAt(selection.col)}
          onApplyFormat={applyFormatToSelection}
          getCellFormat={getCellFormat}
        />
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
                    rows={gridRows}
                    cols={gridCols}
                    selection={selection}
                    setSelection={setSelection}
                    getCellDisplay={getCellDisplay}
                    getCellRaw={getCellRaw}
                    getCellFormat={getCellFormat}
                    onEdit={(r, c, text) => setCell(r, c, normalizeInput(text))}
                    onApplyFormat={applyFormatToSelection}
                  />
                  <SheetTabs
                    sheets={sheetNames}
                    active={activeSheet}
                    onSelect={selectSheet}
                    onAdd={addNewSheet}
                    onRename={promptRename}
                    onDelete={confirmDelete}
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
                  onEngineMutated={() => { invalidateDisplayCache(); setGridVersion((v) => v + 1); schedulePersistSheets() }}
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

function Menubar({ onDownloadCsv, onImportCsv, selection, onDeleteValues, onDeleteRow, onDeleteColumn, onApplyFormat, getCellFormat }) {
  const [fileOpen, setFileOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [formatOpen, setFormatOpen] = useState(false)
  const [textStyleOpen, setTextStyleOpen] = useState(false)
  const [numberFormatOpen, setNumberFormatOpen] = useState(false)
  const ref = useRef(null)
  const fileInputRef = useRef(null)

  useEffect(() => {
    const onDocClick = (e) => {
      if (!ref.current) return
      if (!ref.current.contains(e.target)) {
        setFileOpen(false)
        setEditOpen(false)
        setDeleteOpen(false)
        setFormatOpen(false)
        setTextStyleOpen(false)
        setNumberFormatOpen(false)
      }
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setFileOpen(false)
        setEditOpen(false)
        setDeleteOpen(false)
        setFormatOpen(false)
        setTextStyleOpen(false)
        setNumberFormatOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  const currentFormat = getCellFormat ? getCellFormat(selection.row, selection.col) : {}

  return (
    <div className="menubar" ref={ref}>
      <div className="menu">
        <button className="menu-button" onClick={() => { setFileOpen(v => !v); setEditOpen(false); setFormatOpen(false) }}>File ▾</button>
        {fileOpen && (
          <div className="menu-dropdown">
            <button className="menu-item" onClick={() => { setFileOpen(false); fileInputRef.current && fileInputRef.current.click() }}>Import CSV…</button>
            <button className="menu-item" onClick={() => { setFileOpen(false); onDownloadCsv && onDownloadCsv() }}>Download sheet as CSV</button>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target?.files && e.target.files[0]
            if (!f) return
            const reader = new FileReader()
            reader.onload = () => {
              const text = typeof reader.result === 'string' ? reader.result : ''
              onImportCsv && onImportCsv(text)
              try { e.target.value = '' } catch {}
            }
            reader.onerror = () => {
              alert('Failed to read file')
              try { e.target.value = '' } catch {}
            }
            reader.readAsText(f)
          }}
        />
      </div>
      <div className="menu">
        <button className="menu-button" onClick={() => { setEditOpen(v => !v); setFileOpen(false); setFormatOpen(false) }}>Edit ▾</button>
        {editOpen && (
          <div className="menu-dropdown">
            <div
              className="menu-item submenu-trigger"
              onMouseEnter={() => setDeleteOpen(true)}
              onMouseLeave={() => setDeleteOpen(false)}
              onClick={() => setDeleteOpen(v => !v)}
              style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '8px' }}
            >
              <span>Delete</span>
              <span style={{ marginLeft: 'auto' }}>▸</span>
              {deleteOpen && (
                <div
                  className="submenu-dropdown"
                  onMouseEnter={() => setDeleteOpen(true)}
                  onMouseLeave={() => setDeleteOpen(false)}
                >
                  <button className="menu-item" onClick={() => { setFileOpen(false); setEditOpen(false); setDeleteOpen(false); onDeleteValues && onDeleteValues() }}>Values</button>
                  <button className="menu-item" onClick={() => { setFileOpen(false); setEditOpen(false); setDeleteOpen(false); onDeleteRow && onDeleteRow() }}>{`Row ${selection && selection.row ? selection.row : 1}`}</button>
                  <button className="menu-item" onClick={() => { setFileOpen(false); setEditOpen(false); setDeleteOpen(false); onDeleteColumn && onDeleteColumn() }}>{`Column ${colLabel(selection && selection.col ? selection.col : 1)}`}</button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="menu">
        <button className="menu-button" onClick={() => { setFormatOpen(v => !v); setFileOpen(false); setEditOpen(false) }}>Format ▾</button>
        {formatOpen && (
          <div className="menu-dropdown">
            <div
              className="menu-item submenu-trigger"
              onMouseEnter={() => setTextStyleOpen(true)}
              onMouseLeave={() => setTextStyleOpen(false)}
              onClick={() => setTextStyleOpen(v => !v)}
              style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '8px' }}
            >
              <span>Text Style</span>
              <span style={{ marginLeft: 'auto' }}>▸</span>
              {textStyleOpen && (
                <div
                  className="submenu-dropdown"
                  onMouseEnter={() => setTextStyleOpen(true)}
                  onMouseLeave={() => setTextStyleOpen(false)}
                >
                  <button 
                    className="menu-item" 
                    onClick={() => { 
                      setFormatOpen(false); setTextStyleOpen(false); 
                      onApplyFormat && onApplyFormat('bold');
                    }}
                  >
                    {currentFormat.bold ? '✓ ' : ''}Bold <span style={{ marginLeft: 'auto', fontSize: '11px', color: '#666' }}>⌘B</span>
                  </button>
                  <button 
                    className="menu-item" 
                    onClick={() => { 
                      setFormatOpen(false); setTextStyleOpen(false); 
                      onApplyFormat && onApplyFormat('italic');
                    }}
                  >
                    {currentFormat.italic ? '✓ ' : ''}Italic <span style={{ marginLeft: 'auto', fontSize: '11px', color: '#666' }}>⌘I</span>
                  </button>
                  <button 
                    className="menu-item" 
                    onClick={() => { 
                      setFormatOpen(false); setTextStyleOpen(false); 
                      onApplyFormat && onApplyFormat('underline');
                    }}
                  >
                    {currentFormat.underline ? '✓ ' : ''}Underline <span style={{ marginLeft: 'auto', fontSize: '11px', color: '#666' }}>⌘U</span>
                  </button>
                  <button 
                    className="menu-item" 
                    onClick={() => { 
                      setFormatOpen(false); setTextStyleOpen(false); 
                      onApplyFormat && onApplyFormat('strikethrough');
                    }}
                  >
                    {currentFormat.strikethrough ? '✓ ' : ''}Strikethrough
                  </button>
                </div>
              )}
            </div>
            <div
              className="menu-item submenu-trigger"
              onMouseEnter={() => setNumberFormatOpen(true)}
              onMouseLeave={() => setNumberFormatOpen(false)}
              onClick={() => setNumberFormatOpen(v => !v)}
              style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '8px' }}
            >
              <span>Number Format</span>
              <span style={{ marginLeft: 'auto' }}>▸</span>
              {numberFormatOpen && (
                <div
                  className="submenu-dropdown"
                  onMouseEnter={() => setNumberFormatOpen(true)}
                  onMouseLeave={() => setNumberFormatOpen(false)}
                >
                  <button 
                    className="menu-item" 
                    onClick={() => { 
                      setFormatOpen(false); setNumberFormatOpen(false); 
                      onApplyFormat && onApplyFormat('numberFormat', 'normal');
                    }}
                  >
                    {currentFormat.numberFormat === 'normal' || !currentFormat.numberFormat ? '✓ ' : ''}Normal
                  </button>
                  <button 
                    className="menu-item" 
                    onClick={() => { 
                      setFormatOpen(false); setNumberFormatOpen(false); 
                      onApplyFormat && onApplyFormat('numberFormat', 'currency');
                    }}
                  >
                    {currentFormat.numberFormat === 'currency' ? '✓ ' : ''}Currency ($)
                  </button>
                  <button 
                    className="menu-item" 
                    onClick={() => { 
                      setFormatOpen(false); setNumberFormatOpen(false); 
                      onApplyFormat && onApplyFormat('numberFormat', 'percentage');
                    }}
                  >
                    {currentFormat.numberFormat === 'percentage' ? '✓ ' : ''}Percentage (%)
                  </button>
                  <div className="menu-divider" style={{ height: '1px', background: '#e0e0e0', margin: '4px 0' }} />
                  <button 
                    className="menu-item" 
                    onClick={() => { 
                      setFormatOpen(false); setNumberFormatOpen(false); 
                      const precision = window.prompt('Enter number of decimal places (0-10):', currentFormat.precision || '2');
                      if (precision !== null && /^\d+$/.test(precision)) {
                        const p = Math.min(10, Math.max(0, parseInt(precision)));
                        onApplyFormat && onApplyFormat('precision', p);
                      }
                    }}
                  >
                    Set Decimal Places... {currentFormat.precision !== undefined ? `(${currentFormat.precision})` : ''}
                  </button>
                </div>
              )}
            </div>
            <button 
              className="menu-item" 
              onClick={() => { 
                setFormatOpen(false);
                onApplyFormat && onApplyFormat('clear', null);
              }}
            >
              Clear Formatting
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function generateCsv(engine, sheetName) {
  const ROWS = 100
  const COLS = 26
  const isNonEmpty = (r, c) => {
    const addr = toA1(r, c)
    const raw = engine.getCell(sheetName, addr)
    return raw != null && String(raw) !== ''
  }
  let lastRow = 0
  let lastCol = 0
  for (let r = 1; r <= ROWS; r++) {
    for (let c = 1; c <= COLS; c++) {
      if (isNonEmpty(r, c)) {
        if (r > lastRow) lastRow = r
        if (c > lastCol) lastCol = c
      }
    }
  }
  if (lastRow === 0 || lastCol === 0) { lastRow = 1; lastCol = 1 }

  const lines = []
  for (let r = 1; r <= lastRow; r++) {
    const cells = []
    for (let c = 1; c <= lastCol; c++) {
      const addr = toA1(r, c)
      const raw = engine.getCell(sheetName, addr)
      const val = (typeof raw === 'string' && raw.startsWith('=')) ? engine.evaluateCell(sheetName, addr) : raw
      cells.push(escapeCsvCell(val))
    }
    lines.push(cells.join(','))
  }
  return lines.join('\r\n')
}

function escapeCsvCell(v) {
  if (v == null) return ''
  let s
  if (Array.isArray(v)) s = v.join(', ')
  else if (typeof v === 'object' && v.code) s = String(v.code)
  else s = String(v)
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'
  return s
}

function parseCsv(text) {
  const s = String(text || '')
  const lines = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const rows = []
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    // Allow trailing blank line
    if (li === lines.length - 1 && line === '') { continue }
    const out = []
    let i = 0
    while (i <= line.length) {
      if (i === line.length) { out.push(''); break }
      let ch = line[i]
      if (ch === '"') {
        // Quoted field
        i++
        let val = ''
        while (i < line.length) {
          const c = line[i]
          if (c === '"') {
            if (i + 1 < line.length && line[i + 1] === '"') { val += '"'; i += 2; continue }
            i++
            break
          }
          val += c
          i++
        }
        // Expect comma or end
        if (i < line.length && line[i] === ',') i++
        out.push(val)
      } else {
        // Unquoted field
        let j = i
        while (j < line.length && line[j] !== ',') j++
        const raw = line.slice(i, j)
        i = j + 1
        out.push(raw)
      }
    }
    rows.push(out)
  }
  return rows
}

function triggerCsvDownload(csvText, filename) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename || 'sheet.csv'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  setTimeout(() => URL.revokeObjectURL(url), 0)
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

function colLabel(n) {
  let c = n
  let s = ''
  while (c > 0) {
    const rem = (c - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    c = Math.floor((c - 1) / 26)
  }
  return s
}

function parseA1(a1) {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(String(a1 || ''))
  if (!m) return { row: 0, col: 0 }
  const letters = m[1].toUpperCase()
  const row = parseInt(m[2], 10)
  let col = 0
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64)
  }
  return { row, col }
}

function formatValue(v, format) {
  if (v == null) return ''
  if (typeof v === 'object' && v.code) return v.code
  if (Array.isArray(v)) return `[${v.join(', ')}]`
  
  // Apply number formatting if value is numeric
  let displayValue = v
  if (typeof v === 'number' && !isNaN(v)) {
    const precision = format?.precision !== undefined ? format.precision : 2
    
    if (format?.numberFormat === 'currency') {
      displayValue = '$' + v.toFixed(precision)
    } else if (format?.numberFormat === 'percentage') {
      displayValue = (v * 100).toFixed(precision) + '%'
    } else if (format?.precision !== undefined) {
      displayValue = v.toFixed(precision)
    }
  }
  
  return String(displayValue)
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


function SheetTabs({ sheets, active, onSelect, onAdd, onRename, onDelete }) {
  return (
    <div className="sheet-tabs">
      <div className="sheet-tabs-list">
        {sheets.map((name) => (
          <button
            key={name}
            className={name === active ? 'sheet-tab active' : 'sheet-tab'}
            onClick={() => onSelect && onSelect(name)}
            title={name}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="sheet-tabs-actions">
        <button className="sheet-action-btn" onClick={() => onRename && onRename(active)} title="Rename active sheet">Rename</button>
        <button className="sheet-action-btn" onClick={() => onDelete && onDelete(active)} title="Delete active sheet">Delete</button>
        <button className="sheet-add-btn" onClick={() => onAdd && onAdd()} title="Add sheet">＋</button>
      </div>
    </div>
  )
}

