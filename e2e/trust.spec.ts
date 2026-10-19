import { devices, expect, test, type Browser } from '@playwright/test';
import { api, db, liveShiftViaApi, makeStaff, workerViaApi } from './helpers';

test.afterAll(async () => { await db.end(); });

async function businessLogin(browser: Browser, phone: string) {
  const page = await (await browser.newContext({ ...devices['Desktop Chrome'] })).newPage();
  await page.goto('http://localhost:3002/login');
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByRole('link', { name: 'Show my code' }).click();
  await page.getByLabel(/6-digit code/).fill((await page.locator('b.mono').textContent())!.trim());
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Your businesses')).toBeVisible();
  return page;
}

test('trust: scam message blocked → SOS reaches the safety desk → late cancellation compensates the worker', async ({ browser }) => {
  const { businessId, shiftId, ownerPhone } = await liveShiftViaApi(`Trust ${Date.now()}`);
  const w = await workerViaApi();
  const { bookingId } = await api(`/worker/shifts/${shiftId}/accept`, { method: 'POST', token: w.token, body: JSON.stringify({}) });
  await api(`/dev/shifts/${shiftId}/start-now`, { method: 'POST', body: JSON.stringify({ minutes: 240 }) }); // starts in 4 hours

  // 1. Business tries to ask for a "registration fee" in chat.
  const biz = await businessLogin(browser, ownerPhone);
  await biz.goto(`http://localhost:3002/b/${businessId}/chat/${bookingId}`);
  await biz.getByPlaceholder(/Message/).fill('Send 500 rs registration fee on gpay to confirm');
  await biz.getByRole('button', { name: 'Send' }).click();
  await expect(biz.getByText(/Not sent/)).toBeVisible();

  // The worker never sees the request, only a warning.
  const workerCtx = await browser.newContext({ ...devices['Pixel 7'] });
  await workerCtx.addInitScript(([at, rt]) => { sessionStorage.setItem('sk_at', at); sessionStorage.setItem('sk_rt', rt); }, [w.token, w.refreshToken]);
  const phone = await workerCtx.newPage();
  await phone.goto('http://localhost:8081');
  await phone.getByTestId('tab-mine').click();
  await phone.locator('[data-testid^="booking-"]').first().click();
  await phone.getByTestId('open-chat').click();
  await expect(phone.getByText(/never asks workers to pay/)).toBeVisible();
  await expect(phone.getByText('registration fee')).toHaveCount(0);

  // 2. Worker opens Safety and presses SOS.
  await phone.getByText('वापस').first().click();
  await phone.getByTestId('open-safety').click();
  await phone.getByTestId('sos').click();
  await expect(phone.getByText(/112/).first()).toBeVisible();
  const safety = await makeStaff(['ops_safety']);
  const ops = await (await browser.newContext()).newPage();
  await ops.goto('http://localhost:3001/login');
  await ops.getByLabel('Email').fill(safety.email);
  await ops.getByLabel('Password').fill(safety.password);
  await ops.getByLabel('2FA code').fill(safety.code());
  await ops.getByRole('button', { name: 'Sign in' }).click();
  await ops.getByRole('link', { name: 'Safety desk' }).click();
  await expect(ops.getByText(/🆘 Sunita/).first()).toBeVisible();

  // 3. Business cancels 4 hours before: the worker gets 50% of shift pay automatically.
  await biz.goto(`http://localhost:3002/b/${businessId}/shifts/${shiftId}`);
  biz.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('Event postponed by client') : d.accept()));
  await biz.getByRole('button', { name: 'Cancel shift…' }).click();
  await expect(biz.getByText(/cancelled/).first()).toBeVisible();
  const comp = await db.query(`SELECT amount_paise, reason FROM compensations WHERE booking_id = $1`, [bookingId]);
  expect({ ...comp.rows[0], amount_paise: Number(comp.rows[0].amount_paise) }).toEqual({ amount_paise: 33000, reason: 'late_cancel' }); // 50% of 6 h × ₹110
  await api('/dev/jobs/run', { method: 'POST', body: JSON.stringify({}) });
  const p = await db.query(`SELECT kind, status FROM payouts WHERE booking_id = $1`, [bookingId]);
  expect(p.rows).toEqual([{ kind: 'compensation', status: 'paid' }]);
  const strikes = await db.query(`SELECT count(*)::int AS n FROM strikes WHERE booking_id = $1`, [bookingId]);
  expect(strikes.rows[0].n).toBe(0);
});
