import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sha256 } from '@shiftkart/shared';
import type { Db } from '../db';
import { forbidden, unauthorized } from '../lib/errors';
import type { AuthRule, StaffActor, UserActor } from './types';

export type RouteAuth = { method: string; url: string; auth: AuthRule };

declare module 'fastify' {
  interface FastifyInstance {
    authTable: RouteAuth[];
  }
}

export const STAFF_COOKIE = 'sk_staff';
export const USER_COOKIE = 'sk_user';
export const USER_REFRESH_COOKIE = 'sk_user_rt';

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

async function loadUser(db: Db, token: string): Promise<UserActor | null> {
  const r = await db.query(
    `SELECT s.id AS session_id, s.family_id, u.id AS user_id, u.kind, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.access_hash = $1 AND s.revoked_at IS NULL AND s.rotated_at IS NULL AND s.access_expires_at > now()`,
    [sha256(token)],
  );
  const row = r.rows[0];
  if (!row || row.status === 'suspended' || row.status === 'deleted') return null;
  return { type: 'user', userId: row.user_id, kind: row.kind, status: row.status, sessionId: row.session_id, familyId: row.family_id };
}

async function loadStaff(db: Db, token: string): Promise<StaffActor | null> {
  const r = await db.query(
    `SELECT ss.id AS session_id, su.id AS staff_id, su.email, su.name, su.roles
       FROM staff_sessions ss JOIN staff_users su ON su.id = ss.staff_id
      WHERE ss.token_hash = $1 AND ss.revoked_at IS NULL AND ss.expires_at > now() AND su.status = 'active'`,
    [sha256(token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { type: 'staff', staffId: row.staff_id, email: row.email, name: row.name, roles: row.roles, sessionId: row.session_id };
}

/**
 * Auth on every endpoint, enforced server-side:
 *  - a route without an `auth` rule fails at startup (deny by default);
 *  - user and staff tokens are separate (a worker token can never reach /admin);
 *  - roles and user kinds are checked before the handler or body validation runs.
 */
export function registerAuthGuard(app: FastifyInstance, db: Db): void {
  app.decorateRequest('actor', null);

  const table: RouteAuth[] = [];
  app.decorate('authTable', table);
  app.addHook('onRoute', (route) => {
    if (!route.config?.auth) throw new Error(`Route ${route.method} ${route.url} has no auth rule`);
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD') table.push({ method, url: route.url, auth: route.config.auth });
    }
  });

  app.addHook('onRequest', async (req) => {
    const rule = req.routeOptions.config?.auth;
    if (!rule) {
      // Fastify's not-found handler, and CORS preflights (which carry no credentials and run no handler).
      if (req.is404 || req.method === 'OPTIONS') return;
      throw forbidden();
    }
    if ('public' in rule) return;

    if ('staff' in rule) {
      const token = req.cookies?.[STAFF_COOKIE] ?? (bearer(req)?.startsWith('sk_st_') ? bearer(req) : null);
      const staff = token ? await loadStaff(db, token) : null;
      if (!staff) throw unauthorized();
      if (rule.staff !== 'any' && !staff.roles.some((r) => (rule.staff as string[]).includes(r))) throw forbidden();
      req.actor = staff;
      return;
    }

    // Mobile app sends a Bearer token; the business web app uses an HttpOnly cookie.
    const token = bearer(req) ?? req.cookies?.[USER_COOKIE] ?? null;
    const user = token?.startsWith('sk_at_') ? await loadUser(db, token) : null;
    if (!user) throw unauthorized();
    if (rule.user.kinds && !rule.user.kinds.includes(user.kind)) throw forbidden();
    req.actor = user;
  });
}

export function userActor(req: FastifyRequest): UserActor {
  if (req.actor?.type !== 'user') throw unauthorized();
  return req.actor;
}

export function staffActor(req: FastifyRequest): StaffActor {
  if (req.actor?.type !== 'staff') throw unauthorized();
  return req.actor;
}
