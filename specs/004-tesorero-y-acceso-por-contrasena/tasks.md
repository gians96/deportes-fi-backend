---
description: "Lista de tareas de implementación — Rol Tesorero y acceso por contraseña (backend)"
---

# Tasks: Rol Tesorero y acceso por contraseña (backend)

**Input**: `specs/004-tesorero-y-acceso-por-contrasena/spec.md`

**Tests**: Jest sin base de datos (fakes), `bun run test`.

## Phase 1: Base

- [x] T001 `spec.md` y `tasks.md`
- [x] T002 `prisma/schema.prisma` (`TREASURER`, `passwordHash`, `tokenVersion`) y migración `20261014120000_tesorero_y_acceso_por_contrasena`
- [x] T003 `src/common/roles.ts` (`STAFF_ROLES`, `PAYMENT_ROLES`)

## Phase 2: Acceso por contraseña (US1)

- [x] T004 `src/auth/password.ts` + prueba
- [x] T005 `src/auth/login-throttle.ts` + prueba
- [x] T006 `AuthService.loginWithPassword`, `POST /auth/login`, `tv` en el JWT y `JwtStrategy` + pruebas
- [x] T007 `upsertUser` conserva el rol de cuentas con contraseña + prueba
- [x] T008 `UsersService` y `UsersController`: `TREASURER`, contraseña al crear, `PATCH /users/:id/password`, `hasPassword`/`googleLinked` + pruebas

## Phase 3: Tesorero (US2)

- [x] T009 `@Roles` del Tesorero en vouchers, registrations (solo `GET`), groups (solo lectura) y admin
- [x] T010 Prueba de la matriz de roles por controlador

## Phase 4: Cierre

- [x] T011 `docs/api-contract.md`, `data-model.md`, `AGENTS.md`, `.env.example` (sin variables nuevas) y `docs/runbook-roles-y-pool-dni.md`
- [x] T012 `bun run build`, `bun run test`, eslint de los archivos tocados, `migrate diff`
- [x] T013 Humo con la API real contra la base local (estudiante con contraseña, bloqueo, Tesorero, Google)
