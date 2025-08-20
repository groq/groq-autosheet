import { parseFormula } from './parser.js';
import { BuiltinRegistry } from './registry.js';
import { CellError, ERROR, err, isCellError } from './errors.js';

/**
 * SpreadsheetEngine
 * - Pure calculation engine
 * - Cell addressing in A1 notation (case-insensitive)
 * - Supports literals, ranges (A1:B2), built-in functions, and custom functions
 * - Async-safe API (evaluation is synchronous for now, but can be extended)
 */
export class SpreadsheetEngine {
  constructor() {
    this.sheets = new Map(); // sheetName -> Map(cellAddrUpper -> value or formula string)
    this.registry = new BuiltinRegistry();
    // Built-in async/cached helpers (e.g., AI())
    this._aiCache = new Map(); // prompt(string) -> value(string)
    this._aiInFlight = new Map(); // prompt -> Promise
    this.onAsyncChange = null; // optional callback when async state updates
    this._aiFetcher = defaultAiFetcher; // overridable fetcher
  }

  addSheet(sheetName = 'Sheet1') {
    if (this.sheets.has(sheetName)) return sheetName;
    this.sheets.set(sheetName, new Map());
    return sheetName;
  }

  setCell(sheetName, address, valueOrFormula) {
    if (!this.sheets.has(sheetName)) this.addSheet(sheetName);
    const sheet = this.sheets.get(sheetName);
    sheet.set(address.toUpperCase(), valueOrFormula);
  }

  getCell(sheetName, address) {
    const sheet = this.sheets.get(sheetName);
    if (!sheet) return undefined;
    return sheet.get(address.toUpperCase());
  }

  registerFunction(name, fn) {
    this.registry.register(name, fn);
  }

  hasFunction(name) {
    return this.registry.has(name);
  }

  evaluateCell(sheetName, address, visiting = new Set()) {
    // Support absolute refs $A$1 and sheet-qualified refs in address
    const { sheet: resolvedSheet, addr: normalized } = normalizeAddress(address, sheetName);
    const key = `${resolvedSheet}!${normalized}`;
    if (visiting.has(key)) {
      return err(ERROR.CYCLE, 'Circular reference at ' + key);
    }
    visiting.add(key);

    const raw = this.getCell(resolvedSheet, normalized);
    let result;
    try {
      if (typeof raw === 'string' && raw.startsWith('=')) {
        const ast = parseFormula(raw.slice(1));
        result = this.evaluateAst(resolvedSheet, ast, visiting);
      } else {
        result = raw;
      }
    } catch (e) {
      result = err(ERROR.VALUE, String(e && (e.message || e)));
    } finally {
      visiting.delete(key);
    }
    return result;
  }

  evaluateAst(sheetName, node, visiting) {
    switch (node.type) {
      case 'Literal':
        return node.value;
      case 'Cell': {
        // node.ref may be sheet-qualified or absolute already
        return this.evaluateCell(sheetName, node.ref, visiting);
      }
      case 'Range': {
        const start = qualifyIfNeeded(node.start, sheetName);
        const end = qualifyIfNeeded(node.end, sheetName);
        const { sheet: sheetStart, addr: a1 } = normalizeAddress(start, sheetName);
        const { sheet: sheetEnd, addr: a2 } = normalizeAddress(end, sheetName);
        if (sheetStart !== sheetEnd) {
          return err(ERROR.REF, 'Cross-sheet ranges not supported');
        }
        const cells = expandRange(a1, a2);
        return cells.map((addr) => this.evaluateCell(sheetStart, addr, visiting));
      }
      case 'Call': {
        const fnName = node.name;
        const evaluatedArgs = node.args.map((arg) => {
          const val = this.evaluateAst(sheetName, arg, visiting);
          return val;
        });
        const fn = this.registry.get(fnName);
        if (!fn) return err(ERROR.NAME, `Unknown function: ${fnName}`);
        try {
          // Pass engine as second argument for built-ins that need context (e.g., AI())
          const res = fn(evaluatedArgs, this);
          return res;
        } catch (e) {
          return err(ERROR.VALUE, `Function ${fnName} error: ${String(e && (e.message || e))}`);
        }
      }
      case 'BinaryOp': {
        const leftVal = this.evaluateAst(sheetName, node.left, visiting);
        const rightVal = this.evaluateAst(sheetName, node.right, visiting);
        const left = coerceNumber(leftVal);
        const right = coerceNumber(rightVal);
        if (!Number.isFinite(left) || !Number.isFinite(right)) {
          return err(ERROR.VALUE, 'Arithmetic with non-numeric values');
        }
        switch (node.op) {
          case '+': return left + right;
          case '-': return left - right;
          case '*': return left * right;
          case '/': return right === 0 ? err(ERROR.DIV0, 'Division by zero') : left / right;
          default: return err(ERROR.VALUE, 'Unknown operator ' + node.op);
        }
      }
      default:
        return err(ERROR.VALUE, 'Unknown AST node: ' + node.type);
    }
  }

  // Range APIs
  getRange(sheetName, rangeStr, mode = 'computed') {
    const { sheet, start, end, rowsMin, rowsMax, colsMin, colsMax } = parseRangeRef(rangeStr, sheetName);
    const matrix = [];
    for (let r = rowsMin; r <= rowsMax; r++) {
      const rowArr = [];
      for (let c = colsMin; c <= colsMax; c++) {
        const address = rowColToA1(r, c);
        const cell = { address };
        if (mode === 'raw' || mode === 'both') cell.raw = this.getCell(sheet, address);
        if (mode === 'computed' || mode === 'both') cell.computed = this.evaluateCell(sheet, address);
        rowArr.push(cell);
      }
      matrix.push(rowArr);
    }
    return {
      sheet,
      range: `${rowColToA1(rowsMin, colsMin)}:${rowColToA1(rowsMax, colsMax)}`,
      rows: matrix,
    };
  }

  setRange(sheetName, rangeStr, values) {
    if (!Array.isArray(values) || values.length === 0 || !values.every((row) => Array.isArray(row))) {
      throw new Error('values must be a non-empty 2D array');
    }
    const { sheet, start, end, rowsMin, rowsMax, colsMin, colsMax } = parseRangeRef(rangeStr, sheetName);
    const rowCount = rowsMax - rowsMin + 1;
    const colCount = colsMax - colsMin + 1;
    if (values.length !== rowCount || values.some((row) => row.length !== colCount)) {
      const providedCols = values[0] ? values[0].length : 0;
      throw new Error(`values shape ${values.length}x${providedCols} does not match range size ${rowCount}x${colCount}`);
    }

    for (let i = 0; i < rowCount; i++) {
      for (let j = 0; j < colCount; j++) {
        const r = rowsMin + i;
        const c = colsMin + j;
        const address = rowColToA1(r, c);
        this.setCell(sheet, address, values[i][j]);
      }
    }

    const resultRows = [];
    for (let i = 0; i < rowCount; i++) {
      const rowArr = [];
      for (let j = 0; j < colCount; j++) {
        const r = rowsMin + i;
        const c = colsMin + j;
        const address = rowColToA1(r, c);
        rowArr.push({ address, raw: this.getCell(sheet, address), computed: this.evaluateCell(sheet, address) });
      }
      resultRows.push(rowArr);
    }

    return {
      ok: true,
      sheet,
      range: `${rowColToA1(rowsMin, colsMin)}:${rowColToA1(rowsMax, colsMax)}`,
      rows: resultRows,
    };
  }

  // ===== AI cache/fetch helpers =====
  setAiFetcher(fetcherFn) {
    if (typeof fetcherFn === 'function') this._aiFetcher = fetcherFn;
  }

  getAiCached(prompt) {
    const key = String(prompt || '');
    return this._aiCache.has(key) ? this._aiCache.get(key) : undefined;
  }

  hasAiCached(prompt) {
    const key = String(prompt || '');
    return this._aiCache.has(key);
  }

  async _fetchAndCacheAi(prompt) {
    const key = String(prompt || '');
    if (this._aiInFlight.has(key)) return this._aiInFlight.get(key);
    const p = (async () => {
      try {
        const val = await this._aiFetcher(key);
        this._aiCache.set(key, val == null ? '' : String(val));
      } catch (e) {
        // Store an error string so subsequent evaluations are stable
        this._aiCache.set(key, String(e && (e.message || e)));
      } finally {
        this._aiInFlight.delete(key);
        if (typeof this.onAsyncChange === 'function') {
          try { this.onAsyncChange({ type: 'AI_CACHE_UPDATED', prompt: key }); } catch {}
        }
      }
    })();
    this._aiInFlight.set(key, p);
    return p;
  }

  requestAi(prompt) {
    const key = String(prompt || '');
    if (this._aiCache.has(key) || this._aiInFlight.has(key)) return;
    void this._fetchAndCacheAi(key);
  }
}

// Utilities
export function a1ToRowCol(a1) {
  const m = parseAbsoluteA1(a1);
  if (!m) throw new Error('Invalid A1 ref: ' + a1);
  const colStr = m.col.toUpperCase();
  const row = parseInt(m.row, 10);
  let col = 0;
  for (let i = 0; i < colStr.length; i++) {
    col = col * 26 + (colStr.charCodeAt(i) - 64);
  }
  return { row, col };
}

export function rowColToA1(row, col) {
  let c = col;
  let colStr = '';
  while (c > 0) {
    const rem = (c - 1) % 26;
    colStr = String.fromCharCode(65 + rem) + colStr;
    c = Math.floor((c - 1) / 26);
  }
  return `${colStr}${row}`;
}

export function expandRange(startA1, endA1) {
  const { row: r1, col: c1 } = a1ToRowCol(startA1);
  const { row: r2, col: c2 } = a1ToRowCol(endA1);
  const rows = [Math.min(r1, r2), Math.max(r1, r2)];
  const cols = [Math.min(c1, c2), Math.max(c1, c2)];
  const out = [];
  for (let r = rows[0]; r <= rows[1]; r++) {
    for (let c = cols[0]; c <= cols[1]; c++) {
      out.push(rowColToA1(r, c));
    }
  }
  return out;
}

// Address utilities
export function parseAbsoluteA1(a1) {
  // Supports optional $ for column and/or row
  const match = /^(\$?)([A-Za-z]+)(\$?)(\d+)$/.exec(a1);
  if (!match) return null;
  const [, colAbs, col, rowAbs, row] = match;
  return { colAbs: !!colAbs, col, rowAbs: !!rowAbs, row };
}

export function normalizeAddress(address, defaultSheet) {
  // Handle sheet-qualified refs like Sheet1!A1 or 'My Sheet'!A1 (quotes not supported yet)
  const m = /^([^!]+)!([^!]+)$/.exec(address);
  if (m) {
    const sheet = m[1];
    const a1 = m[2];
    const abs = parseAbsoluteA1(a1);
    if (!abs) throw new Error('Invalid A1: ' + a1);
    return { sheet, addr: `${abs.col.toUpperCase()}${parseInt(abs.row, 10)}` };
  }
  const abs = parseAbsoluteA1(address);
  if (!abs) throw new Error('Invalid A1: ' + address);
  return { sheet: defaultSheet, addr: `${abs.col.toUpperCase()}${parseInt(abs.row, 10)}` };
}

export function qualifyIfNeeded(address, defaultSheet) {
  if (/^[^!]+![^!]+$/.test(address)) return address;
  return `${defaultSheet}!${address}`;
}

// Parses ranges like "A1:C3" or "Sheet1!A1:C3".
// Returns normalized sheet name and numeric bounds for iteration.
function parseRangeRef(rangeStr, defaultSheet) {
  const input = String(rangeStr).trim();
  if (!input) throw new Error('Missing range');

  let sheet = defaultSheet;
  let startStr;
  let endStr;
  const sheetMatch = /^([^!]+)!([^:]+):([^:]+)$/.exec(input);
  if (sheetMatch) {
    sheet = sheetMatch[1];
    startStr = sheetMatch[2];
    endStr = sheetMatch[3];
  } else {
    const parts = input.split(':');
    if (parts.length !== 2) throw new Error('Invalid range (expected A1:B2)');
    startStr = parts[0].trim();
    endStr = parts[1].trim();
  }

  const { addr: start } = normalizeAddress(startStr, sheet);
  const { addr: end } = normalizeAddress(endStr, sheet);

  const { row: r1, col: c1 } = a1ToRowCol(start);
  const { row: r2, col: c2 } = a1ToRowCol(end);
  const rowsMin = Math.min(r1, r2);
  const rowsMax = Math.max(r1, r2);
  const colsMin = Math.min(c1, c2);
  const colsMax = Math.max(c1, c2);

  return { sheet, start, end, rowsMin, rowsMax, colsMin, colsMax };
}

function coerceNumber(v) {
  if (typeof v === 'number') return v;
  if (v == null) return NaN;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isNaN(n) ? NaN : n;
  }
  return NaN;
}


// Default AI fetcher: calls the app's Groq proxy using the same model as Chat settings
async function defaultAiFetcher(prompt) {
  // Attempt to read model from localStorage when in browser
  let model = 'openai/gpt-oss-20b';
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const m = window.localStorage.getItem('autosheet.chat.model');
      if (m) model = m;
    }
  } catch {}

  if (typeof fetch !== 'function') {
    throw new Error('fetch unavailable for AI');
  }
  const base = (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : '';
  const url = (base ? base : '') + '/api/groq/openai/v1/chat/completions';
  const body = {
    model,
    messages: [
      { role: 'system', content: 'You are asked to produce a value output that will be rendered directly in the cell of a spreadsheet so keep it brief.' },
      { role: 'user', content: String(prompt || '') },
    ],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error('AI request failed: ' + res.status + (txt ? ' ' + txt : ''));
  }
  const json = await res.json();
  const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  return content == null ? '' : String(content);
}

