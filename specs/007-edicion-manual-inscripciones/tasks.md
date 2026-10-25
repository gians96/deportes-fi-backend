# Tasks: Edición manual de inscripciones y estado «Observado»

## Fase 1 — Esquema

- [x] T001 `RegistrationStatus.OBSERVED` y `Team.observation` en `schema.prisma`; migración `20261024120000_estado_observado` revisada y aplicada en local.

## Fase 2 — Registrations (US1, US2, US3, US4)

- [x] T002 `SetStatusDto` y `PATCH /registrations/:id/status` (`RegistrationsService.setStatus`, `nextFreeSlot`, `assertApprovable`).
- [x] T003 `OBSERVED` corregible por el delegado sin plazo (`assertCanManage`, `update`, `submit`); campos solo-staff en `UpdateRegistrationDto`.
- [x] T004 `remove` del staff en cualquier estado con bloqueo por partidos.

## Fase 3 — Vouchers

- [x] T005 `PATCH /vouchers/:id/reopen` y `PATCH /vouchers/:id` (solo staff); `validateTeamVoucher` rechaza equipos observados.

## Fase 4 — Efectos del nuevo estado

- [x] T006 Contrato 2 (`OBSERVED` → `PENDING`), dashboard, `isActiveGroup` y `observation` en `GroupDetail`.

## Fase 5 — Pruebas y cierre

- [x] T007 Pruebas Jest (`registrations.status.spec.ts`, DTO, vouchers, integrations, groups, `roles-matrix`) y fakes ampliados.
- [x] T008 `docs/api-contract.md`, `data-model.md`, `AGENTS.md`, `docs/README.md` y `runbook-estado-observado.md`.
- [x] T009 `bun run build`, `bun run test` y eslint en los archivos tocados.
- [x] T010 Prueba de humo local (servidor :3030 + MariaDB Docker :3311); evidencia en la spec.
