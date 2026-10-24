// DPDP data rights: see what we hold (export), leave (deletion), withdraw a consent; plus the
// retention job. What must be kept by law (pay, tax, ledger records) or for fraud prevention
// (identity hashes) is kept, and the export/deletion responses say so (LEGAL L-19).
import { decrypt, encrypt } from '@shiftkart/shared';
import { CONSENT_VERSION } from './auth/otp';
import type { Db } from './db';
import { withTx } from './db';
import { writeAudit } from './audit';
import { getPolicies } from './policy';
import { badRequest, conflict } from './lib/errors';

export async function exportData(db: Db, userId: string, dataKey: string) {
  const u = (await db.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
  const q = async (sql: string) => (await db.query(sql, [userId])).rows;
  const profile = (await db.query('SELECT * FROM worker_profiles WHERE user_id = $1', [userId])).rows[0];
  return {
    generatedAt: new Date().toISOString(),
    note: 'This is the personal data ShiftKart holds about you. Identity documents and Aadhaar numbers are never stored.',
    account: { id: u.id, phone: decrypt(u.phone_enc, dataKey), kind: u.kind, status: u.status, language: u.preferred_lang, createdAt: u.created_at, whatsappOptIn: Boolean(u.whatsapp_opt_in_at) },
    consents: await q(`SELECT purpose, version, lang, granted_at, withdrawn_at FROM consents WHERE user_id = $1 ORDER BY granted_at`),
    devices: await q(`SELECT platform, first_seen, last_seen FROM devices WHERE user_id = $1`),
    workerProfile: profile ? {
      legalName: profile.legal_name_enc ? decrypt(profile.legal_name_enc, dataKey) : null, birthYear: profile.dob_year, kycStatus: profile.kyc_status,
      faceTemplateStored: Boolean(profile.face_embedding), languages: profile.languages, skills: profile.skills, travelRadiusKm: profile.travel_radius_km,
      homeArea: profile.home_city, reliabilityScore: profile.reliability_score, completedShifts: profile.completed_shifts,
      trustedContact: profile.trusted_contact_name ? { name: profile.trusted_contact_name, phone: profile.trusted_contact_phone_enc ? decrypt(profile.trusted_contact_phone_enc, dataKey) : null } : null,
    } : null,
    payoutMethods: await q(`SELECT type, display, status, verified_at FROM payout_methods WHERE worker_id = $1`),
    bookings: await q(`SELECT b.id, s.title, b.status, b.starts_at, b.ends_at, b.cancelled_at FROM bookings b JOIN shifts s ON s.id = b.shift_id WHERE b.worker_id = $1 ORDER BY b.starts_at`),
    attendance: await q(`SELECT type, mode, status, effective_at, lat, lng FROM attendance_events WHERE worker_id = $1 ORDER BY effective_at`),
    timesheets: await q(`SELECT started_at, ended_at, payable_minutes, overtime_minutes, gross_paise, status FROM timesheets WHERE worker_id = $1`),
    payslips: await q(`SELECT number, net_paise, created_at, lines FROM payslips WHERE worker_id = $1`),
    strikes: await q(`SELECT kind, points, status, created_at, appeal_reason, decision_reason FROM strikes WHERE worker_id = $1`),
    ratingsReceived: await q(`SELECT stars, tags, comment, created_at FROM ratings WHERE ratee_type = 'worker' AND ratee_id = $1 AND revealed_at IS NOT NULL`),
    ratingsGiven: await q(`SELECT stars, tags, comment, created_at FROM ratings WHERE rater_type = 'worker' AND rater_id = $1`),
    messagesSent: await q(`SELECT m.body, m.status, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.sender_type IN ('worker', 'business') AND m.sender_id = $1 ORDER BY m.created_at`),
    disputes: await q(`SELECT kind, status, summary, created_at, decision, decision_reason FROM dispute_cases WHERE worker_id = $1`),
    incidentsReported: await q(`SELECT category, status, created_at FROM incidents WHERE reporter_id = $1`),
    notifications: await q(`SELECT template, channel, status, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500`),
    businessMemberships: await q(`SELECT b.legal_name, m.role, m.created_at, m.removed_at FROM business_members m JOIN businesses b ON b.id = m.business_id WHERE m.user_id = $1`),
  };
}

/**
 * Deletes the account. Refused while a shift is coming up or money is still on its way (so nobody
 * loses pay). Removes contact details, name, face template, location and payout details; keeps legally
 * required records (timesheets, payslips, ledger, invoices) and fraud-prevention hashes.
 */
export async function deleteAccount(db: Db, userId: string, dataKey: string, ip: string) {
  return withTx(db, async (tx) => {
    const u = (await tx.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (u.status === 'deleted') throw conflict('already_deleted', 'This account is already deleted.');
    const open = (await tx.query(
      `SELECT (SELECT count(*) FROM bookings WHERE worker_id = $1 AND status IN ('confirmed', 'checked_in'))::int AS shifts,
              (SELECT count(*) FROM payouts WHERE worker_id = $1 AND status IN ('pending_approval', 'queued', 'processing', 'held'))::int AS payouts,
              (SELECT count(*) FROM timesheets WHERE worker_id = $1 AND status IN ('awaiting_confirmation', 'pending_approval', 'partially_disputed', 'disputed'))::int AS timesheets,
              (SELECT count(*) FROM business_members m JOIN businesses b ON b.id = m.business_id WHERE m.user_id = $1 AND m.role = 'owner' AND m.removed_at IS NULL)::int AS owned`,
      [userId],
    )).rows[0];
    if (open.shifts) throw conflict('upcoming_shifts', 'Cancel or finish your upcoming shifts first.');
    if (open.payouts || open.timesheets) throw conflict('money_pending', 'Some of your pay is still being processed. You can delete your account once it has been paid.');
    if (open.owned) throw conflict('owns_business', 'Transfer or close the businesses you own first. Contact support.');

    // Deleting can't be used to shake off a suspension or strike limits (WRK-07).
    const limited = (await tx.query('SELECT 1 FROM worker_profiles WHERE user_id = $1 AND limited_until > now()', [userId])).rowCount;
    const reason = u.status === 'suspended' || u.status === 'limited' || limited ? 'while_restricted' : 'user_request';
    await tx.query('INSERT INTO deleted_identities (user_id, phone_hash, blocks_reregistration) VALUES ($1, $2, $3)', [userId, u.phone_hash, reason === 'while_restricted']);
    await tx.query(
      `UPDATE users SET status = 'deleted', deleted_at = now(), deleted_reason = $2, phone_enc = $3, phone_hash = 'deleted:' || id, phone_last4 = '0000',
              whatsapp_opt_in_at = NULL WHERE id = $1`,
      [userId, reason, encrypt('deleted', dataKey)],
    );
    await tx.query(
      `UPDATE worker_profiles SET legal_name_enc = NULL, first_name = 'Deleted', name_norm_hash = NULL, face_embedding = NULL, languages = '{}', skills = '{}',
              home_point = NULL, home_city = NULL, availability = '{}', trusted_contact_name = NULL, trusted_contact_phone_enc = NULL,
              kyc_ref_hash = CASE WHEN $2 THEN kyc_ref_hash ELSE NULL END
        WHERE user_id = $1`,
      [userId, reason === 'while_restricted'],
    );
    if (reason === 'while_restricted') {
      // Keep the identity hash on a side record so the same person can't come back under a new number.
      await tx.query(`UPDATE worker_profiles SET verification_status = 'rejected' WHERE user_id = $1`, [userId]);
    }
    await tx.query(`UPDATE payout_methods SET vpa_enc = NULL, account_no_enc = NULL, name_at_bank_enc = NULL, status = 'replaced' WHERE worker_id = $1`, [userId]);
    await tx.query(`UPDATE consents SET withdrawn_at = now() WHERE user_id = $1 AND withdrawn_at IS NULL`, [userId]);
    await tx.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'account_deleted' WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    await tx.query(`UPDATE business_members SET removed_at = now() WHERE user_id = $1 AND removed_at IS NULL`, [userId]);
    await tx.query(`UPDATE notifications SET status = 'skipped' WHERE user_id = $1 AND status = 'queued'`, [userId]);
    await tx.query(`DELETE FROM sos_locations WHERE sos_id IN (SELECT id FROM sos_events WHERE worker_id = $1)`, [userId]);
    await writeAudit(tx, { actorType: 'user', actorId: userId, action: 'user.deleted', targetType: 'user', targetId: userId, after: { reason }, ip });
    return {
      deleted: true,
      kept: 'Pay, tax and timesheet records are kept for the period the law requires; identity checks keep a one-way fingerprint to prevent fraud. Your name, number, face template, location and bank details are removed.',
    };
  });
}

const WITHDRAWABLE = ['location_at_shift', 'face_verification', 'notifications'] as const;

export async function withdrawConsent(db: Db, userId: string, purpose: string) {
  if (!(WITHDRAWABLE as readonly string[]).includes(purpose)) throw badRequest('not_withdrawable', 'To withdraw the account consent, delete your account.');
  const r = await db.query(`UPDATE consents SET withdrawn_at = now() WHERE user_id = $1 AND purpose = $2 AND withdrawn_at IS NULL`, [userId, purpose]);
  if (!r.rowCount) {
    // Nothing on record (e.g. given before consents were tracked per purpose): record the "no" explicitly.
    await db.query(`INSERT INTO consents (user_id, purpose, version, lang, withdrawn_at)
                    SELECT $1, $2, $3, preferred_lang, now() FROM users WHERE id = $1`, [userId, purpose, CONSENT_VERSION]);
  }
  if (purpose === 'notifications') await db.query(`UPDATE users SET whatsapp_opt_in_at = NULL, reminders_opt_out = true WHERE id = $1`, [userId]);
  return { purpose, withdrawn: true, effect: purpose === 'face_verification' ? 'You will not be able to check in to shifts until you allow it again.' : purpose === 'location_at_shift' ? 'We will stop location checks during shifts (check-in still needs your location once).' : 'Only essential messages (login codes, pay, safety) will be sent.' };
}

export async function grantConsent(db: Db, userId: string, purpose: string, lang: string) {
  if (!(WITHDRAWABLE as readonly string[]).includes(purpose)) throw badRequest('unknown_purpose', 'Unknown purpose.');
  await db.query(`INSERT INTO consents (user_id, purpose, version, lang) SELECT $1, $2, $4, $3
                  WHERE NOT EXISTS (SELECT 1 FROM consents WHERE user_id = $1 AND purpose = $2 AND withdrawn_at IS NULL)`, [userId, purpose, lang, CONSENT_VERSION]);
  if (purpose === 'notifications') await db.query('UPDATE users SET reminders_opt_out = false WHERE id = $1', [userId]);
  return { purpose, granted: true };
}

/** Retention (SPEC §6.12): remove what we no longer need. Runs daily; safe to run any time. */
export async function applyRetention(db: Db) {
  const pol = await getPolicies(db, ['retention.attendance_location_days', 'retention.pings_days', 'retention.messages_days', 'retention.notifications_days', 'retention.sos_location_days', 'retention.otp_days']);
  const n = async (sql: string, days: number) => (await db.query(sql, [days])).rowCount ?? 0;
  return {
    attendanceLocations: await n(`UPDATE attendance_events SET lat = NULL, lng = NULL, accuracy_m = NULL WHERE lat IS NOT NULL AND created_at < now() - make_interval(days => $1)`, pol['retention.attendance_location_days']),
    pings: await n(`DELETE FROM attendance_pings WHERE at < now() - make_interval(days => $1)`, pol['retention.pings_days']),
    messages: await n(`UPDATE messages SET body = '[removed after retention period]', original_enc = NULL WHERE created_at < now() - make_interval(days => $1) AND body <> '[removed after retention period]'`, pol['retention.messages_days']),
    notifications: await n(`DELETE FROM notifications WHERE created_at < now() - make_interval(days => $1) AND status IN ('sent', 'failed', 'skipped')`, pol['retention.notifications_days']),
    sosLocations: await n(`DELETE FROM sos_locations WHERE sos_id IN (SELECT id FROM sos_events WHERE status = 'resolved' AND resolved_at < now() - make_interval(days => $1))`, pol['retention.sos_location_days']),
    otps: await n(`DELETE FROM otp_requests WHERE created_at < now() - make_interval(days => $1)`, pol['retention.otp_days']),
    devOutbox: await n(`DELETE FROM dev_outbox WHERE created_at < now() - make_interval(days => $1)`, 7),
  };
}

