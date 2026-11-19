import type { Role } from '@roadmap/shared';

const NAMES: Record<Role, string> = { owner: 'Owner', admin: 'Admin', contributor: 'Contributor' };

/** A role as it reads on screen. */
export const roleName = (role: Role): string => NAMES[role];
