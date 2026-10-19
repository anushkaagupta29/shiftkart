import { expect, test } from '@playwright/test';
import { randomPhone } from './helpers';

test('worker app in Kannada: screens and server errors are in Kannada', async ({ page }) => {
  await page.goto('http://localhost:8081');
  await page.getByTestId('lang-kn').click();
  await expect(page.getByText('ನಿಮ್ಮ ಮೊಬೈಲ್ ಸಂಖ್ಯೆ')).toBeVisible();
  await expect(page.getByText(/ಎಂದಿಗೂ ನಿಮ್ಮಿಂದ ಹಣ ಕೇಳುವುದಿಲ್ಲ/)).toBeVisible();
  await page.getByTestId('phone').fill(randomPhone());
  await page.getByTestId('send-code').click();
  await page.getByTestId('code').fill('000000');
  await page.getByTestId('verify').click();
  // invalid_code from the API, shown in the worker's language
  await expect(page.getByText('ಕೋಡ್ ತಪ್ಪಾಗಿದೆ ಅಥವಾ ಅವಧಿ ಮುಗಿದಿದೆ.')).toBeVisible();
});
