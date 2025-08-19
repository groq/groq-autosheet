// Minimal formula parser:
// Supports:
// - Literals: numbers (int/float), strings in double quotes
// - Cell refs: A1, a1, $A$1, $A1, A$1
// - Ranges: A1:B2
// - Function calls: NAME(arg1, arg2, ...)
// - Commas as argument separators
// - Unary +/- before number literals

export function parseFormula(input) {
  const ctx = { s: input.trim(), i: 0 };
  const node = parseExpr(ctx);
  skipWs(ctx);
  if (ctx.i !== ctx.s.length) {
    throw new Error('Unexpected input at position ' + ctx.i);
  }
  return node;
}

function parseExpr(ctx) {
  // expression with precedence: (*,/) over (+,-)
  skipWs(ctx);
  return parseAddSub(ctx);
}

function parseAddSub(ctx) {
  let node = parseMulDiv(ctx);
  while (true) {
    skipWs(ctx);
    const ch = peek(ctx);
    if (ch === '+' || ch === '-') {
      next(ctx);
      const right = parseMulDiv(ctx);
      node = { type: 'BinaryOp', op: ch, left: node, right };
      continue;
    }
    break;
  }
  return node;
}

function parseMulDiv(ctx) {
  let node = parseTerm(ctx);
  while (true) {
    skipWs(ctx);
    const ch = peek(ctx);
    if (ch === '*' || ch === '/') {
      next(ctx);
      const right = parseTerm(ctx);
      node = { type: 'BinaryOp', op: ch, left: node, right };
      continue;
    }
    break;
  }
  return node;
}

function parseTerm(ctx) {
  skipWs(ctx);
  // Function or Cell/Range or Literal
  const start = ctx.i;
  // Parenthesized expression
  if (peek(ctx) === '(') {
    next(ctx);
    const inner = parseExpr(ctx);
    skipWs(ctx);
    expect(ctx, ')');
    return inner;
  }
  // String literal
  if (peek(ctx) === '"') return parseString(ctx);
  // Number (with optional unary +/-)
  if (peek(ctx) === '+' || peek(ctx) === '-' || isDigit(peek(ctx))) {
    const tryNum = tryParseNumber(ctx);
    if (tryNum) return tryNum;
  }
  // Try sheet-qualified cell/range e.g., Sheet1!$A$1 or Sheet1!A1:B2
  const trySheet = tryParseSheetQualified(ctx);
  if (trySheet) return trySheet;
  // Identifier or cell
  if (isAlpha(peek(ctx)) || peek(ctx) === '$') {
    // Look ahead to see if this is a cell/range or a function name
    const ident = readWhile(ctx, (ch) => isAlpha(ch) || ch === '$');
    // If next is a digit -> it's a cell reference (supporting $)
    if (isDigit(peek(ctx))) {
      const rowAbs = readWhile(ctx, (ch) => ch === '$');
      const row = readWhile(ctx, (ch) => isDigit(ch));
      const cell = (ident + rowAbs + row).toUpperCase();
      skipWs(ctx);
      if (peek(ctx) === ':') {
        next(ctx); // consume ':'
        skipWs(ctx);
        const endRef = parseCellRef(ctx);
        return { type: 'Range', start: cell, end: endRef };
      }
      return { type: 'Cell', ref: cell };
    }
    // If next non-ws is '(' it's a function call
    skipWs(ctx);
    if (peek(ctx) === '(') {
      next(ctx); // consume '('
      const args = [];
      skipWs(ctx);
      if (peek(ctx) === ')') {
        next(ctx);
        return { type: 'Call', name: ident.toUpperCase(), args };
      }
      while (true) {
        const arg = parseExpr(ctx);
        args.push(arg);
        skipWs(ctx);
        if (peek(ctx) === ',') {
          next(ctx);
          continue;
        }
        if (peek(ctx) === ')') {
          next(ctx);
          break;
        }
        throw new Error('Expected , or ) in function call at ' + ctx.i);
      }
      return { type: 'Call', name: ident.toUpperCase(), args };
    }
    // Boolean literals TRUE/FALSE
    const upperIdent = ident.toUpperCase();
    if (upperIdent === 'TRUE') return { type: 'Literal', value: true };
    if (upperIdent === 'FALSE') return { type: 'Literal', value: false };
    // Otherwise treat as bare identifier string literal
    ctx.i = start;
  }
  throw new Error('Unable to parse term at ' + ctx.i);
}

function parseCellRef(ctx) {
  const col = readWhile(ctx, (ch) => isAlpha(ch) || ch === '$');
  const rowAbs = readWhile(ctx, (ch) => ch === '$');
  const row = readWhile(ctx, (ch) => isDigit(ch));
  if (!col || !row) throw new Error('Invalid cell reference at ' + ctx.i);
  return (col + rowAbs + row).toUpperCase();
}

function parseString(ctx) {
  expect(ctx, '"');
  let out = '';
  while (ctx.i < ctx.s.length) {
    const ch = next(ctx);
    if (ch === '"') break;
    if (ch === '\\') {
      const esc = next(ctx);
      if (esc === '"') out += '"';
      else if (esc === '\\') out += '\\';
      else if (esc === 'n') out += '\n';
      else if (esc === 't') out += '\t';
      else out += esc;
    } else {
      out += ch;
    }
  }
  return { type: 'Literal', value: out };
}

function tryParseNumber(ctx) {
  const start = ctx.i;
  if (peek(ctx) === '+' || peek(ctx) === '-') next(ctx);
  let seenDigit = false;
  while (isDigit(peek(ctx))) {
    seenDigit = true;
    next(ctx);
  }
  if (peek(ctx) === '.') {
    next(ctx);
    while (isDigit(peek(ctx))) {
      seenDigit = true;
      next(ctx);
    }
  }
  if (!seenDigit) {
    ctx.i = start;
    return null;
  }
  const numStr = ctx.s.slice(start, ctx.i);
  const num = Number(numStr);
  if (Number.isNaN(num)) {
    ctx.i = start;
    return null;
  }
  return { type: 'Literal', value: num };
}

function tryParseSheetQualified(ctx) {
  const start = ctx.i;
  // sheet name: letters, digits, underscore (no spaces for now)
  const sheet = readWhile(ctx, (ch) => isAlpha(ch) || isDigit(ch) || ch === '_');
  if (!sheet) {
    ctx.i = start;
    return null;
  }
  if (peek(ctx) !== '!') {
    ctx.i = start;
    return null;
  }
  next(ctx); // consume '!'
  // After '!' must be a cell ref (with optional $), possibly a range
  const cellStart = parseCellRef(ctx);
  skipWs(ctx);
  if (peek(ctx) === ':') {
    next(ctx);
    skipWs(ctx);
    const cellEnd = parseCellRef(ctx);
    return { type: 'Range', start: `${sheet}!${cellStart}`, end: `${sheet}!${cellEnd}` };
  }
  return { type: 'Cell', ref: `${sheet}!${cellStart}` };
}

// Helpers
function skipWs(ctx) {
  while (ctx.i < ctx.s.length && /\s/.test(ctx.s[ctx.i])) ctx.i++;
}
function readWhile(ctx, pred) {
  let out = '';
  while (ctx.i < ctx.s.length && pred(ctx.s[ctx.i])) out += ctx.s[ctx.i++];
  return out;
}
function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}
function isAlpha(ch) {
  const c = ch || '';
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}
function peek(ctx) {
  return ctx.s[ctx.i];
}
function next(ctx) {
  return ctx.s[ctx.i++];
}
function expect(ctx, ch) {
  const got = next(ctx);
  if (got !== ch) throw new Error(`Expected ${ch} got ${got}`);
}


