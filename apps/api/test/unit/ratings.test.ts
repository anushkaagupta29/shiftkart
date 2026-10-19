import { describe, expect, it } from 'vitest';
import { weightedScore, type RatingInput } from '../../src/domain/ratings';

const r = (stars: number, over: Partial<RatingInput> = {}): RatingInput => ({ stars, raterMean: 4.6, raterSd: 0.5, raterCount: 20, first: false, ...over });

describe('weighted worker rating (PAY-08)', () => {
  it('one 1★ among ten 5★ moves the score by less than 0.3', () => {
    const tenFives = Array.from({ length: 10 }, (_, i) => r(5, { first: i === 0 }));
    const before = weightedScore(tenFives).score;
    const after = weightedScore([...tenFives, r(1)]).score;
    expect(before - after).toBeLessThan(0.3);
  });
  it('a revenge rating far below what that business normally gives counts half', () => {
    const normal = weightedScore([r(5), r(1, { raterMean: 2, raterSd: 1 })]).score; // harsh rater: 1★ is normal for them
    const outlier = weightedScore([r(5), r(1)]).score; // usually-generous business suddenly gives 1★
    expect(outlier).toBeGreaterThan(normal);
  });
  it('the first rating counts half', () => {
    expect(weightedScore([r(1, { first: true })]).score).toBeGreaterThan(weightedScore([r(1)]).score);
  });
  it('a new worker starts at the prior', () => {
    expect(weightedScore([])).toEqual({ score: 4.5, count: 0 });
  });
});
