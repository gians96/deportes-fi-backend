# Tasks: Borradores de equipo, edición, un salón por alumno y DNI automático

## Fase 1 — Esquema

- [x] T001 `RegistrationStatus.DRAFT` y modelo `UndcApiConfig` en `schema.prisma`; migraciones revisadas a mano y aplicadas en local.

## Fase 2 — Borradores y edición (US1, US2)

- [x] T002 DTOs (`UpdateRegistrationDto`, `draft` al crear) y validación de borrador en `registrations.service`.
- [x] T003 `PATCH /registrations/:id`, `POST /registrations/:id/submit`, `DELETE /registrations/:id` + permisos.
- [x] T004 Borradores fuera de aprobación, rechazo, validación de vouchers, tesorero, Contrato 2, admin y clasificaciones.
- [x] T005 `GroupDetail.draftCount` y vista del tesorero sin borradores.
- [x] T006 Pruebas Jest de borrador → editar → enviar, permisos, borrado de adicional y exclusiones.

## Fase 3 — Un salón por alumno (US3)

- [x] T007 Regla en `GroupsService.create` + pruebas (incluye reintento tras rechazo y exención de staff).

## Fase 4 — DNI automático (US4)

- [x] T008 Cliente `undc-client.ts` con validación SSRF y pruebas.
- [x] T009 Servicio y controlador `settings/undc-api` (GET/PUT/test), cifrado, roles (`roles-matrix.spec.ts`).
- [x] T010 `AcademicService.findUniqueStudent` con JP primero y respaldo público + pruebas.

## Fase 5 — Cierre

- [x] T011 `docs/api-contract.md`, `data-model.md`, runbook y `AGENTS.md`.
- [x] T012 `bun run build`, `bun run test` y eslint en los archivos tocados.
- [x] T013 Prueba local con API_UNDC simulada; evidencia en la spec.
