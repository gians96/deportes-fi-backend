import { Role } from '@prisma/client';

/** Equipo que administra el sistema: configura, gestiona usuarios y aprueba equipos. */
export const STAFF_ROLES: readonly Role[] = [
  Role.OWNER_SYSTEM,
  Role.ADMIN_SYSTEM,
];

/** Quienes ven y validan pagos (comprobantes): el equipo y el tesorero. */
export const PAYMENT_ROLES: readonly Role[] = [...STAFF_ROLES, Role.TREASURER];

export function isStaffRole(role: Role): boolean {
  return STAFF_ROLES.includes(role);
}
