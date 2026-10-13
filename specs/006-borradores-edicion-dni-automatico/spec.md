# Feature Specification: Borradores de equipo, edición, un salón por alumno y DNI automático

**Feature Branch**: `feat/borradores-edicion`

**Created**: 2026-10-14

**Status**: Implementada (2026-10-14)

**Input**: Tras probar el flujo de salón o ciclo: «ver el comprobante en la misma página», «un alumno no debería inscribir
varios salones», «en el registro de equipos poder volver y seguir editando hasta dar Enviar», «el panel de administrador
debe poder editar los inscritos, quitar o agregar a alguien», «el DNI debería salir solo desde la API (JP/SIVIRENO)».

**Depende de**: `002-pago-por-grupo` (salones/ciclos, vouchers `BASE`/`EXTRA`), `005-pool-tokens-dni` (cifrado de
secretos), `API_UNDC/specs/004-consulta-estudiante` (`POST /externo/estudiantes/consultar`).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Equipo en borrador hasta pulsar «Enviar» (Priority: P1)

El delegado guarda un equipo de su salón o ciclo como **borrador**, vuelve a editarlo (nombre, celular, jugadores,
capitán/a) las veces que quiera y lo **envía** cuando está completo. El borrador ocupa su cupo y no lo ve el tesorero ni
se aprueba.

**Acceptance Scenarios**:

1. **Given** un salón con pago general registrado, **When** el delegado guarda un equipo con `draft=true` y solo el
   nombre y un jugador, **Then** queda `DRAFT` con su cupo (1.º = incluido, 2.º en adelante = adicional con su comprobante).
2. **Given** un borrador, **When** el delegado lo edita (`PATCH /registrations/:id`), **Then** puede cambiar nombre,
   celular y la lista completa de jugadores y capitán; ya no puede hacerlo cuando deja de ser borrador.
3. **Given** un borrador incompleto, **When** pulsa «Enviar» (`POST /registrations/:id/submit`), **Then** se rechaza con el
   motivo (mín./máx. de jugadores, capitán, DNI y código de cada integrante); con la nómina completa pasa a `PENDING`.
4. **Given** un borrador, **When** el delegado lo quita (`DELETE`), **Then** se libera el cupo; si era el último equipo de
   un comprobante adicional pendiente, ese comprobante se elimina, y si comparte comprobante su monto se recalcula.
5. **Given** un borrador, **Then** no aparece al tesorero (`GET /registrations`, `GET /groups`), no se puede aprobar ni
   rechazar, no cuenta en el Contrato 2 ni en clasificaciones, y validar un comprobante no lo aprueba.
6. **Given** un equipo rechazado, **Then** sigue siendo definitivo (cupo liberado): el delegado registra uno nuevo.

### User Story 2 - El administrador edita los inscritos (Priority: P1)

Owner y Administrador editan un equipo en **cualquier estado** menos cancelado (nombre, celular, quitar o agregar jugadores,
cambiar capitán): se aplican las reglas completas y un equipo aprobado sigue aprobado si las cumple. El Tesorero no edita.

### User Story 3 - Un salón o ciclo por alumno y evento (Priority: P1)

Un estudiante solo puede ser delegado de **un** salón o ciclo activo por evento (los equipos adicionales siguen
permitidos pagando). Si su pago general fue rechazado y no quedan equipos vigentes, puede inscribir otro. Owner y
Administrador están exentos (inscriben salones a nombre de otros).

### User Story 4 - DNI automático desde API_UNDC (Priority: P2)

Al buscar un estudiante por código se consulta primero **API_UNDC** (URL y API key guardadas cifradas en la base, editables
desde Admin → Integraciones) y se devuelve nombre y DNI; si JP no está configurada, falla o no tiene el DNI, se usa la búsqueda
pública de SIVIRENO y el DNI se escribe a mano (comportamiento actual).

**Acceptance Scenarios**:

1. **Given** JP configurada y con DNI, **When** `GET /academic/student?buscador=<código>`, **Then** `dni` viene lleno.
2. **Given** JP caída, con la key rechazada o sin DNI, **Then** responde igual que hoy (`dni: null`) sin error para el usuario.
3. **Given** la configuración, **Then** la API key nunca se devuelve (solo sus últimos 4) y la URL se valida contra SSRF.

## Requirements *(mandatory)*

- **FR-001**: `RegistrationStatus` incluye `DRAFT`; solo existe para equipos de salón o ciclo (`PER_GROUP`).
- **FR-002**: Guardar como borrador exige nombre; valida plazo, capacidad, máximo de jugadores, duplicados y política de
  género; el resto (mínimo, capitán, DNI, código) se valida al enviar.
- **FR-003**: El delegado solo edita, envía o quita **sus** borradores, con el evento abierto y antes del cierre.
- **FR-004**: Owner/Admin editan cualquier equipo no cancelado; Tesorero y otros reciben 403.
- **FR-005**: Los borradores se excluyen del Contrato 2 (`/integrations/event/*`) sin agregar campos.
- **FR-006**: Un estudiante tiene como máximo un grupo activo por evento (409 con mensaje claro).
- **FR-007**: `UndcApiConfig` (una fila): URL base https, API key cifrada con `secret-box`, tiempo de espera, activa/inactiva,
  último estado; `GET/PUT /settings/undc-api` y `POST /settings/undc-api/test` solo para Owner y Administrador.
- **FR-008**: La consulta a JP respeta SSRF (https, sin credenciales en la URL, sin redirecciones, sin destinos internos en
  producción), expira por tiempo y nunca registra el DNI ni la key en logs.
- **FR-009**: `GroupDetail` expone `draftCount` y, para el tesorero, no lista los borradores.

## Success Criteria

- **SC-001**: Un delegado arma un equipo en dos sesiones distintas sin que el tesorero lo vea hasta enviarlo.
- **SC-002**: El administrador corrige la nómina de un equipo aprobado sin perder su aprobación.
- **SC-003**: Al buscar a un alumno por código el DNI aparece sin escribirlo cuando JP lo tiene.

## Evidencia de verificación

- **Jest**: 31 suites, 514 pruebas en verde (79 nuevas): borrador → editar → enviar, permisos de `PATCH`/`DELETE`/`submit` (delegado,
  otro delegado, tesorero, administrador), plazo y evento cerrado, borrado de un adicional (elimina o recalcula su comprobante),
  borradores fuera de tesorería, de aprobación y del Contrato 2 (la forma de la respuesta no cambia), un salón por estudiante
  (con reintento tras un rechazo y exención del staff), cliente de API_UNDC (éxito, 401/403/429/500, cuerpo inválido o enorme, red,
  tiempo, clave de cifrado cambiada, escritura solo al cambiar), guardia SSRF y respaldo a la búsqueda pública.
  `nest build` y `eslint` sin errores en los archivos tocados.
- **Base local** (MySQL 8.0.30 de Laragon, 3399): migraciones `20261014140000` y `20261014150000` aplicadas con `prisma db execute`;
  `migrate diff` sin diferencias.
- **API real** (3030) con API_UNDC local (3020, base `jp_local`) y SIVIRENO simulado: el estudiante recibe 409 al intentar un segundo
  salón; guarda un borrador incompleto (`DRAFT`, cupo 1); enviar incompleto → `"Falta el DNI (8 dígitos) de …"`; el tesorero ve
  `draftCount: 0`, no ve el equipo en `/groups` ni en `/registrations` (ni con `?status=DRAFT`) y recibe 403 al editar; el estudiante
  completa la nómina y envía (`PENDING`), después recibe 403 al editar; el administrador agrega un jugador y sigue `PENDING`, y el
  tesorero ya lo ve; un adicional exige comprobante (`S/ 20.00`), crea el comprobante `EXTRA` y al quitarlo se elimina; aprobar un
  borrador → 400. Conexión con API_UNDC desde el panel: `PUT` devuelve solo la máscara, `POST test` responde correctamente, tesorero
  y estudiante reciben 403 y la key no aparece en ninguna respuesta; `GET /academic/student?buscador=<código>` devuelve el nombre y el
  **DNI** sin escribirlo. Mis equipos de prueba (`E2E-6…`) se borraron al terminar.
- **Pendiente**: probar con la cookie y el API real de SIVIRENO (la carga el administrador en SIGENET → Integraciones), MariaDB 11
  (migraciones sin probar), y el recorrido de la pantalla (spec 006 del frontend).
