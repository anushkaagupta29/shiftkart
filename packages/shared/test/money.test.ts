import { describe, expect, it } from 'vitest';
import { applyBasisPoints, formatINR, rupeesToPaise, splitEvenly } from '../src/money';

describe('money (paise)', () => {
  it('parses rupee strings without floats', () => {
    expect(rupeesToPaise('0.1')).toBe(10);
    expect(rupeesToPaise('1,234.05')).toBe(123405);
    expect(rupeesToPaise('19.99')).toBe(1999);
    expect(() => rupeesToPaise('1.234')).toThrow();
    expect(() => rupeesToPaise('abc')).toThrow();
    expect(() => rupeesToPaise('1e5')).toThrow();
  });

  it('formats in Indian grouping', () => {
    expect(formatINR(12345678)).toBe('₹1,23,456.78');
    expect(formatINR(5)).toBe('₹0.05');
    expect(formatINR(100000000)).toBe('₹10,00,000.00');
    expect(formatINR(-1999)).toBe('-₹19.99');
  });

  it('applies basis points with half-up rounding', () => {
    expect(applyBasisPoints(100000, 1500)).toBe(15000); // 15% of ₹1000
    expect(applyBasisPoints(15000, 1800)).toBe(2700); // 18% GST on ₹150
    expect(applyBasisPoints(333, 1500)).toBe(50); // 49.95 -> 50
    expect(applyBasisPoints(-333, 1500)).toBe(-50);
    expect(() => applyBasisPoints(1.5, 100)).toThrow();
  });

  it('splits without losing a paisa', () => {
    const parts = splitEvenly(1000, 3);
    expect(parts).toEqual([334, 333, 333]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000);
  });
});
