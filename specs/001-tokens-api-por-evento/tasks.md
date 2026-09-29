---
description: "Lista de tareas de implementación — Tokens API por evento"
---

# Tasks: Tokens API por evento

**Input**: documentos de `specs/001-tokens-api-por-evento/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: solicitados explícitamente (token/hash, guard, agregación, aislamiento entre eventos).

## Format: `[ID] [P?] [Story] Descripción`

- **[P]**: paralelizable (archivos distintos, sin dependencias).
- **[Story]**: historia de usuario (US1…US4) de `spec.md`.

## Phase 1: Setup

- [x] T001 Agregar andamiaje de Spec Kit (`.specify/`, `.claude/skills/speckit-*`) y completar `.specify/memory/constitution.md`
- [x] T002 Escribir `spec.md`, `research.md`, `plan.md`, `data-model.md`, `contracts/`, `quickstart.md` y `checklists/requirements.md`

---

## Phase 2: Foundational (bloquea todas las historias)

- [x] T003 Agregar `EventApiToken` y la relación `SportEvent.apiTokens` en `prisma/schema.prisma`
- [x] T004 Crear `prisma/migrations/20260929150000_event_api_tokens/migration.sql` (generada con `prisma migrate diff` datamodel→datamodel y revisada a mano: solo tabla, FK e índices)
- [x] T005 Verificar en la BD *shadow* local que migraciones + nueva migración vs. esquema solo dejan la deriva previa
- [x] T006 [P] Implementar `src/event-tokens/api-token.util.ts` (generar, hashear, validar formato, resolver pepper) con pruebas en `src/event-tokens/api-token.util.spec.ts`
- [x] T007 Implementar `src/event-tokens/api-token-hasher.service.ts` (pepper desde `ConfigService`, 503 si no está configurado)
- [x] T008 [P] Documentar `API_TOKEN_PEPPER` en `.env.example`

**Checkpoint**: esquema, migración y criptografía listos.

---

## Phase 3: User Story 1 - Emitir un token de integración (P1) 🎯 MVP

**Goal**: un admin crea y lista tokens de un evento; el token en claro se ve una sola vez.

**Independent Test**: `POST` y `GET /events/:eventId/api-tokens`; en la base solo queda el hash.

- [x] T009 [P] [US1] DTO `src/event-tokens/dto/create-event-api-token.dto.ts` (nombre 1–100, `expiresAt` ISO opcional)
- [x] T010 [US1] `EventTokensService.create/list` con estado derivado en `src/event-tokens/event-tokens.service.ts`
- [x] T011 [US1] `EventTokensController` (`POST`/`GET`) con `JwtAuthGuard`, `RolesGuard`, `@Roles(OWNER_SYSTEM, ADMIN_SYSTEM)` en `src/event-tokens/event-tokens.controller.ts`
- [x] T012 [US1] `EventTokensModule` (exporta `ApiTokenHasher`) y registro en `src/app.module.ts`
- [x] T013 [US1] Pruebas en `src/event-tokens/event-tokens.service.spec.ts` (solo hash persistido, token una vez, 404 evento, expiración pasada → 400)

**Checkpoint**: US1 funcional y probada.

---

## Phase 4: User Story 2 - El congreso consulta su evento (P1)

**Goal**: cuatro endpoints del Contrato 2 autenticados con `X-Api-Key` y acotados al evento del token.

**Independent Test**: token del evento A → datos solo de A, números correctos.

- [x] T014 [US2] Guard `src/common/guards/event-token.guard.ts` y decorador `src/common/decorators/current-event-token.decorator.ts`
- [x] T015 [P] [US2] Pruebas del guard en `src/common/guards/event-token.guard.spec.ts` (válido, ausente, mal formado, desconocido, revocado, expirado, `lastUsedAt` sin bloquear)
- [x] T016 [P] [US2] DTO de consulta `src/integrations/dto/integration-list-query.dto.ts` (`status`, `page`, `pageSize`)
- [x] T017 [US2] `IntegrationsService` (evento, resumen, pagos, inscripciones) en `src/integrations/integrations.service.ts`
- [x] T018 [US2] `IntegrationsController` + `IntegrationsModule` y registro en `src/app.module.ts`
- [x] T019 [P] [US2] Fake de Prisma en memoria `test/fakes/in-memory-prisma.ts` (exige filtro por `eventId`)
- [x] T020 [US2] Pruebas `src/integrations/integrations.service.spec.ts` (números del resumen, paginación, sin datos sensibles, aislamiento A/B)
- [x] T021 [US2] Pruebas HTTP `src/integrations/integrations.http.spec.ts` (401 exacto, `?eventId=` ignorado, 400 de validación, sin JWT)

**Checkpoint**: US1 + US2 funcionales.

---

## Phase 5: User Story 3 - Revocar y expirar (P2)

- [x] T022 [US3] `EventTokensService.revoke` + `DELETE /events/:eventId/api-tokens/:id` (idempotente, 404 si es de otro evento)
- [x] T023 [US3] Pruebas de revocación en `event-tokens.service.spec.ts` y de revocado/expirado en las pruebas HTTP

---

## Phase 6: User Story 4 - Despliegue seguro (P3)

- [x] T024 [US4] Runbook `docs/runbook-tokens-evento.md` (opciones A/B, baseline de deriva, pepper, rollback)
- [x] T025 [US4] Simular las opciones A y B del runbook en una BD local temporal
- [x] T026 [P] [US4] `docs/deployment.md`: variable `API_TOKEN_PEPPER` y checklist

---

## Phase 7: Polish & Cross-Cutting

- [x] T027 [P] Actualizar `docs/api-contract.md` (admin + integración)
- [x] T028 [P] Actualizar `docs/data-model.md`, `docs/README.md`, `README.md` y `AGENTS.md`
- [x] T029 Puertas de calidad: `bun run build`, `bun run test`, ESLint sin errores nuevos
- [x] T030 Prueba de humo local (`quickstart.md`): emitir, 4 endpoints, aislamiento A/B, revocación → 401
- [x] T031 Marcar la spec como implementada

---

## Dependencies & Execution Order

- Phase 2 bloquea todo. US1 y US2 dependen de T003–T007; US2 no requiere US1 (el token puede
  sembrarse directo). US3 extiende US1. US4 y Polish al final.
- Dentro de cada historia: DTO → service → controller/módulo → pruebas.

## Implementation Strategy

MVP = Phase 2 + US1 + US2 (el congreso ya puede integrarse). Luego US3 (ciclo de vida) y US4
(producción).

## Evidencia de verificación (2026-09-29)

- `bun run build`: sin errores.
- `bun run test`: 6 suites, 79 pruebas en verde (token/hash/pepper, guard, servicio admin,
  agregación, aislamiento A/B y HTTP extremo a extremo con fake de Prisma).
- ESLint: 0 errores nuevos (se mantienen 102 errores de formato previos en archivos no
  tocados por este feature).
- Prueba de humo local (MariaDB Docker, servidor en :3030): 57/57 verificaciones, incluidas
  aislamiento A/B, `?eventId=` ignorado, 401 exacto, expiración real, revocación y hash en BD.
  En modo producción sin `API_TOKEN_PEPPER`: API en pie, tokens → 503 y error en el log.
- Runbook validado en una BD temporal local: opción A (solo se aplica la nueva migración sobre
  una base con deriva; el esquema resultante coincide con `schema.prisma`), baseline de la deriva
  con `migrate resolve --applied` y opción B (`db push` + `migrate resolve`).
- Preexistente y ajeno al feature: `bun run test:e2e` falla (el scaffold espera `GET /` →
  "Hello World!").
