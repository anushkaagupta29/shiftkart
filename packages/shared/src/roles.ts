export const STAFF_ROLES = [
  'ops_support', 'ops_verifier', 'ops_disputes', 'ops_safety', 'finance', 'compliance', 'super_admin',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const USER_KINDS = ['worker', 'business'] as const;
export type UserKind = (typeof USER_KINDS)[number];

export const MEMBER_ROLES = ['owner', 'manager', 'supervisor'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const LANGS = ['en', 'hi', 'kn'] as const;
export type Lang = (typeof LANGS)[number];
