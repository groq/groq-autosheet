export class BuiltinRegistry {
  constructor() {
    // Internal storage is case-insensitive via uppercase key, while preserving
    // the original registration name for display and tooling.
    this.map = new Map(); // UPPERCASE name -> function(argsArray, ctx)
    this.originalNames = new Map(); // UPPERCASE name -> originalCaseName
  }

  register(name, fn) {
    const key = name.toUpperCase();
    this.map.set(key, fn);
    this.originalNames.set(key, name);
  }

  has(name) {
    return this.map.has(name.toUpperCase());
  }

  get(name) {
    return this.map.get(name.toUpperCase());
  }

  names() {
    return Array.from(this.originalNames.values());
  }
}


