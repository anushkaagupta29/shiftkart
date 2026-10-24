import { expect, test } from '@playwright/test';
import { db, workerViaApi, clearLocalOtpLimits } from './helpers';

test.beforeEach(clearLocalOtpLimits);

test('worker privacy (Hindi): download my data → switch off face checks → delete account', async ({ browser }) => {
  const w = await workerViaApi();
  const ctx = await browser.newContext({ ...test.info().project.use, acceptDownloads: true });
  await ctx.addInitScript(([at, rt]) => { sessionStorage.setItem('sk_at', at); sessionStorage.setItem('sk_rt', rt); }, [w.token, w.refreshToken]);
  const page = await ctx.newPage();
  await page.goto('http://localhost:8081');
  await page.getByTestId('me').click();
  await page.getByTestId('privacy').click();
  await expect(page.getByText('ड्राफ्ट: शिकायत अधिकारी अभी नियुक्त नहीं हुआ है।')).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-data').click()]);
  expect(download.suggestedFilename()).toBe('shiftkart-my-data.json');
  const data = JSON.parse(await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8')));
  expect(data.account.phone).toBe(`+91${w.phone}`);
  expect(data.workerProfile.legalName).toBe('Sunita Rao');

  await page.getByTestId('consent-face').click();
  await expect(page.getByText('चेहरे की जाँच के बिना आप शिफ्ट में चेक-इन नहीं कर सकते।')).toBeVisible();

  await page.getByTestId('delete-account').click();
  await page.getByTestId('delete-confirm').fill('DELETE');
  await page.getByTestId('delete-account-go').click();
  await expect(page.getByText('आपका अकाउंट हटा दिया गया है।')).toBeVisible();
  const u = (await db.query(`SELECT status FROM users WHERE phone_hash LIKE 'deleted:%' AND deleted_at > now() - interval '1 minute' ORDER BY deleted_at DESC LIMIT 1`)).rows[0];
  expect(u.status).toBe('deleted');
  await ctx.close();
});
