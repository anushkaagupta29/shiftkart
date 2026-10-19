import type { StaffRole, UserKind } from '@shiftkart/shared';

/** Every route must declare one of these (enforced at startup in auth/guard.ts). */
export type AuthRule =
  | { public: true }
  | { user: { kinds?: UserKind[] } }
  | { staff: StaffRole[] | 'any' };

export type UserActor = {
  type: 'user';
  userId: string;
  kind: UserKind;
  status: string;
  sessionId: string;
  familyId: string;
};

export type StaffActor = {
  type: 'staff';
  staffId: string;
  email: string;
  name: string;
  roles: StaffRole[];
  sessionId: string;
};

export type Actor = UserActor | StaffActor;

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: AuthRule;
  }
  interface FastifyRequest {
    actor: Actor | null;
  }
}
