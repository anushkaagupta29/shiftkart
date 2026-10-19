// BIZ-01 unverified posting · BIZ-02 fee requests · BIZ-03 prohibited work · BIZ-04 someone else's GSTIN ·
// BIZ-07 discrimination · PAY-04 allowances to dodge minimum wage · PAY-05 wrong category · INT-04 two approvers.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, signUp, staffWith, type Ctx } from '../helpers';
import { WHITEFIELD, newGstin, seedRates, shiftBody, verifiedBusiness, type Biz } from '../fixtures';

let ctx: Ctx;
let b: Biz;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); await seedRates(ctx); b = await verifiedBusiness(ctx); });
afterAll(async () => closeApp(ctx));

const post = (over: Record<string, unknown>, biz = b) =>
  ctx.app.inject({ method: 'POST', url: `/businesses/${biz.businessId}/shifts`, headers: biz.owner.auth, payload: shiftBody(biz.siteId, over) });

async function draftBusiness(legalName = `Draft Co ${randomUUID().slice(0, 4)}`) {
  const owner = await signUp(ctx, 'business');
  const biz = (await ctx.app.inject({ method: 'POST', url: '/businesses', headers: owner.auth, payload: { legalName } })).json();
  const site = (await ctx.app.inject({ method: 'POST', url: `/businesses/${biz.id}/sites`, headers: owner.auth, payload: { name: 'Shop', address: '1 MG Road, Bengaluru 560001', cityCode: 'BLR', ...WHITEFIELD } })).json();
  return { owner, businessId: biz.id as string, siteId: site.id as string, legalName };
}

describe('BIZ-01 unverified businesses cannot post', () => {
  it('draft business gets 403 on posting and preview', async () => {
    const d = await draftBusiness();
    for (const url of [`/businesses/${d.businessId}/shifts`, `/businesses/${d.businessId}/shifts/preview`]) {
      const r = await ctx.app.inject({ method: 'POST', url, headers: d.owner.auth, payload: shiftBody(d.siteId) });
      expect(r.statusCode).toBe(403);
    }
  });

  it('a site of another business cannot be used', async () => {
    const other = await verifiedBusiness(ctx);
    const r = await post({ siteId: other.siteId });
    expect(r.json().error.code).toBe('unknown_site');
  });

  it('a site pin outside the city is refused', async () => {
    const d = await draftBusiness();
    const r = await ctx.app.inject({ method: 'POST', url: `/businesses/${d.businessId}/sites`, headers: d.owner.auth, payload: { name: 'Far site', address: 'Somewhere far away, Chennai', cityCode: 'BLR', lat: 13.08, lng: 80.27 } });
    expect(r.json().error.code).toBe('outside_city');
  });
});

describe('BIZ-02 / BIZ-03 / BIZ-07 text screening sends posts to human review', () => {
  it.each([
    ['worker_payment_request', { description: 'Pay ₹300 uniform deposit on joining' }],
    ['prohibited_work', { title: 'Firecracker packing helpers' }],
    ['discriminatory_language', { description: 'Only girls, fair complexion preferred' }],
    ['document_request', { bringItems: 'Send aadhaar copy on WhatsApp first' }],
  ])('%s', async (reason, over) => {
    const r = await post(over);
    expect(r.statusCode).toBe(201);
    expect(r.json().status).toBe('pending_review');
    expect(r.json().reviewReasons).toContain(reason);
    const fund = await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/shifts/${r.json().id}/fund`, headers: { ...b.owner.auth, 'idempotency-key': `k-${randomUUID()}` } });
    expect(fund.statusCode).toBe(409); // can't be funded (so can't go live) until reviewed
  });

  it('there is no free-text requirement field', async () => {
    const r = await post({ requirements: { skills: [], languages: [], twoWheeler: false, other: 'Hindu only' } });
    expect(r.statusCode).toBe(400);
  });

  it('a gender requirement needs a legal reason and a compliance officer, and is logged', async () => {
    const noReason = await post({ genderRequirement: { requirement: 'female', legalReason: 'needed' } });
    expect(noReason.statusCode).toBe(400);
    const r = await post({ title: 'Frisking at ladies entrance', genderRequirement: { requirement: 'female', legalReason: 'Frisking of women visitors at the ladies-only security entrance must be done by women staff.' } });
    expect(r.json().status).toBe('pending_review');
    const verifier = await staffWith(ctx, ['ops_verifier']);
    const v = await ctx.app.inject({ method: 'POST', url: `/admin/shifts/${r.json().id}/review`, headers: verifier.cookie, payload: { decision: 'approve', reason: 'Looks fine to me' } });
    expect(v.statusCode).toBe(403);
    const compliance = await staffWith(ctx, ['compliance']);
    const c = await ctx.app.inject({ method: 'POST', url: `/admin/shifts/${r.json().id}/review`, headers: compliance.cookie, payload: { decision: 'approve', reason: 'Frisking by same gender is required' } });
    expect(c.json().status).toBe('pending_funding');
    const g = await ctx.db.query('SELECT status, decided_by FROM gender_requirements WHERE shift_id = $1', [r.json().id]);
    expect(g.rows[0]).toMatchObject({ status: 'approved', decided_by: compliance.staffId });
  });
});

describe('PAY-04 / PAY-05 minimum wage', () => {
  it('low base pay padded with allowances is refused', async () => {
    const r = await post({ payPaise: 5000, mealAllowancePaise: 30000, travelAllowancePaise: 20000 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('below_minimum_wage');
  });

  it('exactly the minimum is accepted (₹80/h unskilled in the test rates)', async () => {
    expect((await post({ payPaise: 8000 })).statusCode).toBe(201);
    expect((await post({ payPaise: 7999 })).statusCode).toBe(422);
  });

  it('per-shift pay is converted over paid hours', async () => {
    // 7.5 paid hours × ₹80 = ₹600 minimum
    expect((await post({ payType: 'per_shift', payPaise: 60000 })).statusCode).toBe(201);
    expect((await post({ payType: 'per_shift', payPaise: 59900 })).statusCode).toBe(422);
  });

  it('requiring billing software lifts the job to semi-skilled pay', async () => {
    const r = await post({ roleCode: 'retail_floor', payPaise: 8000, requirements: { skills: ['billing_software'], languages: [], twoWheeler: false } });
    expect(r.statusCode).toBe(422); // ₹80 < ₹87.50 semi-skilled
    const ok = await post({ roleCode: 'retail_floor', payPaise: 8750, requirements: { skills: ['billing_software'], languages: [], twoWheeler: false } });
    expect(ok.json().wageCategory).toBe('semi_skilled');
  });

  it('with no confirmed rate for the area, posting fails closed', async () => {
    await ctx.db.query(`UPDATE sites SET wage_zone = 'Z' WHERE id = $1`, [b.siteId]);
    try {
      expect((await post({})).json().error.code).toBe('no_wage_rate');
    } finally {
      await ctx.db.query(`UPDATE sites SET wage_zone = 'A' WHERE id = $1`, [b.siteId]);
    }
  });
});

describe('BIZ-04 / INT-04 business verification', () => {
  it("someone else's GSTIN is refused and flagged", async () => {
    const d = await draftBusiness();
    const theirs = (await ctx.db.query('SELECT gstin FROM businesses WHERE id = $1', [b.businessId])).rows[0].gstin;
    const r = await ctx.app.inject({ method: 'PUT', url: `/businesses/${d.businessId}/verification`, headers: d.owner.auth, payload: { gstin: theirs, pan: theirs.slice(2, 12), signatoryName: 'Imposter' } });
    expect(r.statusCode).toBe(409);
    const f = await ctx.db.query(`SELECT 1 FROM fraud_flags WHERE subject_id = $1 AND rule_code = 'gstin_in_use'`, [d.businessId]);
    expect(f.rowCount).toBe(1);
  });

  it('PAN must match the GSTIN', async () => {
    const d = await draftBusiness();
    const { gstin } = newGstin();
    const r = await ctx.app.inject({ method: 'PUT', url: `/businesses/${d.businessId}/verification`, headers: d.owner.auth, payload: { gstin, pan: 'ZZZZZ9999Z', signatoryName: 'Asha' } });
    expect(r.json().error.code).toBe('pan_gstin_mismatch');
  });

  it('a GSTIN registered to a different name is high risk and needs two different verifiers', async () => {
    const d = await draftBusiness('Fresh Mart');
    const { gstin, pan } = newGstin();
    await ctx.db.query(`INSERT INTO mock_gstn_registry (gstin, legal_name) VALUES ($1, 'Completely Different Industries Ltd')`, [gstin]);
    const sub = await ctx.app.inject({ method: 'PUT', url: `/businesses/${d.businessId}/verification`, headers: d.owner.auth, payload: { gstin, pan, signatoryName: 'Asha' } });
    expect(sub.json()).toMatchObject({ riskTier: 'high', checks: ['gst_name_mismatch'] });

    const v1 = await staffWith(ctx, ['ops_verifier']);
    const v2 = await staffWith(ctx, ['ops_verifier']);
    const review = (s: typeof v1) => ctx.app.inject({ method: 'POST', url: `/admin/businesses/${d.businessId}/review`, headers: s.cookie, payload: { decision: 'approve', reason: 'Checked trade licence' } });
    expect((await review(v1)).json().status).toBe('pending');
    expect((await review(v1)).statusCode).toBe(409); // same person can't approve twice
    expect((await review(v2)).json().status).toBe('verified');
  });

  it('new businesses have headcount limits for their first 30 days', async () => {
    const nb = await verifiedBusiness(ctx);
    await ctx.db.query(`UPDATE businesses SET verified_at = now() WHERE id = $1`, [nb.businessId]);
    const r = await post({ headcount: 25 }, nb);
    expect(r.json().error.code).toBe('new_business_headcount');
  });
});
