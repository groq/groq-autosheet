import { describe, it, expect } from 'vitest';
import { SpreadsheetEngine, registerBuiltins } from '../src/index.js';

describe('SpreadsheetEngine', () => {
  it('evaluates literals and cell refs', () => {
    const engine = new SpreadsheetEngine();
    registerBuiltins(engine.registry);
    engine.addSheet('Sheet1');
    engine.setCell('Sheet1', 'A1', 2);
    engine.setCell('Sheet1', 'A2', '=A1');
    expect(engine.evaluateCell('Sheet1', 'A2')).toBe(2);
  });

  it('handles SUM, AVERAGE, MIN, MAX, COUNT, COUNTA', () => {
    const engine = new SpreadsheetEngine();
    registerBuiltins(engine.registry);
    engine.addSheet('S');
    engine.setCell('S', 'A1', 1);
    engine.setCell('S', 'A2', 2);
    engine.setCell('S', 'A3', 3);
    engine.setCell('S', 'B1', '=SUM(A1:A3)');
    engine.setCell('S', 'B2', '=AVERAGE(A1:A3)');
    engine.setCell('S', 'B3', '=MIN(A1:A3)');
    engine.setCell('S', 'B4', '=MAX(A1:A3)');
    engine.setCell('S', 'B5', '=COUNT(A1:A3)');
    engine.setCell('S', 'B6', '=COUNTA(A1:A3)');
    expect(engine.evaluateCell('S', 'B1')).toBe(6);
    expect(engine.evaluateCell('S', 'B2')).toBe(2);
    expect(engine.evaluateCell('S', 'B3')).toBe(1);
    expect(engine.evaluateCell('S', 'B4')).toBe(3);
    expect(engine.evaluateCell('S', 'B5')).toBe(3);
    expect(engine.evaluateCell('S', 'B6')).toBe(3);
  });

  it('handles logicals IF/AND/OR/NOT', () => {
    const engine = new SpreadsheetEngine();
    registerBuiltins(engine.registry);
    engine.addSheet('S');
    engine.setCell('S', 'A1', '=IF(1, "yes", "no")');
    engine.setCell('S', 'A2', '=AND(1, 2, 3)');
    engine.setCell('S', 'A3', '=OR(0, 0, 1)');
    engine.setCell('S', 'A4', '=NOT(0)');
    expect(engine.evaluateCell('S', 'A1')).toBe('yes');
    expect(engine.evaluateCell('S', 'A2')).toBe(true);
    expect(engine.evaluateCell('S', 'A3')).toBe(true);
    expect(engine.evaluateCell('S', 'A4')).toBe(true);
  });

  it('handles text functions', () => {
    const engine = new SpreadsheetEngine();
    registerBuiltins(engine.registry);
    engine.addSheet('S');
    engine.setCell('S', 'A1', '=CONCAT("a","b",1)');
    engine.setCell('S', 'A2', '=LEN("hello")');
    engine.setCell('S', 'A3', '=UPPER("abC")');
    engine.setCell('S', 'A4', '=LOWER("AbC")');
    expect(engine.evaluateCell('S', 'A1')).toBe('ab1');
    expect(engine.evaluateCell('S', 'A2')).toBe(5);
    expect(engine.evaluateCell('S', 'A3')).toBe('ABC');
    expect(engine.evaluateCell('S', 'A4')).toBe('abc');
  });

  it('supports custom functions calling built-ins', () => {
    const engine = new SpreadsheetEngine();
    registerBuiltins(engine.registry);
    engine.addSheet('S');
    engine.registerFunction('MYCUSTOMFUNCTION', (args, { registry }) => {
      const SUM = registry.get('SUM');
      return SUM(args) * -1;
    });
    engine.setCell('S', 'B1', 5);
    engine.setCell('S', 'B2', '=MYCUSTOMFUNCTION(1, B1)');
    expect(engine.evaluateCell('S', 'B2')).toBe(-6);
  });

  it('detects circular dependencies', () => {
    const engine = new SpreadsheetEngine();
    registerBuiltins(engine.registry);
    engine.addSheet('S');
    engine.setCell('S', 'A1', '=A2');
    engine.setCell('S', 'A2', '=A1');
    const v = engine.evaluateCell('S', 'A1');
    expect(String(v)).toMatch(/#CYCLE!/);
  });

  it('supports sheet-qualified and absolute refs', () => {
    const engine = new SpreadsheetEngine();
    registerBuiltins(engine.registry);
    engine.addSheet('Sheet1');
    engine.addSheet('Sheet2');
    engine.setCell('Sheet1', 'A1', 10);
    engine.setCell('Sheet2', 'A1', '=Sheet1!$A$1');
    expect(engine.evaluateCell('Sheet2', 'A1')).toBe(10);
  });

  it('COUNTIF, SUMIF', () => {
    const engine = new SpreadsheetEngine();
    registerBuiltins(engine.registry);
    engine.addSheet('S');
    engine.setCell('S', 'A1', 1);
    engine.setCell('S', 'A2', 5);
    engine.setCell('S', 'A3', 10);
    engine.setCell('S', 'B1', '=COUNTIF(A1:A3, ">=5")');
    engine.setCell('S', 'B2', '=SUMIF(A1:A3, ">=5")');
    expect(engine.evaluateCell('S', 'B1')).toBe(2);
    expect(engine.evaluateCell('S', 'B2')).toBe(15);
  });

  it('MATCH exact and approximate', () => {
    const engine = new SpreadsheetEngine();
    registerBuiltins(engine.registry);
    engine.addSheet('S');
    engine.setCell('S', 'A1', 1);
    engine.setCell('S', 'A2', 3);
    engine.setCell('S', 'A3', 5);
    engine.setCell('S', 'B1', '=MATCH(3, A1:A3, 0)');
    engine.setCell('S', 'B2', '=MATCH(4, A1:A3, 1)');
    expect(engine.evaluateCell('S', 'B1')).toBe(2);
    expect(engine.evaluateCell('S', 'B2')).toBe(2);
  });

  it('INDEX 1D', () => {
    const engine = new SpreadsheetEngine();
    registerBuiltins(engine.registry);
    engine.addSheet('S');
    engine.setCell('S', 'A1', 10);
    engine.setCell('S', 'A2', 20);
    engine.setCell('S', 'A3', 30);
    engine.setCell('S', 'B1', '=INDEX(A1:A3, 2)');
    expect(engine.evaluateCell('S', 'B1')).toBe(20);
  });

  it('VLOOKUP exact and approximate', () => {
    const engine = new SpreadsheetEngine();
    registerBuiltins(engine.registry);
    engine.addSheet('S');
    // Emulate 2-column table using adjacent columns; our range returns 1D so build rows via custom data loader
    // For test simplicity, build via custom function to form rows
    engine.registerFunction('TABLE', (args) => args);
    const rows = [
      [1, 'a'],
      [3, 'b'],
      [5, 'c']
    ];
    engine.setCell('S', 'A1', rows);
    engine.setCell('S', 'B1', '=VLOOKUP(3, A1, 2, FALSE)');
    engine.setCell('S', 'B2', '=VLOOKUP(4, A1, 2, TRUE)');
    expect(engine.evaluateCell('S', 'B1')).toBe('b');
    expect(engine.evaluateCell('S', 'B2')).toBe('b');
  });
});


