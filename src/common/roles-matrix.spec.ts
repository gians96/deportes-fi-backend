import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AcademicController } from '../academic/academic.controller';
import { AdminController } from '../admin/admin.controller';
import { AuthController } from '../auth/auth.controller';
import { DisciplinesController } from '../disciplines/disciplines.controller';
import { DniTokensController } from '../dni-providers/dni-tokens.controller';
import { EventTokensController } from '../event-tokens/event-tokens.controller';
import { EventsController } from '../events/events.controller';
import { FacultiesController } from '../faculties/faculties.controller';
import { GroupsController } from '../groups/groups.controller';
import { IntegrationsController } from '../integrations/integrations.controller';
import { RegistrationsController } from '../registrations/registrations.controller';
import { SchedulingController } from '../scheduling/scheduling.controller';
import { StandingsController } from '../standings/standings.controller';
import { UndcApiController } from '../undc-api/undc-api.controller';
import { UsersController } from '../users/users.controller';
import { VouchersController } from '../vouchers/vouchers.controller';
import { ROLES_KEY } from './decorators/roles.decorator';
import { PAYMENT_ROLES, STAFF_ROLES, isStaffRole } from './roles';

const CONTROLLERS: Array<Type<unknown>> = [
  AcademicController,
  AdminController,
  AuthController,
  DisciplinesController,
  DniTokensController,
  EventTokensController,
  EventsController,
  FacultiesController,
  GroupsController,
  IntegrationsController,
  RegistrationsController,
  SchedulingController,
  StandingsController,
  UndcApiController,
  UsersController,
  VouchersController,
];

/** Roles declarados para cada ruta (`Controlador.método`); el método manda sobre la clase. */
function declaredRoles(): Map<string, readonly Role[]> {
  const result = new Map<string, readonly Role[]>();
  for (const controller of CONTROLLERS) {
    const classRoles = Reflect.getMetadata(ROLES_KEY, controller) as
      | Role[]
      | undefined;
    const prototype = controller.prototype as Record<string, unknown>;
    const methods = Object.getOwnPropertyNames(prototype).filter(
      (name) => name !== 'constructor' && typeof prototype[name] === 'function',
    );
    for (const method of methods) {
      const handler = prototype[method] as object;
      const methodRoles = Reflect.getMetadata(ROLES_KEY, handler) as
        | Role[]
        | undefined;
      const roles = methodRoles ?? classRoles;
      if (roles?.length) result.set(`${controller.name}.${method}`, roles);
    }
  }
  return result;
}

/**
 * Lo único que el Tesorero puede hacer con un `@Roles` explícito: ver y validar pagos. Las rutas sin
 * `@Roles` (p. ej. `GroupsController.findOne`) deciden en el servicio.
 */
const TREASURER_ROUTES = [
  'AdminController.dashboard',
  'GroupsController.findAll',
  'RegistrationsController.findAll',
  'VouchersController.findAll',
  'VouchersController.reject',
  'VouchersController.validate',
];

describe('matriz de roles', () => {
  const routes = declaredRoles();

  it('detecta las rutas protegidas (la prueba no es vacía)', () => {
    expect(routes.size).toBeGreaterThan(30);
  });

  it('el Tesorero solo accede a las rutas de pagos esperadas', () => {
    const allowed = [...routes.entries()]
      .filter(([, roles]) => roles.includes(Role.TREASURER))
      .map(([route]) => route)
      .sort();
    expect(allowed).toEqual(TREASURER_ROUTES);
  });

  it('el Tesorero no aprueba ni rechaza equipos, ni gestiona usuarios, eventos, tokens o DNI', () => {
    for (const route of [
      'RegistrationsController.approve',
      'RegistrationsController.reject',
      'UsersController.create',
      'UsersController.setPassword',
      'EventsController.create',
      'EventTokensController.create',
      'DniTokensController.list',
      'DniTokensController.create',
      'DniTokensController.manualLookup',
      'DniTokensController.clearCache',
      'UndcApiController.get',
      'UndcApiController.save',
      'UndcApiController.test',
      'UndcApiController.remove',
      'VouchersController.replace',
    ]) {
      const roles = routes.get(route);
      expect(roles).toBeDefined();
      expect(roles).not.toContain(Role.TREASURER);
    }
  });

  it('todas las rutas del Tesorero también las puede usar el equipo (Owner y Administrador)', () => {
    for (const route of TREASURER_ROUTES) {
      expect(routes.get(route)).toEqual(
        expect.arrayContaining([...STAFF_ROLES]),
      );
    }
  });

  it('cambiar el estado de un equipo y corregir o reabrir comprobantes (spec 007) son solo de Owner y Administrador', () => {
    for (const route of [
      'RegistrationsController.setStatus',
      'VouchersController.reopen',
      'VouchersController.update',
    ]) {
      expect([...(routes.get(route) ?? [])].sort()).toEqual(
        [...STAFF_ROLES].sort(),
      );
    }
  });

  it('las rutas de gestión de usuarios solo son de Owner y Administrador', () => {
    for (const [route, roles] of routes) {
      if (route.startsWith('UsersController.')) {
        expect([...roles].sort()).toEqual([...STAFF_ROLES].sort());
      }
    }
  });

  it('PAYMENT_ROLES = equipo + tesorero; isStaffRole excluye al tesorero', () => {
    expect([...PAYMENT_ROLES].sort()).toEqual(
      [Role.OWNER_SYSTEM, Role.ADMIN_SYSTEM, Role.TREASURER].sort(),
    );
    expect(isStaffRole(Role.TREASURER)).toBe(false);
    expect(isStaffRole(Role.ADMIN_SYSTEM)).toBe(true);
  });
});
