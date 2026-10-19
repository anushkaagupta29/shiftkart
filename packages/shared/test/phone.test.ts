import { describe, expect, it } from 'vitest';
import { normalizeIndianPhone } from '../src/phone';
import { maskPhone, redactPII } from '../src/mask';

describe('phone', () => {
  it('normalizes Indian mobiles', () => {
    for (const p of ['9876543210', '+91 98765 43210', '919876543210', '09876543210', '+91-98765-43210'])
      expect(normalizeIndianPhone(p)).toBe('+919876543210');
  });
  it('rejects non-Indian and invalid numbers', () => {
    for (const p of ['+14155550100', '5876543210', '98765', '+4479460000000', 'abc'])
      expect(normalizeIndianPhone(p)).toBeNull();
  });
  it('masks and redacts', () => {
    expect(maskPhone('+919876543210')).toBe('+91 ******3210');
    expect(redactPII('call me on 98765 43210 or a@b.com')).toBe('call me on [phone] or [email]');
  });
});
