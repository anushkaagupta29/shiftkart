import { expect, test } from '@playwright/test';
import { db, liveShiftViaApi, randomPhone } from './helpers';

test.afterAll(async () => { await db.end(); });

test('worker (Hindi, phone screen): sign up → DigiLocker → selfie → UPI → profile → see shift → accept', async ({ page }) => {
  const title = `E2E packing ${Date.now()}`;
  const { shiftId } = await liveShiftViaApi(title);

  await page.goto('http://localhost:8081');
  await page.getByTestId('lang-hi').click();
  await page.getByTestId('phone').fill(randomPhone());
  await page.getByTestId('send-code').click();
  await page.getByTestId('dev-code').click();
  await page.getByTestId('verify').click();
  await expect(page.getByText('शुरू करने से पहले')).toBeVisible(); // consent, in Hindi
  await page.getByTestId('agree').click();

  await page.getByTestId('step-identity').click();
  await page.getByTestId('dl-adult').click();
  await expect(page.getByTestId('step-identity')).toContainText('हो गया');
  await page.getByTestId('step-selfie').click();
  await page.getByTestId('selfie-take').click();
  await page.getByTestId('step-payout').click();
  await page.getByTestId('vpa').fill(`ravi${Date.now()}@okaxis`);
  await page.getByTestId('save-payout').click();
  await page.getByTestId('step-profile').click();
  await page.getByTestId('skill-packing').click();
  await page.getByText('30 किमी').click();
  await page.getByTestId('save-profile').click();

  // Verified → feed. The funded shift is there with pay shown up front.
  const card = page.getByTestId(`shift-${shiftId}`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('₹660'); // 6 h × ₹110
  await card.click();
  await page.getByTestId('accept').click();
  await expect(page.getByText('शिफ्ट बुक हो गई!')).toBeVisible();

  const b = await db.query(`SELECT status FROM bookings WHERE shift_id = $1`, [shiftId]);
  expect(b.rows.map((r) => r.status)).toEqual(['confirmed']);
});
