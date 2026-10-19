import { describe, expect, it } from 'vitest';
import { filterMessage } from '../../src/domain/chat-filter';

describe('chat filter', () => {
  it.each([
    ['Pay ₹500 registration fee to confirm your slot', 'payment_request'],
    ['send 300 rs on gpay first', 'payment_request'],
    ['my upi is shiftboss@okaxis', 'upi_id'],
    ['Click https://bit.ly/abc123 to confirm', 'link'],
    ['visit shift-jobs.xyz for more', 'link'],
    ['Please share the OTP you got', 'otp_request'],
    ['पैसे भेज दो पहले', 'payment_request'],
    ['you bastard', 'abuse'],
  ])('blocks %s', (text, flag) => {
    const r = filterMessage(text);
    expect(r.action).toBe('block');
    expect(r.flags).toContain(flag);
  });

  it('masks phone numbers in all common forms', () => {
    for (const t of ['call me 98765 43210', 'my no is +91-9876543210', 'nine eight seven six five four three two one zero']) {
      const r = filterMessage(t);
      expect(r.action).toBe('deliver');
      expect(r.body).toContain('[number hidden]');
      expect(r.body).not.toMatch(/\d{5}/);
    }
  });

  it('warns the recipient when someone asks for ID documents', () => {
    const r = filterMessage('Send your aadhaar photo here');
    expect(r.action).toBe('warn');
    expect(r.flags).toContain('document_request');
  });

  it('lets normal messages and map links through', () => {
    expect(filterMessage('Gate 3, near the blue tempo. Reach by 8:45 please').action).toBe('deliver');
    expect(filterMessage('Location: https://maps.app.goo.gl/AbC123').action).toBe('deliver');
    expect(filterMessage('Shift is 9 to 5, bring 2 photos for the gate pass').action).toBe('deliver');
  });
});
