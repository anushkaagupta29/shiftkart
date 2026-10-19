import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, type Ctx } from '../helpers';
import { istSlot, liveShift, seedRates, verifiedBusiness, verifiedWorker } from '../fixtures';

let ctx: Ctx;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); await seedRates(ctx); });
afterAll(async () => closeApp(ctx));

describe('low bandwidth', () => {
  it('a full shift feed (50 shifts) stays under 50 KB and is compressed on the wire', async () => {
    const b = await verifiedBusiness(ctx);
    for (let i = 0; i < 50; i++) await liveShift(ctx, b, { startsAt: istSlot(2 + (i % 20), 9), endsAt: istSlot(2 + (i % 20), 17), title: `Parcel packing batch ${i}` });
    const w = await verifiedWorker(ctx);
    const plain = await ctx.app.inject({ method: 'POST', url: '/worker/shifts/search', headers: w.auth, payload: {} });
    expect(plain.json().items).toHaveLength(50);
    expect(plain.rawPayload.length).toBeLessThan(50_000);
    const gz = await ctx.app.inject({ method: 'POST', url: '/worker/shifts/search', headers: { ...w.auth, 'accept-encoding': 'br, gzip' }, payload: {} });
    expect(gz.headers['content-encoding']).toMatch(/br|gzip/);
    expect(gz.rawPayload.length).toBeLessThan(plain.rawPayload.length / 4);
  });
});
