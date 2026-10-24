// Pins the validation behaviour the API relies on, so a zod upgrade can't change it silently (D-088).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pagination, parse, uuidParam } from '../../src/lib/validate';

const Nested = z.object({
  requirements: z.object({ skills: z.array(z.string().max(40)).max(5).default([]), twoWheeler: z.boolean().default(false) }).strict().prefault({}),
}).strict();

describe('parse()', () => {
  it('an omitted nested object still gets its inner defaults', () => {
    expect(parse(Nested, {})).toEqual({ requirements: { skills: [], twoWheeler: false } });
  });

  it('rejects unknown keys and oversized collections with the API error shape', () => {
    try {
      parse(Nested, { extra: 1, requirements: { skills: Array(10).fill('a') } });
      expect.unreachable();
    } catch (e) {
      const err = e as { statusCode: number; code: string; issues: { path: string; message: string }[] };
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('invalid_input');
      expect(err.issues.map((i) => i.path).sort()).toEqual(['', 'requirements.skills']);
      expect(err.issues.every((i) => typeof i.message === 'string' && i.message.length > 0)).toBe(true);
    }
  });

  it('refuses a huge array quickly (GHSA-mrhx-c7xc-m3w5)', () => {
    const t = Date.now();
    expect(() => parse(z.object({ a: z.array(z.string().max(10)).max(5) }).strict(), { a: Array(200_000).fill('x') })).toThrow();
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('accepts real UUIDs from Postgres, rejects junk', () => {
    expect(parse(uuidParam('id'), { id: '3f1c2d4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f' }).id).toBeTruthy();
    expect(() => parse(uuidParam('id'), { id: 'not-a-uuid' })).toThrow();
    expect(() => parse(uuidParam('id'), { id: "1' OR '1'='1" })).toThrow();
  });

  it('pagination coerces strings and clamps page size', () => {
    expect(parse(pagination, { page: '2', pageSize: '5000' })).toEqual({ page: 2, pageSize: 100 });
    expect(parse(pagination, {})).toEqual({ page: 1, pageSize: 25 });
  });
});
