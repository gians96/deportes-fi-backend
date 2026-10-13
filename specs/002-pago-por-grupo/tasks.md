---
description: "Lista de tareas de implementación — Pago por salón o ciclo"
---

# Tasks: Pago por salón o ciclo con voucher compartido

**Input**: documentos de `specs/002-pago-por-grupo/`

**Prerequisites**: plan.md, spec.md, data-model.md, contracts/

**Tests**: obligatorios (precios, normalización, cupos, exclusión, validación en bloque, agregación
y aislamiento entre eventos), con *fakes* de Prisma, sin base real.

## Format: `[ID] [P?] [Story] Descripción`

- **[P]**: paralelizable (archivos distintos, sin dependencias).
- **[Story]**: historia de `spec.md` (US1…US7).

## Phase 1: Setup

- [x] T001 Crear la rama `feat/pago-por-grupo` desde `feat/tokens-evento`
- [x] T002 Escribir `spec.md`, `plan.md`, `data-model.md`, `contracts/`, `quickstart.md`, `checklists/requirements.md` y `tasks.md`

---

## Phase 2: Foundational (bloquea todas las historias)

- [ ] T003 Agregar enums, `EventPricing`, `ClassGroup` y los campos nuevos en `prisma/schema.prisma`
- [ ] T004 Crear `prisma/migrations/<ts>_pago_por_grupo/migration.sql` (generada con `prisma migrate diff` datamodel→datamodel, revisada a mano; incluye el backfill de `Team.voucherId`)
- [ ] T005 Verificar en una BD *shadow* local que migraciones + la nueva vs. esquema solo dejan la deriva previa
- [ ] T006 [P] `src/groups/group-normalize.ts` (`normalizeCycle`, `normalizeSection`, `groupLabel`) + `group-normalize.spec.ts` (5/V/ciclo V/v ciclo, A-1/a 1/sección A1, vacíos, fuera de I–XII)
- [ ] T007 [P] `src/groups/group-pricing.ts` (`baseFee`, `extraFee`, `allocateCents`) + `group-pricing.spec.ts` (suma exacta n=1..7, centavos, monto 0)
- [ ] T008 Regenerar el cliente (`bunx prisma generate`) y ajustar tipos que usaban `voucher.team` singular

**Checkpoint**: esquema, migración y núcleo puro listos.

---

## Phase 3: US7 - Tarifas del evento (P2)

- [ ] T009 [P] [US7] DTO `src/events/dto/update-pricing.dto.ts` (modo, 4 tarifas ≥ 0 con 2 decimales)
- [ ] T010 [US7] `EventsService.getPricing/setPricing` y rutas `GET/PUT /events/:eventId/pricing`
- [ ] T011 [US7] Pruebas: valores por defecto, 400 al volver a `PER_DISCIPLINE` con grupos, tarifas inválidas

## Phase 4: US1 - Crear grupo con pago base (P1) 🎯 MVP

- [ ] T012 [P] [US1] DTO `src/groups/dto/create-group.dto.ts`
- [ ] T013 [US1] `GroupsService.create` en transacción: validar evento `PER_GROUP` y abierto, normalizar, exclusión ciclo/sección, crear grupo + voucher `BASE`, capturar `P2002` → 409
- [ ] T014 [US1] `GroupsController` (`POST /groups` multipart con `voucherMulterOptions`, `GET /groups/mine`, `GET /groups/:id`, `GET /groups`) y `GroupsModule` registrado en `src/app.module.ts`
- [ ] T015 [US1] Pruebas: monto 100/150, 409 duplicado normalizado, exclusión en ambos sentidos, evento no `PER_GROUP`, grupo con base rechazado y sin equipos activos no cuenta

## Phase 5: US2 + US3 - Equipos con cupos y adicionales (P1)

- [ ] T016 [P] [US2] Ampliar `ParticipantDto` (`isCaptain`) y el parseo de `POST /registrations` (`groupId`, `extraVoucherId`)
- [ ] T017 [US2] `RegistrationsService.create`: rama `PER_GROUP` (tomar ciclo/sección del grupo, `CICLO COMPLETO`, asignar cupo, nómina con capitán y DNI+código)
- [ ] T018 [US3] Cupo ≥ 2: crear `EXTRA` con tarifa adicional, o enlazar a `extraVoucherId` y recalcular monto; reintento ante `P2002`
- [ ] T019 [US2] `reject`: liberar cupo (`slot = NULL`); `approve`: comprobar voucher que cubre al equipo y rechazar equipos `REJECTED`/`CANCELLED`
- [ ] T020 [US2] Pruebas: 5 disciplinas con un solo voucher, nómina inválida, mismo alumno en varias disciplinas permitido, `groupId` ajeno, `maxTeams` y plazo
- [ ] T021 [US3] Pruebas: segundo equipo exige voucher, monto 20/30, cupo por disciplina, cupo liberado tras rechazo, carrera simulada

## Phase 6: US4 + US5 - Validación en bloque y re-subida (P1/P2)

- [ ] T022 [US4] `VouchersService.validate`: ramas `TEAM` (igual que hoy) y `BASE`/`EXTRA` (transacción, aprobar equipos válidos, `approvedTeamIds`/`skipped`, 400 sin equipos)
- [ ] T023 [US4] `VouchersService.reject`: devolver a `PENDING` los equipos `APPROVED` dependientes
- [ ] T024 [US4] `VouchersService.findAll`: usar `voucher.teams`, agregar `kind`, `groupId`, `groupLabel`, `teams[]`
- [ ] T025 [US5] `PATCH /vouchers/:id/replace` (permisos, solo `REJECTED`, mismo `id`)
- [ ] T026 [US4] Pruebas: bloque con equipos válidos e inválidos, rechazo, `TEAM` sin cambios (regresión), replace con permisos

## Phase 7: US6 - Contrato 2 (P1)

- [ ] T027 [US6] `IntegrationsService.summary`: vouchers distintos del evento, `allocateCents` por equipo, mismas formas
- [ ] T028 [US6] `IntegrationsService.listPayments`: filtro por equipos o grupo del evento, etiquetas de `BASE`/`EXTRA`
- [ ] T029 [US6] Pruebas: regresión 001 (`PER_DISCIPLINE`), evento mixto con invariantes, aislamiento entre eventos, `Σ byDiscipline = payments.validated`

## Phase 8: Cierre

- [ ] T030 Actualizar `docs/api-contract.md` y `docs/data-model.md`; escribir `docs/runbook-pago-por-grupo.md` (baseline de deriva, orden de despliegue, reversión, contracción posterior)
- [ ] T031 `bun run build`, `bun run test`, `bunx eslint <archivos tocados>` sin errores nuevos
- [ ] T032 Prueba de humo local (servidor :3030 contra MariaDB Docker :3311) siguiendo `quickstart.md`
- [ ] T033 Cerrar la spec: evidencia de verificación y estado "Implementada"; avisar al mantenedor del congreso del delta de valores del Contrato 2

**Después de este feature (otra spec)**: contracción (`Voucher.teamId`, doble escritura) y el frontend
en `frontend/specs/002-*`.
