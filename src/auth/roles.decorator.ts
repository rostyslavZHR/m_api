import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../entities/index.js';

// @Roles('seller', 'admin'): only these roles may call the route (RolesGuard checks it).
// No @Roles: any authenticated user. Says what kind of user may call it, not whose
// resource it is: ownership is a separate check where the resource is loaded.
export const ROLES = 'auth:roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES, roles);
