import { applyBasisPoints } from '@shiftkart/shared';

// GST on our platform fee. Intra-state supply → CGST + SGST (half each); inter-state → IGST.
// Place of supply rules, SAC code and rates are on the legal checklist (L-12).
export function gstSplit(taxablePaise: number, gstBp: number, sellerStateCode: string, buyerStateCode: string | null) {
  const total = applyBasisPoints(taxablePaise, gstBp);
  if (buyerStateCode && buyerStateCode !== sellerStateCode) return { cgst: 0, sgst: 0, igst: total, total };
  const cgst = Math.floor(total / 2);
  return { cgst, sgst: total - cgst, igst: 0, total };
}

/** Indian financial year for an instant, e.g. "2026-27". Uses IST. */
export function financialYear(d: Date): string {
  const ist = new Date(d.getTime() + 330 * 60_000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
