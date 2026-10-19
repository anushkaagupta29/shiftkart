import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { db, freshGstin, makeStaff, randomPhone } from './helpers';

test.afterAll(async () => { await db.end(); });

test('business: sign up → site → verification → approved by ops → post → fund → live', async ({ page, browser }) => {
  const phone = randomPhone();
  const legalName = `Playwright Traders ${randomBytes(3).toString('hex')} LLP`;

  // Sign up with OTP (dev code shown on screen) and consent.
  await page.goto('http://localhost:3002/login');
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByRole('link', { name: 'Show my code' }).click();
  const code = (await page.locator('b.mono').textContent())!.trim();
  await page.getByLabel(/6-digit code/).fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account' }).click();

  // Create business and a site.
  await page.getByLabel('Legal name (as on GST)').fill(legalName);
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('link', { name: new RegExp(legalName) }).click();
  await expect(page.getByText('Verification:')).toBeVisible();
  await page.getByRole('button', { name: 'Add a work site' }).click();
  await page.getByLabel('Site name').fill('Main godown');
  await page.getByLabel('Full address').fill('22 KIADB Industrial Area, Whitefield, Bengaluru 560066');
  await page.getByLabel('Latitude').fill('12.979');
  await page.getByLabel('Longitude').fill('77.731');
  await page.getByRole('button', { name: 'Add site' }).click();
  await expect(page.getByText('pending_verify')).toBeVisible();

  // Submit verification.
  const g = freshGstin(legalName);
  await g.register();
  await page.getByRole('link', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Submit for verification' }).click();
  await page.getByLabel('GSTIN').fill(g.gstin);
  await page.getByLabel('PAN').fill(g.pan);
  await page.getByLabel('Authorised signatory (full name)').fill('Priya Sharma');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('pending', { exact: true })).toBeVisible();

  // Ops approves in the admin console (separate browser context = separate person).
  const verifier = await makeStaff(['ops_verifier']);
  const ops = await (await browser.newContext()).newPage();
  await ops.goto('http://localhost:3001/login');
  await ops.getByLabel('Email').fill(verifier.email);
  await ops.getByLabel('Password').fill(verifier.password);
  await ops.getByLabel('2FA code').fill(verifier.code());
  await ops.getByRole('button', { name: 'Sign in' }).click();
  await ops.getByRole('link', { name: 'Business verification' }).click();
  await ops.getByRole('cell', { name: legalName }).click();
  await ops.getByPlaceholder(/Reason/).first().fill('GSTIN and PAN match, address checked');
  await ops.getByRole('button', { name: 'Approve' }).first().click();
  await expect(ops.getByText('verified').first()).toBeVisible();

  // Post a shift: preview first, then the below-minimum guard, then create.
  await page.reload();
  await page.getByRole('button', { name: 'Post a shift' }).click();
  await page.getByLabel('Title').fill('Diwali gift hamper packing');
  await page.getByLabel('People needed').fill('3');
  await page.getByLabel('Base pay (₹)').fill('60');
  await expect(page.getByText(/below the minimum wage/)).toBeVisible();
  await page.getByLabel('Base pay (₹)').fill('120');
  await expect(page.getByText('You fund now')).toBeVisible();
  // 3 × 7.5 h × ₹120 = ₹2,700; fee ₹405; GST ₹72.90 → ₹3,177.90
  await expect(page.getByRole('row', { name: /You fund now/ })).toContainText('₹3,177.90');
  await page.getByRole('button', { name: 'Create shift' }).click();

  // Fund through the mock checkout → live.
  await page.getByRole('button', { name: /Fund ₹3,177.90/ }).click();
  await expect(page.getByText('SANDBOX')).toBeVisible();
  await page.getByRole('button', { name: 'Pay (simulate success)' }).click();
  await expect(page.getByText('Status:')).toContainText('live');
});
