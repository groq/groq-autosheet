import { flattenArgsToValues, coerceToNumberArray, truthy, ensureArray } from './utils.js';
import { ERROR, err, isCellError } from '../errors.js';

export function registerBuiltins(registry) {
  // Math/aggregate
  registry.register('SUM', (args) => {
    const values = coerceToNumberArray(flattenArgsToValues(args));
    return values.reduce((a, b) => a + b, 0);
  });

  registry.register('AVERAGE', (args) => {
    const values = coerceToNumberArray(flattenArgsToValues(args));
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  });

  registry.register('MIN', (args) => {
    const values = coerceToNumberArray(flattenArgsToValues(args));
    if (values.length === 0) return 0;
    return Math.min(...values);
  });

  registry.register('MAX', (args) => {
    const values = coerceToNumberArray(flattenArgsToValues(args));
    if (values.length === 0) return 0;
    return Math.max(...values);
  });

  registry.register('COUNT', (args) => {
    const values = flattenArgsToValues(args);
    // COUNT counts numbers only (like Sheets)
    return values.filter((v) => typeof v === 'number' && Number.isFinite(v)).length;
  });

  registry.register('COUNTA', (args) => {
    const values = flattenArgsToValues(args);
    return values.filter((v) => v !== null && v !== undefined && v !== '').length;
  });

  // Logical
  registry.register('IF', (args) => {
    const [cond, thenVal, elseVal] = ensureArray(args, 3);
    return truthy(cond) ? thenVal : elseVal;
  });

  registry.register('AND', (args) => {
    for (const a of flattenArgsToValues(args)) {
      if (!truthy(a)) return false;
    }
    return true;
  });

  registry.register('OR', (args) => {
    for (const a of flattenArgsToValues(args)) {
      if (truthy(a)) return true;
    }
    return false;
  });

  registry.register('NOT', (args) => {
    const [val] = ensureArray(args, 1);
    return !truthy(val);
  });

  // Comparison helpers (equal, gt, etc.)
  registry.register('EQ', (args) => {
    const [a, b] = ensureArray(args, 2);
    return a === b;
  });
  registry.register('NE', (args) => {
    const [a, b] = ensureArray(args, 2);
    return a !== b;
  });
  registry.register('GT', (args) => {
    const [a, b] = ensureArray(args, 2);
    return a > b;
  });
  registry.register('GTE', (args) => {
    const [a, b] = ensureArray(args, 2);
    return a >= b;
  });
  registry.register('LT', (args) => {
    const [a, b] = ensureArray(args, 2);
    return a < b;
  });
  registry.register('LTE', (args) => {
    const [a, b] = ensureArray(args, 2);
    return a <= b;
  });

  // Text
  registry.register('CONCAT', (args) => {
    return flattenArgsToValues(args).map((v) => (v == null ? '' : String(v))).join('');
  });

  registry.register('LEN', (args) => {
    const [v] = ensureArray(args, 1);
    return (v == null ? '' : String(v)).length;
  });

  registry.register('UPPER', (args) => {
    const [v] = ensureArray(args, 1);
    return (v == null ? '' : String(v)).toUpperCase();
  });

  registry.register('LOWER', (args) => {
    const [v] = ensureArray(args, 1);
    return (v == null ? '' : String(v)).toLowerCase();
  });

  // Basic wrappers to call built-ins from user JS conveniently
  registry.register('BUILTINS', (_args) => {
    // Returns a helper object exposing built-ins by name
    const helper = {};
    for (const name of registry.names()) {
      if (name === 'BUILTINS') continue;
      helper[name] = (...fnArgs) => registry.get(name)(fnArgs);
    }
    return helper;
  });

  // Conditional/lookup functions
  registry.register('COUNTIF', (args) => {
    const [range, criterion] = ensureArray(args, 2);
    const arr = Array.isArray(range) ? range : [range];
    let pred = buildCriterion(criterion);
    return arr.filter((v) => pred(v)).length;
  });

  registry.register('SUMIF', (args) => {
    const [range, criterion, sumRange] = ensureArray(args, 3);
    const base = Array.isArray(range) ? range : [range];
    const sumArr = Array.isArray(sumRange) ? sumRange : base;
    const pred = buildCriterion(criterion);
    let total = 0;
    const n = Math.min(base.length, sumArr.length);
    for (let i = 0; i < n; i++) {
      if (pred(base[i])) {
        const val = sumArr[i];
        if (typeof val === 'number' && Number.isFinite(val)) total += val;
      }
    }
    return total;
  });

  registry.register('MATCH', (args) => {
    const [lookupValue, lookupArray, matchType = 1] = ensureArray(args, 3);
    const arr = Array.isArray(lookupArray) ? lookupArray : [lookupArray];
    if (matchType === 0) {
      // exact
      for (let i = 0; i < arr.length; i++) if (equals(lookupValue, arr[i])) return i + 1;
      return err(ERROR.NA, 'MATCH not found');
    }
    // approximate (1 or -1). For simplicity assume sorted ascending for 1, descending for -1
    if (matchType === 1) {
      let idx = -1;
      for (let i = 0; i < arr.length; i++) {
        if (compare(arr[i], lookupValue) <= 0) idx = i;
        else break;
      }
      if (idx === -1) return err(ERROR.NA, 'MATCH not found');
      return idx + 1;
    }
    if (matchType === -1) {
      let idx = -1;
      for (let i = 0; i < arr.length; i++) {
        if (compare(arr[i], lookupValue) >= 0) idx = i;
        else break;
      }
      if (idx === -1) return err(ERROR.NA, 'MATCH not found');
      return idx + 1;
    }
    return err(ERROR.VALUE, 'Invalid matchType');
  });

  registry.register('INDEX', (args) => {
    const [array, row, column] = ensureArray(args, 3);
    if (Array.isArray(array) && array.length > 0 && Array.isArray(array[0])) {
      // 2D array; minimal support from ranges currently returns 1D. Keep simple: if 2D, index [row-1][column-1]
      const r = (row || 1) - 1;
      const c = (column || 1) - 1;
      if (r < 0 || c < 0) return err(ERROR.REF, 'INDEX out of bounds');
      const rowArr = array[r];
      if (!rowArr || rowArr[c] === undefined) return err(ERROR.REF, 'INDEX out of bounds');
      return rowArr[c];
    } else {
      // 1D array
      const r = (row || 1) - 1;
      if (!Array.isArray(array)) return err(ERROR.VALUE, 'INDEX expects array');
      if (r < 0 || r >= array.length) return err(ERROR.REF, 'INDEX out of bounds');
      return array[r];
    }
  });

  registry.register('VLOOKUP', (args) => {
    const [searchKey, tableArray, index, isSorted = true] = ensureArray(args, 4);
    if (!Array.isArray(tableArray)) return err(ERROR.VALUE, 'VLOOKUP expects array');
    // Accept tableArray as array of rows; if range produced 1D, treat as list of rows with 1 column
    const rows = Array.isArray(tableArray[0]) ? tableArray : tableArray.map((v) => [v]);
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 1) return err(ERROR.VALUE, 'Invalid index');

    if (isSorted) {
      // approximate: find last row with first column <= searchKey
      let pick = -1;
      for (let r = 0; r < rows.length; r++) {
        const key = rows[r][0];
        if (compare(key, searchKey) <= 0) pick = r;
        else break;
      }
      if (pick === -1) return err(ERROR.NA, 'Not found');
      return rows[pick][idx - 1] ?? err(ERROR.REF, 'Index out of bounds');
    } else {
      // exact
      for (let r = 0; r < rows.length; r++) {
        if (equals(rows[r][0], searchKey)) return rows[r][idx - 1] ?? err(ERROR.REF, 'Index out of bounds');
      }
      return err(ERROR.NA, 'Not found');
    }
  });
}

function buildCriterion(criterion) {
  // Supports numbers/strings directly and simple operators like ">=10", "<5", "<>a"
  if (typeof criterion === 'number') return (v) => toNumberIfPossible(v) === criterion;
  const s = String(criterion);
  const m = /^(>=|<=|<>|=|>|<)?(.*)$/.exec(s);
  const op = m[1] || '=';
  const raw = m[2];
  const cmpVal = toNumberIfPossible(raw);
  return (v) => {
    const left = toNumberIfPossible(v);
    switch (op) {
      case '=': return equals(left, cmpVal);
      case '<>': return !equals(left, cmpVal);
      case '>': return compare(left, cmpVal) > 0;
      case '>=': return compare(left, cmpVal) >= 0;
      case '<': return compare(left, cmpVal) < 0;
      case '<=': return compare(left, cmpVal) <= 0;
      default: return equals(left, cmpVal);
    }
  };
}

function toNumberIfPossible(v) {
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
}

function equals(a, b) {
  return a === b;
}

function compare(a, b) {
  if (a === b) return 0;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}


