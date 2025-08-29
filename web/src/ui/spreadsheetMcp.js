import * as acorn from 'acorn'
import { registerBuiltins } from 'autosheet'
import { loadScriptsFromStorage, saveScriptsToStorage } from './ScriptEditor.jsx'

// Resolve sheet-qualified single cell address like "Sheet2!A1"
function resolveSheetAndAddress(defaultSheet, address) {
  const m = /^([^!]+)!([^!]+)$/.exec(String(address))
  if (m) {
    return { sheet: String(m[1]), addr: String(m[2]).trim() }
  }
  return { sheet: String(defaultSheet), addr: String(address).trim() }
}

// Resolve sheet-qualified range like "Sheet2!A1:C3"
function resolveSheetAndRange(defaultSheet, rangeStr) {
  const m = /^([^!]+)!(.+)$/.exec(String(rangeStr))
  if (m) {
    return { sheet: String(m[1]), range: String(m[2]).trim() }
  }
  return { sheet: String(defaultSheet), range: String(rangeStr).trim() }
}

// Walk a result object and ensure cumulative string content <= limit chars.
// If exceeded, truncate the last string segment and append " TRUNCATED".
function enforceCharLimit(result, limit = 1000) {
  let used = 0
  let didTruncate = false
  const seen = new WeakSet()

  function walk(value) {
    if (value == null) return value
    if (typeof value === 'string') {
      const remaining = limit - used
      if (remaining <= 0) {
        if (!didTruncate) {
          didTruncate = true
          return 'TRUNCATED'
        }
        return ''
      }
      if (value.length <= remaining) {
        used += value.length
        return value
      }
      const suffix = ' TRUNCATED'
      const keep = Math.max(0, remaining - suffix.length)
      const truncated = value.slice(0, keep) + suffix
      used += truncated.length
      didTruncate = true
      return truncated
    }
    if (Array.isArray(value)) {
      return value.map((v) => walk(v))
    }
    if (typeof value === 'object') {
      if (seen.has(value)) return value
      seen.add(value)
      const out = {}
      for (const k of Object.keys(value)) {
        out[k] = walk(value[k])
      }
      return out
    }
    return value
  }

  const walked = walk(result)
  if (didTruncate && walked && typeof walked === 'object' && !Array.isArray(walked)) {
    // Append a clear note at the end of the object to indicate truncation
    // Property insertion order is preserved in JSON.stringify in practice
    walked.note = 'TRUNCATED'
  }
  return walked
}

// Keep only cells that have content and drop blank/invalid addresses.
function hasContent(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.length > 0
  return true
}

function filterRangeResult(res, mode) {
  const checkRaw = mode === 'raw' || mode === 'both'
  const checkComputed = mode === 'computed' || mode === 'both'
  const filteredRows = []
  for (const row of Array.isArray(res?.rows) ? res.rows : []) {
    const newRow = []
    for (const cell of Array.isArray(row) ? row : []) {
      const adr = cell && typeof cell.address === 'string' ? cell.address.trim() : ''
      if (!adr) continue
      const rawOk = checkRaw && hasContent(cell.raw)
      const compOk = checkComputed && hasContent(cell.computed)
      if (rawOk || compOk) {
        const kept = { address: adr }
        if (checkRaw && 'raw' in cell) kept.raw = cell.raw
        if (checkComputed && 'computed' in cell) kept.computed = cell.computed
        newRow.push(kept)
      }
    }
    if (newRow.length > 0) filteredRows.push(newRow)
  }
  return { sheet: res.sheet, range: res.range, rows: filteredRows }
}

export function getSpreadsheetTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'spreadsheet_get_cell',
        description: 'Reads a cell by A1 address from the spreadsheet. Supports raw value, computed value, or both.',
        parameters: {
          type: 'object',
          properties: {
            sheet: { type: 'string', description: 'Sheet name. Defaults to the active sheet.' },
            address: { type: 'string', description: 'A1 address, e.g., "A1".' },
            mode: { type: 'string', description: 'What to return: raw, computed, or both. Defaults to computed.', enum: ['raw','computed','both'] },
          },
          required: ['address'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'spreadsheet_set_cell',
        description: 'Writes a value or formula to a cell. Formulas must start with "=".',
        parameters: {
          type: 'object',
          properties: {
            sheet: { type: 'string', description: 'Sheet name. Defaults to the active sheet.' },
            address: { type: 'string', description: 'A1 address, e.g., "B2".' },
            value: { description: 'Value or formula string (e.g., "=SUM(A1:A3)").', anyOf: [ { type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' } ] },
          },
          required: ['address','value'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'spreadsheet_get_range',
        description: 'Reads a rectangular range (e.g., "A1:C3"). Returns only cells that have content according to the selected mode (raw, computed, or both). Empty/non-existent cells are omitted.',
        parameters: {
          type: 'object',
          properties: {
            sheet: { type: 'string', description: 'Sheet name. Defaults to the active sheet.' },
            range: { type: 'string', description: 'A1 range like "A1:C3".' },
            mode: { type: 'string', description: 'What to return per cell: raw, computed, or both. Defaults to computed.', enum: ['raw','computed','both'] },
          },
          required: ['range'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'spreadsheet_set_range',
        description: 'Writes a 2D array of values (or formulas) into a rectangular range (e.g., "A1:C3"). The provided matrix shape must match the range size. Response includes only cells that have content; empty/non-existent cells are omitted.',
        parameters: {
          type: 'object',
          properties: {
            sheet: { type: 'string', description: 'Sheet name. Defaults to the active sheet.' },
            range: { type: 'string', description: 'A1 range like "A1:C3".' },
            values: {
              type: 'array',
              description: '2D array of values to write. Outer array is rows; inner arrays are columns.',
              items: {
                type: 'array',
                items: { anyOf: [ { type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' } ] }
              }
            }
          },
          required: ['range','values'],
        },
      },
    },
    // ===== Script management tools =====
    {
      type: 'function',
      function: {
        name: 'spreadsheet_sheets_list',
        description: 'Lists all sheet names currently defined in the engine.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'spreadsheet_scripts_list',
        description: 'Lists all user scripts (id and name only). Call this before creating a new script.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'spreadsheet_scripts_get',
        description: 'Reads a single script by id or name. Returns id, name, and content.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Script id.' },
            name: { type: 'string', description: 'Script file name.' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'spreadsheet_scripts_get_all',
        description: 'Reads all scripts with full content.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'spreadsheet_scripts_create',
        description: 'Creates a new script in full mode. By default, add new functions to an existing script file (choose the most logical one, find out which ones exist using the spreadsheet_scripts_list tool) and only create a new file if the user explicitly asks for it. Provide the entire file content; name must end with .js and be unique.\n\nCustom functions guide\n- Define top-level functions: function Name(args) { ... }\n- They become available in formulas by name; names starting with \'_\' are ignored.\n- args: array of evaluated arguments from the cell formula\n- Use built-ins via the BUILTINS helper injected into your script\'s scope.\n  Example: function DoubleSum(args) { return BUILTINS.SUM(args) * 2 }\n\nExample function:\nfunction Abc(args) {\n  const x = Number(args?.[0] ?? 0)\n  return x + 1\n}',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'File name, e.g., script2.js' },
            content: { type: 'string', description: 'Full script content.' },
          },
          required: ['name','content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'spreadsheet_scripts_update',
        description: 'Edits an existing script in full mode. This is the preferred way to add new functions: update an existing logical script file unless the user explicitly requests creating a new file. Identify by id or name. Provide the entire new content for the file; optionally rename with new_name (must end with .js).\n\nCustom functions guide\n- Define top-level functions: function Name(args) { ... }\n- They become available in formulas by name; names starting with \'_\' are ignored.\n- args: array of evaluated arguments from the cell formula\n- Use built-ins via the BUILTINS helper injected into your script\'s scope.\n  Example: function DoubleSum(args) { return BUILTINS.SUM(args) * 2 }\n\nExample function:\nfunction Abc(args) {\n  const x = Number(args?.[0] ?? 0)\n  return x + 1\n}',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Script id.' },
            name: { type: 'string', description: 'Script file name (alternative to id).' },
            content: { type: 'string', description: 'Full new content to replace the script with.' },
            new_name: { type: 'string', description: 'Optional new file name ending with .js' },
          },
          required: ['content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'spreadsheet_scripts_delete',
        description: 'Deletes a script by id or name.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Script id.' },
            name: { type: 'string', description: 'Script file name.' },
          },
        },
      },
    },
  ]
}

export function isSpreadsheetToolName(name) {
  return name === 'spreadsheet_get_cell'
    || name === 'spreadsheet_set_cell'
    || name === 'spreadsheet_get_range'
    || name === 'spreadsheet_set_range'
    || name === 'spreadsheet_sheets_list'
    || name === 'spreadsheet_scripts_list'
    || name === 'spreadsheet_scripts_get'
    || name === 'spreadsheet_scripts_get_all'
    || name === 'spreadsheet_scripts_create'
    || name === 'spreadsheet_scripts_update'
    || name === 'spreadsheet_scripts_delete'
}

export async function runSpreadsheetTool(name, args, ctx) {
  let sheet = String(args?.sheet || ctx?.activeSheet || '')
  const { engine } = ctx || {}
  if (!engine) throw new Error('Spreadsheet engine unavailable')
  if (!sheet) {
    const first = (engine && engine.sheets && typeof engine.sheets.keys === 'function') ? engine.sheets.keys().next().value : null
    sheet = first || 'Sheet1'
  }

  if (name === 'spreadsheet_get_cell') {
    const addressInput = String(args?.address || '').trim()
    if (!addressInput) throw new Error('Missing address')
    const mode = (args?.mode === 'raw' || args?.mode === 'both') ? args.mode : 'computed'
    const { sheet: resolvedSheet, addr } = resolveSheetAndAddress(sheet, addressInput)
    const out = { sheet: resolvedSheet, address: addr }

    // Read values first so we can explicitly signal emptiness and avoid undefined keys being omitted
    let rawVal
    let compVal
    if (mode === 'raw' || mode === 'both') rawVal = engine.getCell(resolvedSheet, addr)
    if (mode === 'computed' || mode === 'both') compVal = engine.evaluateCell(resolvedSheet, addr)

    if (mode === 'raw' || mode === 'both') {
      const rawEmpty = rawVal === undefined || (typeof rawVal === 'string' && rawVal.length === 0)
      out.raw = rawEmpty ? null : rawVal
      if (rawEmpty) out.emptyRaw = true
    }
    if (mode === 'computed' || mode === 'both') {
      const compEmpty = compVal === undefined || (typeof compVal === 'string' && compVal.length === 0)
      out.computed = compEmpty ? null : compVal
      if (compEmpty) out.emptyComputed = true
    }

    if (mode === 'raw') {
      out.empty = !!out.emptyRaw
    } else if (mode === 'computed') {
      out.empty = !!out.emptyComputed
    } else {
      out.empty = !!(out.emptyRaw && out.emptyComputed)
    }
    return enforceCharLimit(out)
  }

  if (name === 'spreadsheet_set_cell') {
    const addressInput = String(args?.address || '').trim()
    if (!addressInput) throw new Error('Missing address')
    if (!('value' in args)) throw new Error('Missing value')
    const value = args.value
    const { sheet: resolvedSheet, addr } = resolveSheetAndAddress(sheet, addressInput)
    // If the target sheet does not exist, return an MCP error result instead of creating it implicitly
    const sheetExists = !!(engine && engine.sheets && typeof engine.sheets.has === 'function' && engine.sheets.has(resolvedSheet))
    if (!sheetExists) {
      return { error: `Sheet '${resolvedSheet}' does not exist` }
    }
    engine.setCell(resolvedSheet, addr, value)
    if (typeof ctx?.onEngineMutated === 'function') ctx.onEngineMutated()
    const computed = engine.evaluateCell(resolvedSheet, addr)
    return enforceCharLimit({ ok: true, sheet: resolvedSheet, address: addr, raw: engine.getCell(resolvedSheet, addr), computed })
  }

  if (name === 'spreadsheet_get_range') {
    const rangeInput = String(args?.range || '').trim()
    if (!rangeInput) throw new Error('Missing range')
    const mode = (args?.mode === 'raw' || args?.mode === 'both') ? args.mode : 'computed'
    const { sheet: resolvedSheet, range } = resolveSheetAndRange(sheet, rangeInput)
    const res = engine.getRange(resolvedSheet, range, mode)
    const filtered = filterRangeResult(res, mode)
    return enforceCharLimit(filtered)
  }

  if (name === 'spreadsheet_set_range') {
    const rangeInput = String(args?.range || '').trim()
    if (!rangeInput) throw new Error('Missing range')
    const values = Array.isArray(args?.values) ? args.values : null
    if (!values || values.length === 0 || !values.every((row) => Array.isArray(row))) {
      throw new Error('values must be a non-empty 2D array')
    }
    const { sheet: resolvedSheet, range } = resolveSheetAndRange(sheet, rangeInput)
    // If the target sheet does not exist, return an MCP error result instead of creating it implicitly
    const sheetExists = !!(engine && engine.sheets && typeof engine.sheets.has === 'function' && engine.sheets.has(resolvedSheet))
    if (!sheetExists) {
      return { error: `Sheet '${resolvedSheet}' does not exist` }
    }
    const res = engine.setRange(resolvedSheet, range, values)
    if (typeof ctx?.onEngineMutated === 'function') ctx.onEngineMutated()
    const filtered = filterRangeResult(res, 'both')
    return enforceCharLimit(filtered)
  }

  if (name === 'spreadsheet_sheets_list') {
    const names = Array.from((engine && engine.sheets && typeof engine.sheets.keys === 'function') ? engine.sheets.keys() : [])
    return names.map((n) => String(n))
  }

  // ===== Script management handlers =====
  if (name === 'spreadsheet_scripts_list') {
    const scripts = safeLoadScripts()
    return scripts.map((s) => ({ id: s.id, name: s.name }))
  }

  if (name === 'spreadsheet_scripts_get') {
    const scripts = safeLoadScripts()
    const id = typeof args?.id === 'string' ? args.id : null
    const nm = typeof args?.name === 'string' ? args.name : null
    if (!id && !nm) throw new Error('Provide id or name')
    const script = scripts.find((s) => (id && s.id === id) || (nm && s.name === nm))
    if (!script) throw new Error('Script not found')
    return { id: script.id, name: script.name, content: script.content || '' }
  }

  if (name === 'spreadsheet_scripts_get_all') {
    const scripts = safeLoadScripts()
    return scripts.map((s) => ({ id: s.id, name: s.name, content: s.content || '' }))
  }

  if (name === 'spreadsheet_scripts_create') {
    const scripts = safeLoadScripts()
    const nameArg = String(args?.name || '').trim()
    const content = String(args?.content ?? '')
    if (!nameArg || !/^[^\s]+\.js$/i.test(nameArg)) throw new Error('Invalid name (must end with .js and contain no spaces)')
    if (scripts.some((s) => s.name === nameArg)) throw new Error('A script with that name already exists')
    const id = crypto.randomUUID()
    const next = [...scripts, { id, name: nameArg, content }]
    saveScriptsToStorage(next)
    emitScriptsUpdated(next)
    await compileAndRegisterScripts(engine, next)
    if (typeof ctx?.onEngineMutated === 'function') ctx.onEngineMutated()
    return { ok: true, id, name: nameArg }
  }

  if (name === 'spreadsheet_scripts_update') {
    const scripts = safeLoadScripts()
    const id = typeof args?.id === 'string' ? args.id : null
    const nm = typeof args?.name === 'string' ? args.name : null
    if (!id && !nm) throw new Error('Provide id or name')
    const idx = scripts.findIndex((s) => (id && s.id === id) || (nm && s.name === nm))
    if (idx === -1) throw new Error('Script not found')
    const full = String(args?.content ?? '')
    const newNameRaw = args?.new_name
    let newName = scripts[idx].name
    if (typeof newNameRaw === 'string' && newNameRaw.trim()) {
      if (!/^[^\s]+\.js$/i.test(newNameRaw)) throw new Error('new_name must end with .js and contain no spaces')
      const duplicate = scripts.some((s, i) => i !== idx && s.name === newNameRaw)
      if (duplicate) throw new Error('A script with that name already exists')
      newName = newNameRaw
    }
    const updated = scripts.slice()
    updated[idx] = { ...updated[idx], name: newName, content: full }
    saveScriptsToStorage(updated)
    emitScriptsUpdated(updated)
    await compileAndRegisterScripts(engine, updated)
    if (typeof ctx?.onEngineMutated === 'function') ctx.onEngineMutated()
    return { ok: true, id: updated[idx].id, name: updated[idx].name }
  }

  if (name === 'spreadsheet_scripts_delete') {
    const scripts = safeLoadScripts()
    const id = typeof args?.id === 'string' ? args.id : null
    const nm = typeof args?.name === 'string' ? args.name : null
    if (!id && !nm) throw new Error('Provide id or name')
    const idx = scripts.findIndex((s) => (id && s.id === id) || (nm && s.name === nm))
    if (idx === -1) throw new Error('Script not found')
    const remaining = scripts.filter((_, i) => i !== idx)
    saveScriptsToStorage(remaining)
    emitScriptsUpdated(remaining)
    await compileAndRegisterScripts(engine, remaining)
    if (typeof ctx?.onEngineMutated === 'function') ctx.onEngineMutated()
    return { ok: true }
  }

  return null
}

// ===== Helpers =====
function safeLoadScripts() {
  try {
    const arr = loadScriptsFromStorage()
    if (Array.isArray(arr)) return arr
  } catch {}
  return []
}

async function compileAndRegisterScripts(engine, allScripts) {
  // Build a combined script, gather top-level function declarations, and safely rebuild registry
  const combined = allScripts.map((s) => String(s.content || '')).join('\n\n')
  // Parse for function names (ignore names starting with '_')
  const ast = acorn.parse(combined, { ecmaVersion: 'latest', sourceType: 'script' })
  const functionNames = []
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' && node.id && node.id.name && !node.id.name.startsWith('_')) {
      functionNames.push(node.id.name)
    }
  }
  const exportList = functionNames.map((n) => `${n}: typeof ${n} !== 'undefined' ? ${n} : undefined`).join(', ')
  const wrapper = `"use strict";\n${combined}\n;return { ${exportList} };`

  const NewRegistryClass = engine.registry.constructor
  const newRegistry = new NewRegistryClass()
  registerBuiltins(newRegistry)

  const builtinsHelper = {}
  for (const name of newRegistry.names()) {
    if (name === 'BUILTINS') continue
    builtinsHelper[name] = (...fnArgs) => newRegistry.get(name)(fnArgs)
  }
  const bag = Function('BUILTINS', wrapper)(builtinsHelper)
  for (const fnName of functionNames) {
    const fn = bag[fnName]
    if (typeof fn === 'function') newRegistry.register(fnName, fn)
  }
  engine.registry = newRegistry
}

function emitScriptsUpdated(scripts) {
  try {
    const evt = new CustomEvent('autosheet:scripts_updated', { detail: { scripts } })
    window.dispatchEvent(evt)
  } catch {}
}


