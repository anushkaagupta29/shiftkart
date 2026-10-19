import { devices, expect, test } from '@playwright/test';
import { api, db, liveShiftViaApi, workerViaApi } from './helpers';

test.afterAll(async () => { await db.end(); });

test('shift day: gate code on supervisor phone → worker checks in and out → business approves → worker paid with payslip', async ({ browser }) => {
  const { businessId, shiftId, ownerPhone } = await liveShiftViaApi(`Shift day ${Date.now()}`);
  const w = await workerViaApi();
  await api(`/worker/shifts/${shiftId}/accept`, { method: 'POST', token: w.token });
  await api(`/dev/shifts/${shiftId}/start-now`, { method: 'POST', body: JSON.stringify({ minutes: -5 }) });

  // Supervisor (business owner) logs in and opens the gate screen.
  const biz = await (await browser.newContext({ ...devices['Desktop Chrome'] })).newPage();
  await biz.goto('http://localhost:3002/login');
  await biz.getByLabel('Mobile number').fill(ownerPhone);
  await biz.getByRole('button', { name: 'Send code' }).click();
  await biz.getByRole('link', { name: 'Show my code' }).click();
  await biz.getByLabel(/6-digit code/).fill((await biz.locator('b.mono').textContent())!.trim());
  await biz.getByRole('button', { name: 'Continue' }).click();
  await expect(biz.getByText('Your businesses')).toBeVisible();
  await biz.goto(`http://localhost:3002/b/${businessId}/shifts/${shiftId}/gate`);
  const gateCode = biz.getByTestId('gate-code');
  await expect(gateCode).toHaveText(/^\d{6}$/);

  // Worker on an Android-sized screen, already logged in (tokens as the app stores them).
  const workerCtx = await browser.newContext({ ...devices['Pixel 7'] });
  await workerCtx.addInitScript(([at, rt]) => { sessionStorage.setItem('sk_at', at); sessionStorage.setItem('sk_rt', rt); }, [w.token, w.refreshToken]);
  const phone = await workerCtx.newPage();
  await phone.goto('http://localhost:8081');
  await phone.getByTestId('tab-mine').click();
  await phone.locator('[data-testid^="booking-"]').first().click();
  await phone.getByTestId('test-at-site').click();
  // The code shown by the browser (computed with WebCrypto on the supervisor's phone) must be accepted by the server.
  await phone.getByTestId('gate-code').fill((await gateCode.textContent())!.trim());
  await phone.getByTestId('check-in').click();
  await expect(phone.getByText('आपका चेक-इन हो गया है').first()).toBeVisible();

  // The supervisor sees the arrival.
  await expect(biz.getByText(/1\/1 arrived/)).toBeVisible({ timeout: 15_000 });

  // Break, then end of shift: check out with a fresh code.
  await phone.getByTestId('break').click();
  await expect(phone.getByText('ब्रेक खत्म')).toBeVisible();
  await phone.getByTestId('break').click();
  await api(`/dev/shifts/${shiftId}/start-now`, { method: 'POST', body: JSON.stringify({ minutes: -(6 * 60 + 1) }) });
  await biz.reload();
  await expect(gateCode).toHaveText(/^\d{6}$/);
  await phone.getByTestId('test-at-site').click();
  await phone.getByTestId('gate-code').fill((await gateCode.textContent())!.trim());
  await phone.getByTestId('check-out').click();
  await expect(phone.getByText('चेक-आउट हो गया। बहुत अच्छे!').first()).toBeVisible();

  // Business approves the hours.
  await biz.goto(`http://localhost:3002/b/${businessId}/timesheets`);
  await biz.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(biz.getByText('Approved', { exact: true })).toBeVisible();

  // Payout runs; the worker sees the money and a payslip.
  await api('/dev/jobs/run', { method: 'POST', body: JSON.stringify({}) });
  await phone.getByText('वापस').first().click();
  await phone.getByTestId('tab-earnings').click();
  const slip = phone.locator('[data-testid^="payslip-"]').first();
  await expect(slip).toBeVisible();
  await slip.click();
  await expect(phone.getByText('पे-स्लिप')).toBeVisible();
  await expect(phone.getByText('आपको मिला')).toBeVisible();

  const paid = await db.query(`SELECT p.status FROM payouts p JOIN timesheets t ON t.id = p.timesheet_id WHERE t.shift_id = $1`, [shiftId]);
  expect(paid.rows.map((r) => r.status)).toEqual(['paid']);
});
