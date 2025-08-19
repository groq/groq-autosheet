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
        description: 'Reads a rectangular range (e.g., "A1:C3"). Returns a matrix of cell data according to the selected mode.',
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
        description: 'Writes a 2D array of values (or formulas) into a rectangular range (e.g., "A1:C3"). The provided matrix shape must match the range size.',
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
  ]
}

export function isSpreadsheetToolName(name) {
  return name === 'spreadsheet_get_cell'
    || name === 'spreadsheet_set_cell'
    || name === 'spreadsheet_get_range'
    || name === 'spreadsheet_set_range'
}

export async function runSpreadsheetTool(name, args, ctx) {
  const sheet = String(args?.sheet || ctx?.activeSheet || 'Sheet1')
  const { engine } = ctx || {}
  if (!engine) throw new Error('Spreadsheet engine unavailable')

  if (name === 'spreadsheet_get_cell') {
    const address = String(args?.address || '').trim()
    if (!address) throw new Error('Missing address')
    const mode = (args?.mode === 'raw' || args?.mode === 'both') ? args.mode : 'computed'
    const out = { sheet, address }
    if (mode === 'raw' || mode === 'both') out.raw = engine.getCell(sheet, address)
    if (mode === 'computed' || mode === 'both') out.computed = engine.evaluateCell(sheet, address)
    return out
  }

  if (name === 'spreadsheet_set_cell') {
    const address = String(args?.address || '').trim()
    if (!address) throw new Error('Missing address')
    if (!('value' in args)) throw new Error('Missing value')
    const value = args.value
    engine.setCell(sheet, address, value)
    if (typeof ctx?.onEngineMutated === 'function') ctx.onEngineMutated()
    const computed = engine.evaluateCell(sheet, address)
    return { ok: true, sheet, address, raw: engine.getCell(sheet, address), computed }
  }

  if (name === 'spreadsheet_get_range') {
    const rangeStr = String(args?.range || '').trim()
    if (!rangeStr) throw new Error('Missing range')
    const { start, end } = parseRange(rangeStr)
    const { row: r1, col: c1 } = a1ToRowCol(start)
    const { row: r2, col: c2 } = a1ToRowCol(end)
    const rows = [Math.min(r1, r2), Math.max(r1, r2)]
    const cols = [Math.min(c1, c2), Math.max(c1, c2)]
    const mode = (args?.mode === 'raw' || args?.mode === 'both') ? args.mode : 'computed'
    const matrix = []
    for (let r = rows[0]; r <= rows[1]; r++) {
      const rowArr = []
      for (let c = cols[0]; c <= cols[1]; c++) {
        const address = rowColToA1(r, c)
        const cell = { address }
        if (mode === 'raw' || mode === 'both') cell.raw = engine.getCell(sheet, address)
        if (mode === 'computed' || mode === 'both') cell.computed = engine.evaluateCell(sheet, address)
        rowArr.push(cell)
      }
      matrix.push(rowArr)
    }
    return { sheet, range: `${rowColToA1(rows[0], cols[0])}:${rowColToA1(rows[1], cols[1])}`, rows: matrix }
  }

  if (name === 'spreadsheet_set_range') {
    const rangeStr = String(args?.range || '').trim()
    if (!rangeStr) throw new Error('Missing range')
    const values = Array.isArray(args?.values) ? args.values : null
    if (!values || values.length === 0 || !values.every((row) => Array.isArray(row))) {
      throw new Error('values must be a non-empty 2D array')
    }
    const { start, end } = parseRange(rangeStr)
    const { row: r1, col: c1 } = a1ToRowCol(start)
    const { row: r2, col: c2 } = a1ToRowCol(end)
    const rowCount = Math.abs(r2 - r1) + 1
    const colCount = Math.abs(c2 - c1) + 1
    if (values.length !== rowCount || values.some((row) => row.length !== colCount)) {
      throw new Error(`values shape ${values.length}x${values[0]?.length ?? 0} does not match range size ${rowCount}x${colCount}`)
    }
    // Write values
    for (let i = 0; i < rowCount; i++) {
      for (let j = 0; j < colCount; j++) {
        const r = Math.min(r1, r2) + i
        const c = Math.min(c1, c2) + j
        const address = rowColToA1(r, c)
        engine.setCell(sheet, address, values[i][j])
      }
    }
    if (typeof ctx?.onEngineMutated === 'function') ctx.onEngineMutated()
    // Return echo with computed values
    const resultRows = []
    for (let i = 0; i < rowCount; i++) {
      const rowArr = []
      for (let j = 0; j < colCount; j++) {
        const r = Math.min(r1, r2) + i
        const c = Math.min(c1, c2) + j
        const address = rowColToA1(r, c)
        rowArr.push({ address, raw: engine.getCell(sheet, address), computed: engine.evaluateCell(sheet, address) })
      }
      resultRows.push(rowArr)
    }
    return { ok: true, sheet, range: `${rowColToA1(Math.min(r1, r2), Math.min(c1, c2))}:${rowColToA1(Math.max(r1, r2), Math.max(c1, c2))}`, rows: resultRows }
  }

  return null
}

function parseRange(rangeStr) {
  const parts = String(rangeStr).split(':')
  if (parts.length !== 2) throw new Error('Invalid range (expected A1:B2)')
  const start = parts[0].trim()
  const end = parts[1].trim()
  if (!/^\$?[A-Za-z]+\$?\d+$/.test(start) || !/^\$?[A-Za-z]+\$?\d+$/.test(end)) {
    throw new Error('Invalid A1 in range')
  }
  return { start, end }
}

function a1ToRowCol(a1) {
  const m = /^(\$?)([A-Za-z]+)(\$?)(\d+)$/.exec(a1)
  if (!m) throw new Error('Invalid A1 ref: ' + a1)
  const colStr = m[2].toUpperCase()
  const row = parseInt(m[4], 10)
  let col = 0
  for (let i = 0; i < colStr.length; i++) {
    col = col * 26 + (colStr.charCodeAt(i) - 64)
  }
  return { row, col }
}

function rowColToA1(row, col) {
  let c = col
  let colStr = ''
  while (c > 0) {
    const rem = (c - 1) % 26
    colStr = String.fromCharCode(65 + rem) + colStr
    c = Math.floor((c - 1) / 26)
  }
  return `${colStr}${row}`
}


