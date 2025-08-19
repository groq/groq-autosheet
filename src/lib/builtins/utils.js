export function ensureArray(args, n) {
  const out = new Array(n).fill(undefined);
  for (let i = 0; i < n; i++) out[i] = args[i];
  return out;
}

export function flattenArgsToValues(args) {
  const out = [];
  for (const a of args) {
    if (Array.isArray(a)) {
      for (const v of a) out.push(v);
    } else {
      out.push(a);
    }
  }
  return out;
}

export function coerceToNumberArray(values) {
  const out = [];
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    else if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) out.push(Number(v));
  }
  return out;
}

export function truthy(v) {
  return !!v;
}


