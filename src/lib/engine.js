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
    if (typeof raw === 'string' && raw.startsWith('=')) {
      const ast = parseFormula(raw.slice(1));
      result = this.evaluateAst(resolvedSheet, ast, visiting);
    } else {
      result = raw;
    }
    visiting.delete(key);
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
        const res = fn(evaluatedArgs);
        return res;
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

function coerceNumber(v) {
  if (typeof v === 'number') return v;
  if (v == null) return NaN;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isNaN(n) ? NaN : n;
  }
  return NaN;
}


