# Feature Specification: Edición manual de inscripciones y estado «Observado»

**Feature Branch**: `feat/edicion-manual-inscripciones`

**Created**: 2026-10-24

**Status**: Implementada (2026-10-25)

**Input**: «En Admin → Inscripciones quiero poder editar toda esa inscripción manualmente: di en aprobar cuando me
equivoqué; poder eliminar, editar, modificar todos los parámetros, o marcarla como observada o según el estado que sea,
para que el equipo pueda volver a modificar.»

**Depende de**: `006-borradores-edicion-dni-automatico` (borradores, `PATCH/submit/DELETE /registrations/:id`,
`assertCanManage`), `002-pago-por-grupo` (vouchers `BASE`/`EXTRA`, cupos).

## Decisiones (confirmadas con el usuario)

1. **Alcance**: datos del equipo, nómina, estado y datos del comprobante. **No** se mueve un equipo de disciplina ni de
   salón o ciclo.
2. **Observado sin plazo**: el delegado corrige y reenvía un equipo observado aunque el plazo de la disciplina o el evento
   estén cerrados (observar es una reapertura explícita del administrador).
3. **Eliminar** es un borrado definitivo con confirmación, en cualquier estado; se bloquea si el equipo ya figura en un
   partido del fixture.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Deshacer un «Aprobar» o «Rechazar» equivocado (Priority: P1)

Owner y Administrador llevan un equipo a cualquier estado (`PENDING`, `APPROVED`, `REJECTED`, `OBSERVED`, `CANCELLED`).

**Acceptance Scenarios**:

1. **Given** un equipo `APPROVED`, **When** el staff lo pasa a `PENDING` (`PATCH /registrations/:id/status`), **Then** conserva
   su cupo y su comprobante (que sigue validado).
2. **Given** un equipo `REJECTED` (cupo liberado), **When** se pasa a `PENDING` o `APPROVED`, **Then** recupera el menor
   cupo libre; si solo queda un cupo adicional y lo cubre el pago base, responde `400` explicando qué hacer.
3. **Given** `REJECTED` u `OBSERVED` sin motivo, **Then** `400`. `DRAFT` no es destino válido.
4. **Given** `APPROVED` como destino, **Then** rigen las reglas de `approve` (bases cumplidas y comprobante validado).
5. **Given** un comprobante validado o rechazado por error, **When** el staff lo reabre (`PATCH /vouchers/:id/reopen`),
   **Then** vuelve a `PENDING` y los equipos aprobados con él vuelven a `PENDING`.

### User Story 2 - Devolver un equipo al delegado: «Observado» (Priority: P1)

**Acceptance Scenarios**:

1. **Given** cualquier equipo enviado, **When** el staff lo marca `OBSERVED` con un texto, **Then** conserva cupo y
   comprobante, el delegado ve la observación (`observation`) y puede editarlo y reenviarlo.
2. **Given** un equipo `OBSERVED`, **When** el delegado lo edita (`PATCH`) y lo reenvía (`POST :id/submit`) fuera de plazo
   o con el evento cerrado, **Then** pasa a `PENDING` y la observación se limpia; la nómina se valida con las reglas
   completas solo al reenviar.
3. **Given** un equipo `OBSERVED`, **Then** el delegado no cambia el delegado/ciclo/sección, no lo elimina, y otro delegado
   no lo toca. Un equipo `PENDING`/`APPROVED` sigue siendo solo del staff.
4. **Given** un equipo `OBSERVED`, **Then** validar su voucher propio responde `400` y un pago base/adicional no lo aprueba.

### User Story 3 - Editar todos los parámetros de la inscripción (Priority: P1)

El staff corrige nombre, celular, delegado, ciclo y sección (solo equipos sin salón o ciclo), cada jugador (nombre, código,
DNI, género, capitán) y, en el comprobante, el N.º de operación y el monto (`PATCH /vouchers/:id`).

### User Story 4 - Eliminar una inscripción (Priority: P2)

El staff elimina un equipo en cualquier estado (libera el cupo; limpia el comprobante adicional pendiente que quede huérfano);
`400` si figura en un partido. El delegado sigue quitando solo borradores.

## Requirements

- **FR-001** `RegistrationStatus.OBSERVED` y `Team.observation` (migración aditiva `20261024120000_estado_observado`).
- **FR-002** `PATCH /registrations/:id/status` (solo Owner/Administrador) con las reglas de las historias 1 y 2.
- **FR-003** `assertCanManage`, `update` y `submit` tratan `OBSERVED` como corregible por el delegado, sin plazo.
- **FR-004** `PATCH /registrations/:id` acepta `delegateId`, `cycle`, `section` solo del staff (`403` al delegado; `400` en
  equipos de salón o ciclo para `cycle`/`section`).
- **FR-005** `DELETE /registrations/:id` del staff en cualquier estado, bloqueado por partidos.
- **FR-006** `PATCH /vouchers/:id/reopen` y `PATCH /vouchers/:id` solo para Owner/Administrador (el Tesorero no los gana:
  `roles-matrix.spec.ts`).
- **FR-007** Contrato 2: `OBSERVED` se informa como `PENDING`, sin valores ni campos nuevos. Dashboard: «Observados».
  `isActiveGroup` cuenta `OBSERVED` como equipo vivo.
- **FR-008** `docs/api-contract.md`, `data-model.md`, `AGENTS.md` y `runbook-estado-observado.md` actualizados.

## Evidencia de verificación (2026-10-25)

- `bun run build` sin errores; `bun run test`: 34 suites, 570 pruebas en verde (nuevas: `registrations.status.spec.ts`,
  `set-status.dto.spec.ts`, casos en `vouchers`, `integrations`, `groups` y `roles-matrix`).
- ESLint sin errores nuevos en los archivos tocados (`vouchers.controller.ts` conserva un error de formato previo).
- Migración aplicada en MariaDB 10.5.6 local (Docker, `localhost:3311`); la deriva previa de `User`/`Discipline` no cambió.
- Prueba de humo local (servidor en :3030 contra la base Docker, 34 comprobaciones): aprobar → volver a pendiente,
  observar con motivo, corrección del delegado fuera de plazo y con evento cerrado, reenvío, edición total del admin,
  reabrir y corregir comprobante, rechazo → restauración con cupo, Contrato 2 con observado como pendiente, dashboard,
  permisos del Tesorero y eliminación con y sin partidos.
