# Feature Specification: Pago por salón o ciclo con voucher compartido

**Feature Branch**: `feat/pago-por-grupo`

**Created**: 2026-10-13

**Status**: Implementada en el backend (2026-10-13); el frontend se especifica en `frontend/specs/`

**Input**: "Un voucher de pago por salón (S/100) o por ciclo completo (S/150) que cubre un equipo en
cada disciplina; cada equipo adicional en una misma disciplina paga aparte (S/20 por salón, S/30 por
disciplina en un ciclo completo)." Reglas del evento dadas por la organización el 2026-10-13.

## Contexto y términos

- **Grupo** (`ClassGroup`): la unidad que paga. Es un **salón** (ciclo + sección, `SECTION`) o un
  **ciclo completo** (`CYCLE`), siempre dentro de una escuela profesional y de un evento.
- **Un ciclo contiene sus secciones** (p. ej. el ciclo V reúne A1, A2, B1, B2…): "ciclo completo" es la
  suma de todas sus secciones, por eso es excluyente con inscribir secciones sueltas.
- La **sección es texto libre** (depende del curso y cambia de uno a otro); el sistema solo la
  normaliza. No se valida contra SIVIRENO.
- **Voucher BASE**: el pago general del grupo (100 / 150). **Voucher EXTRA**: el pago de un equipo
  adicional (20 / 30). **Voucher TEAM**: el voucher de un solo equipo del flujo actual por
  disciplina (eventos anteriores).
- **Cupo** (`slot`): 1 = equipo incluido en el pago base; 2 o más = equipo adicional.
- **Evento `PER_GROUP`**: evento que cobra por grupo. `PER_DISCIPLINE` es el comportamiento de hoy y
  sigue siendo el valor por defecto.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Inscribir mi salón o ciclo con un solo pago (Priority: P1)

Un delegado elige si inscribe un **salón** o un **ciclo completo**, indica escuela, ciclo y sección,
y adjunta **un** voucher por el pago base. El sistema crea el grupo y deja el voucher `PENDING`.

**Why this priority**: es el cambio central de la regla; sin grupo no hay pago compartido.

**Independent Test**: crear un grupo en un evento `PER_GROUP` y comprobar el monto del voucher, que
queda `PENDING` y que repetir la misma combinación responde con un error claro.

**Acceptance Scenarios**:

1. **Given** un evento `PER_GROUP` con tarifas 100/150/20/30, **When** el delegado crea un grupo
   `SECTION` (escuela "Ingeniería de Sistemas", ciclo "5", sección "a-1") con voucher, **Then** se
   guarda como ciclo `V`, sección `A1`, el voucher es `BASE` `PENDING` con monto 100.00 y el delegado
   queda como responsable.
2. **Given** el mismo evento, **When** crea un grupo `CYCLE` del ciclo V, **Then** el voucher `BASE`
   es de 150.00 (si no hay secciones activas del ciclo V; ver escenario 4).
3. **Given** ya existe el grupo "V A1" en esa escuela y evento, **When** otro delegado intenta crearlo
   (aunque escriba "v", "A-1" o "a 1"), **Then** responde 409 "Este salón ya está inscrito" sin crear
   un segundo pago.
4. **Given** el grupo `CYCLE` del ciclo V está activo, **When** se intenta crear el salón "V B2" (o a
   la inversa: hay salones activos del ciclo V y se intenta el ciclo completo), **Then** responde 400
   explicando que el ciclo ya participa completo (o que tiene secciones inscritas).
5. **Given** un evento `PER_DISCIPLINE`, **When** se llama a `POST /groups`, **Then** responde 400
   "Este evento no cobra por salón o ciclo".
6. **Given** un grupo cuyo voucher base fue rechazado y que no tiene equipos `PENDING`/`APPROVED`,
   **When** se evalúan las exclusiones ciclo/sección, **Then** no cuenta como "activo". Ese mismo
   salón no se vuelve a crear (409): se recupera reemplazando el voucher (US5).

---

### User Story 2 - Registrar los equipos del grupo sin volver a pagar (Priority: P1)

Desde el grupo, el delegado registra el equipo de cada disciplina (Gincana, Ajedrez, Futsal, Voley,
Basquet). El **primer equipo de cada disciplina** queda cubierto por el pago base y no pide voucher.
Los integrantes son estudiantes con **DNI y código**, con **un capitán/a**.

**Why this priority**: sin esto el pago compartido no sirve; es el flujo diario del evento.

**Independent Test**: con un grupo existente, crear cinco equipos (uno por disciplina) y comprobar que
todos comparten `voucherId`, tienen cupo 1 y que no se exigió otro voucher.

**Acceptance Scenarios**:

1. **Given** un grupo con voucher base, **When** el delegado registra el primer equipo de Futsal con
   9 integrantes (DNI y código) y un capitán, **Then** el equipo nace `PENDING`, cupo 1, enlazado al
   voucher base, con `cycle`/`section` copiados del grupo, y no se pidió voucher.
2. **Given** un integrante sin DNI o sin código, **When** se registra el equipo, **Then** responde 400
   con el integrante afectado.
3. **Given** cero o más de un capitán, **When** se registra el equipo, **Then** responde 400
   "Designa exactamente un capitán/a".
4. **Given** un alumno ya incluido en el equipo de Voley del mismo grupo, **When** se agrega al equipo
   de Futsal, **Then** se permite (un alumno puede jugar varias disciplinas); el duplicado se valida
   solo dentro del mismo equipo.
5. **Given** un `groupId` de otro evento, de otro delegado o inexistente, **When** se registra el
   equipo, **Then** responde 404 o 403 sin crear nada.
6. **Given** cualquier equipo de grupo, **When** se supera `maxTeams` de la disciplina o su
   `registrationDeadline`, **Then** responde 400 como hoy.

---

### User Story 3 - Equipo adicional en una misma disciplina con pago extra (Priority: P1)

Si el grupo ya tiene un equipo en una disciplina y quiere otro, el sistema lo trata como **adicional**
(cupo 2, 3…) y exige un **voucher EXTRA** por la tarifa adicional (20 para salón, 30 para ciclo).

**Why this priority**: es la segunda mitad de la regla del evento.

**Independent Test**: registrar un segundo equipo de Futsal en un grupo, comprobar que exige voucher,
que el monto es la tarifa adicional correcta y que el equipo no queda cubierto por el pago base.

**Acceptance Scenarios**:

1. **Given** un grupo `SECTION` con equipo de Futsal, **When** registra otro equipo de Futsal sin
   voucher, **Then** responde 400 "El equipo adicional requiere su comprobante de pago (S/ 20.00)".
2. **Given** lo mismo con voucher adjunto, **When** se registra, **Then** el equipo queda en cupo 2,
   con un voucher `EXTRA` `PENDING` de 20.00 enlazado al grupo.
3. **Given** un grupo `CYCLE`, **When** registra un equipo adicional en Basquet, **Then** el voucher
   `EXTRA` es de 30.00.
4. **Given** dos equipos de Futsal y uno de Voley, **When** se cuentan los cupos, **Then** Futsal usa
   los cupos 1 y 2 y Voley el cupo 1 (el cupo es por disciplina).
5. **Given** un equipo adicional ya registrado, **When** el delegado adjunta otro equipo adicional a
   ese mismo voucher `EXTRA` todavía `PENDING` (`extraVoucherId`), **Then** el monto esperado pasa a
   40.00 y ambos equipos quedan enlazados al voucher (opcional, P3 dentro de esta historia).
6. **Given** dos solicitudes simultáneas que quieren el cupo 2 de la misma disciplina, **When** se
   procesan, **Then** una gana el cupo 2 y la otra obtiene el cupo 3 o un 409 reintentable, nunca dos
   equipos con el mismo cupo.

---

### User Story 4 - Validar pagos y aprobar equipos desde el panel (Priority: P1)

Un administrador valida el voucher base **una sola vez** y, con eso, quedan aprobados los equipos del
grupo que cumplen las reglas. Los vouchers extra se validan aparte y aprueban solo sus equipos.

**Why this priority**: sin esto el flujo de pago no cierra y el congreso no ve recaudación.

**Independent Test**: validar el voucher base de un grupo con cinco equipos y comprobar que cuatro
válidos pasan a `APPROVED` y uno inválido se queda `PENDING` con motivo.

**Acceptance Scenarios**:

1. **Given** un voucher `BASE` `PENDING` con cinco equipos cupo 1, **When** el admin lo valida,
   **Then** el voucher queda `VALIDATED` y los equipos que cumplen las reglas pasan a `APPROVED`; la
   respuesta lista los equipos omitidos con su motivo.
2. **Given** un voucher `BASE` sin ningún equipo enlazado, **When** se intenta validar, **Then**
   responde 400 "El salón aún no registra equipos".
3. **Given** un grupo con base `VALIDATED`, **When** se registra un nuevo equipo cupo 1, **Then** nace
   `PENDING` y el admin lo aprueba con `PATCH /registrations/:id/approve`, que ahora comprueba el
   voucher que lo cubre (no `discipline.isPaid`).
4. **Given** un voucher rechazado (`BASE` o `EXTRA`), **When** el admin lo rechaza con motivo, **Then**
   los equipos que dependían de él y estaban `APPROVED` vuelven a `PENDING`.
5. **Given** un equipo `REJECTED` o `CANCELLED` en un evento `PER_GROUP`, **When** se intenta
   aprobar, **Then** responde 400 (se debe registrar de nuevo). Al rechazarlo o cancelarlo, su cupo
   queda libre.
6. **Given** un evento `PER_DISCIPLINE`, **When** se valida un voucher `TEAM`, **Then** todo se
   comporta exactamente como antes (regresión).

---

### User Story 5 - Reemplazar un voucher rechazado (Priority: P2)

El delegado ve el motivo del rechazo y **reemplaza** el comprobante (imagen y N° de operación) sin
recrear el grupo ni los equipos.

**Why this priority**: sin esto un rechazo del voucher base bloquearía los cinco equipos; hoy no
existe ninguna vía de re-subida.

**Independent Test**: rechazar un voucher, reemplazarlo y comprobar que vuelve a `PENDING` con el
mismo `id` y los mismos equipos enlazados.

**Acceptance Scenarios**:

1. **Given** un voucher `REJECTED` de un grupo del delegado, **When** adjunta nueva imagen y N° de
   operación, **Then** vuelve a `PENDING`, se limpia el motivo y conserva sus equipos enlazados.
2. **Given** un voucher `PENDING` o `VALIDATED`, **When** se intenta reemplazar, **Then** responde 400.
3. **Given** un usuario que no es el delegado del grupo ni staff, **When** intenta reemplazar,
   **Then** responde 403.
4. **Given** un voucher `TEAM` rechazado de un evento anterior, **When** su delegado lo reemplaza,
   **Then** también se permite (misma operación).

---

### User Story 6 - El congreso sigue viendo los números correctos (Priority: P1)

El Contrato 2 (`/integrations/event/*`) conserva **exactamente** sus formas JSON. "Recaudado" cuenta
cada voucher una sola vez aunque cubra varios equipos.

**Why this priority**: es un contrato con otro sistema en producción; no puede romperse ni inflarse.

**Independent Test**: con un evento que mezcla vouchers `TEAM` y un `BASE` compartido por cinco
equipos, comprobar totales, invariantes y la lista de pagos.

**Acceptance Scenarios**:

1. **Given** un `BASE` validado de 100.00 que cubre cinco equipos de cinco disciplinas, **When** se
   consulta `summary`, **Then** `payments.validated` suma 100.00 una sola vez (`count` 1) y
   `Σ byDiscipline.validatedAmount = 100.00` exacto (reparto en centavos).
2. **Given** `GET /integrations/event/payments`, **When** hay vouchers `BASE`/`EXTRA`, **Then** cada
   voucher aparece una vez con la **misma forma** de siempre: `teamName` = etiqueta del grupo
   (p. ej. "Ingeniería de Sistemas · V · A1"), `disciplineName` = "Pago base (salón)" / "Pago base
   (ciclo)" o, para `EXTRA`, "Adicional · <disciplina>", `participantType` = `STUDENT`.
3. **Given** un evento `PER_DISCIPLINE`, **When** se consulta cualquier endpoint, **Then** la
   respuesta es idéntica a la de la versión anterior.
4. **Given** cualquier respuesta, **When** se inspecciona, **Then** no hay campos nuevos ni datos
   personales (sin DNI, códigos, correos, teléfonos, nombres de integrantes ni URLs de vouchers).

---

### User Story 7 - Configurar el cobro del evento (Priority: P2)

Un administrador marca el evento como `PER_GROUP` y fija las cuatro tarifas (editables).

**Acceptance Scenarios**:

1. **Given** un administrador, **When** hace `PUT /events/:id/pricing` con modo y tarifas, **Then** se
   guardan y quedan visibles en `GET /events/:id/pricing`.
2. **Given** un evento con grupos ya creados, **When** cambia las tarifas, **Then** los vouchers
   existentes conservan su monto (instantánea) y solo los nuevos usan la tarifa nueva.
3. **Given** un evento con grupos, **When** se intenta volver a `PER_DISCIPLINE`, **Then** responde 400.
4. **Given** una tarifa negativa o con más de 2 decimales, **When** se guarda, **Then** responde 400.

## Edge Cases

- Ciclo escrito como "5", "V", "ciclo V", "v ciclo" → `V`; fuera de I–XII → 400 con mensaje en español.
- Sección "A-1", "a 1", "sección A1" → `A1`; vacía o con símbolos raros tras limpiar → 400.
- `A` y `A1` se tratan como secciones distintas (texto libre): el solapamiento jerárquico no se
  bloquea; lo revisa el administrador al validar.
- Equipo adicional enlazado a un voucher `EXTRA` que luego se rechaza: el equipo sigue existiendo y
  queda `PENDING` hasta que el delegado reemplace el voucher.
- Rechazar o cancelar el equipo del cupo 1 libera el cupo; un reemplazo vuelve a ser cupo 1 (no se
  cobra como adicional).
- Un voucher `BASE` validado nunca queda sin equipos: se exige al menos uno al validar y los equipos
  no se desenlazan (solo cambian de estado).
- Disciplinas `OTHER` dentro de un evento `PER_GROUP` siguen el flujo por disciplina (cobro por
  `isPaid`/`cost`).
- Cambios de tarifa no afectan vouchers existentes.
- Plazo: crear grupo y equipos exige que el evento esté abierto; cada equipo respeta el
  `registrationDeadline` de su disciplina. Reemplazar un voucher rechazado no depende del plazo.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `SportEvent.pricingMode` (`PER_DISCIPLINE` por defecto, `PER_GROUP`). Los eventos
  existentes y los nuevos sin configurar se comportan como hoy.
- **FR-002**: `EventPricing` por evento con `sectionBase`, `cycleBase`, `sectionExtra`, `cycleExtra`
  (soles, hasta 2 decimales, ≥ 0), editable por OWNER/ADMIN.
- **FR-003**: `ClassGroup` único por `(evento, escuela, scope, ciclo, sección)`; ciclo normalizado a
  número romano I–XII y sección a mayúsculas alfanuméricas sin espacios; en `CYCLE` la sección es
  cadena vacía.
- **FR-004**: Un ciclo no puede tener a la vez un grupo `CYCLE` activo y grupos `SECTION` activos en
  el mismo evento y escuela. "Activo" = su voucher base no está `REJECTED` **o** tiene al menos un
  equipo `PENDING`/`APPROVED` (el grupo no tiene estado propio).
- **FR-005**: `POST /groups` crea el grupo y su voucher `BASE` en una transacción; monto = tarifa base
  del evento según `scope`. La unicidad la garantiza la base de datos.
- **FR-006**: Cada grupo tiene como máximo un voucher `BASE`, garantizado por `ClassGroup.baseVoucherId`
  único.
- **FR-007**: En eventos `PER_GROUP`, los equipos de disciplinas `STUDENT` requieren `groupId`; el
  servidor toma ciclo y sección del grupo (los valores del cuerpo se ignoran) y guarda
  `section = "CICLO COMPLETO"` en equipos de grupos `CYCLE`.
- **FR-008**: Cupo = menor entero ≥ 1 libre entre los equipos activos (`PENDING`/`APPROVED`) del
  grupo en esa disciplina; `UNIQUE(groupId, disciplineId, slot)` impide duplicados. Equipos
  `REJECTED`/`CANCELLED` tienen `slot = NULL`.
- **FR-009**: Cupo 1 → `voucherId` = voucher base del grupo, sin pedir comprobante. Cupo ≥ 2 → exige
  comprobante `EXTRA` (nuevo, o `extraVoucherId` de un `EXTRA` `PENDING` del mismo grupo) con monto =
  tarifa adicional × equipos enlazados.
- **FR-010**: Nómina en `PER_GROUP`: exactamente un integrante con `isCaptain`, y DNI (8 dígitos) y
  código de estudiante en todos; sin duplicados dentro del equipo. Se permite el mismo alumno en
  equipos de distintas disciplinas.
- **FR-011**: Validar `BASE`/`EXTRA` aprueba en una transacción los equipos `PENDING` enlazados que
  pasan las reglas actuales; devuelve `approvedTeamIds` y `skipped[{ teamId, reason }]`. Validar un
  `BASE` sin equipos responde 400.
- **FR-012**: `approve` en `PER_GROUP` (disciplina `STUDENT`) exige que el voucher que cubre al equipo
  esté `VALIDATED` y rechaza equipos `REJECTED`/`CANCELLED`.
- **FR-013**: Rechazar `BASE`/`EXTRA` devuelve a `PENDING` los equipos `APPROVED` que dependían de él.
- **FR-014**: `PATCH /vouchers/:id/replace` (delegado del grupo/equipo o staff) sobre un voucher
  `REJECTED`: nueva imagen y N° de operación, estado `PENDING`, motivo limpio, mismo `id`.
- **FR-015**: Contrato 2 con las mismas formas JSON; "recaudado" cuenta vouchers distintos; el monto de
  un voucher compartido se reparte entre sus equipos en **centavos exactos** (sin perder centavos)
  para `byDiscipline` y `byParticipantType`.
- **FR-016**: `GET /groups/mine`, `GET /groups/:id` (delegado o staff) y `GET /groups` (staff, con
  filtros `eventId`, `schoolId`, `cycle`, `status`) devuelven el grupo con sus equipos por disciplina
  y el estado de cada voucher.
- **FR-017**: Migración aditiva: `Voucher.teamId` pasa a opcional, se agregan columnas nuevas y se
  rellena `Team.voucherId` desde `Voucher.teamId`. Durante el release de transición los vouchers
  `TEAM` también escriben `Voucher.teamId` (doble escritura) para poder revertir el código.
- **FR-018**: Todo error de negocio en español; DTOs con `class-validator`; lógica de dinero con
  `Prisma.Decimal`.

### Key Entities

- **EventPricing**: tarifas del evento (1:1).
- **ClassGroup**: salón o ciclo que paga; delegado responsable; apunta a su voucher base.
- **Voucher** (ampliado): `kind` (`TEAM`/`BASE`/`EXTRA`), `groupId`; cubre 1..N equipos.
- **Team** (ampliado): `groupId`, `voucherId`, `slot`.
- **Participant** (ampliado): `isCaptain`.

## Success Criteria *(mandatory)*

- **SC-001**: Un delegado inscribe su salón y registra los cinco equipos con **un** voucher en un solo
  recorrido.
- **SC-002**: En un evento que mezcla vouchers `TEAM` y `BASE`/`EXTRA`, `payments.validated.amount`
  coincide con la suma de vouchers distintos y `Σ byDiscipline.validatedAmount` coincide exactamente.
- **SC-003**: Las respuestas de un evento `PER_DISCIPLINE` son byte a byte equivalentes a las de la
  versión 001 (pruebas de regresión).
- **SC-004**: Dos delegados que crean el mismo salón al mismo tiempo producen exactamente un grupo y
  un voucher base.
- **SC-005**: Ningún flujo exige más de un comprobante para los equipos de cupo 1 de un grupo.

## Assumptions

- El pago general cubre las **cinco disciplinas** aunque el grupo juegue solo algunas (S/100 fijo).
- Las tarifas son por evento y se configuran en el sistema; no están fijas en el código.
- SIVIRENO (búsqueda pública) devuelve nombre y código pero normalmente **no el DNI**: el delegado lo
  digita; el servidor valida formato y no repetición. No se contrasta con RENIEC en esta versión.
- El género por integrante queda como hoy (la web envía `'O'`); fuera de alcance.
- Las cajas de agua y la exportación de nómina se manejan fuera del sistema (fuera de alcance).
- Fechas del evento (apertura 13/10/2026; cierre 25/10 23:59; fixtures 27/10): se asumen año 2026 y se
  confirman al configurar el evento. Se configuran en `registrationDeadline` de cada disciplina, no
  en esta feature.

## Preguntas abiertas

1. ¿Un mismo alumno puede estar en dos equipos **de la misma disciplina** del mismo grupo (cupo 1 y
   cupo 2)? Por defecto no se bloquea.
2. ¿La organización quiere que un `BASE` rechazado impida registrar nuevos equipos o solo que queden
   `PENDING`? Por defecto solo quedan `PENDING`.

## Fuera de alcance

Frontend (spec propia en `frontend/specs/`), nómina oficial como lista aparte del salón, contraste del
DNI con RENIEC, validación del ciclo/sección con SIVIRENO, género por integrante, reportes y
exportaciones, cambios en `backend-ciisic`.

## Evidencia de verificación (2026-10-13)

- `bun run build` sin errores; `bun run test`: 15 suites, 266 pruebas en verde (las 26 del Contrato 2
  anteriores pasan sin modificarse: regresión de `PER_DISCIPLINE`). ESLint sin errores nuevos en los
  archivos tocados.
- Migración aplicada sobre un esquema anterior con datos sembrados: sin errores, `Team.voucherId`
  rellenado, `prisma migrate diff` sin diferencias. Detalle y límites (MySQL 8.0.30, no MariaDB 11)
  en [`docs/runbook-pago-por-grupo.md`](../../docs/runbook-pago-por-grupo.md).
- Prueba de humo con HTTP real y concurrencia (mismo salón ×6, ciclo vs salones, 5 adicionales
  simultáneos): ver el runbook. Resultado: un único grupo, sin ciclo y salones a la vez, cupos
  distintos y sin vouchers huérfanos.
- Cumplimiento: SC-001 (3 disciplinas en la prueba de humo, 5 en las pruebas unitarias) y SC-002 a
  SC-005 verificados; las dos preguntas abiertas se resolvieron con los
  valores por defecto (no se bloquea al mismo alumno en cupos distintos de una disciplina; un
  voucher base rechazado no impide registrar equipos).
- Pendiente fuera de esta feature: contracción de `Voucher.teamId`, frontend, aviso al mantenedor
  del congreso y repetir la verificación de la migración en MariaDB 11.
