// Worker rating that a single bad (or revenge) rating can't sink (PAY-08).
//  - Bayesian average: starts from a prior (4.5★ with the weight of 5 ratings).
//  - A rating far below what that business usually gives (> 2σ under its own mean) counts half.
//  - A worker's very first rating counts half.
//  - No single rating weighs more than 1.5.

export type RatingInput = { stars: number; raterMean: number; raterSd: number; raterCount: number; first: boolean };

export function ratingWeight(r: RatingInput): number {
  let w = 1;
  if (r.raterCount >= 5 && r.stars < r.raterMean - 2 * Math.max(r.raterSd, 0.25)) w *= 0.5;
  if (r.first) w *= 0.5;
  return Math.min(w, 1.5);
}

export function weightedScore(ratings: RatingInput[], priorMean = 4.5, priorWeight = 5): { score: number; count: number } {
  let num = priorMean * priorWeight;
  let den = priorWeight;
  for (const r of ratings) {
    const w = ratingWeight(r);
    num += w * r.stars;
    den += w;
  }
  return { score: Math.round((num / den) * 100) / 100, count: ratings.length };
}
