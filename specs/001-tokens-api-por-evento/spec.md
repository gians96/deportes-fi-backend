# Feature Specification: Tokens API por evento

**Feature Branch**: `feat/tokens-evento`

**Created**: 2026-09-29

**Status**: Aprobada (lista para implementar)

**Input**: "Tokens de integración por evento para que el backend del congreso (CIISIC) consulte,
servidor a servidor, el evento deportivo, su resumen de inscripciones y pagos, y los listados
paginados de pagos e inscripciones, según el Contrato 2 de
`backend-ciisic/docs/arquitectura-ecosistema.md`."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Emitir un token de integración para un evento (Priority: P1)

Un administrador (OWNER o ADMIN) entra a un evento deportivo y genera un token de integración con
un nombre descriptivo (p. ej. "Congreso CIISIC 2026") y, opcionalmente, una fecha de expiración.
El sistema le muestra el token completo **una sola vez** para que lo configure en el sistema
consumidor; después solo se ve su prefijo.

**Why this priority**: sin token no hay integración; es la puerta de entrada de todo el feature.

**Independent Test**: crear un token para un evento y comprobar que la respuesta trae el valor
completo, que en la base solo queda un hash y que ningún listado vuelve a mostrar el valor.

**Acceptance Scenarios**:

1. **Given** un administrador autenticado y un evento existente, **When** crea un token con
   nombre "Congreso CIISIC 2026", **Then** recibe `id`, `name`, `tokenPrefix`, `expiresAt`,
   `createdAt` y `token` (formato `dfi_…`), y el token queda asociado solo a ese evento.
2. **Given** un token recién creado, **When** el administrador lista los tokens del evento,
   **Then** ve nombre, prefijo, fechas y estado, pero nunca el token completo ni su hash.
3. **Given** un evento inexistente, **When** se intenta crear un token, **Then** responde 404
   "Evento no encontrado".
4. **Given** una fecha de expiración en el pasado, **When** se intenta crear el token, **Then**
   responde 400 con un mensaje en español.
5. **Given** un usuario sin rol OWNER/ADMIN o sin sesión, **When** intenta crear o listar
   tokens, **Then** recibe 403 o 401 respectivamente.

---

### User Story 2 - El congreso consulta los datos de su evento (Priority: P1)

El backend del congreso llama, con el header `X-Api-Key`, a cuatro endpoints de solo lectura:
datos del evento, resumen (equipos, participantes, pagos por estado, desglose por disciplina y
por tipo de participante), pagos paginados e inscripciones paginadas. El evento consultado es
siempre el del token.

**Why this priority**: es el valor de negocio del feature (reportes de recaudación e
inscripciones en el panel del congreso).

**Independent Test**: con un token del evento A (insertado directamente o creado por la US1),
llamar a los cuatro endpoints y comparar los números con los datos cargados; ningún dato del
evento B aparece.

**Acceptance Scenarios**:

1. **Given** un token válido del evento A, **When** se llama `GET /integrations/event`,
   **Then** responde el evento A con `id`, `name`, `description`, `startDate`, `endDate`,
   `isOpen`.
2. **Given** el evento A con equipos en varios estados y vouchers VALIDATED/PENDING/REJECTED,
   **When** se llama `GET /integrations/event/summary`, **Then** los conteos por estado, el
   total de participantes, los montos por estado de pago y los desgloses coinciden con los
   datos, con montos en soles como número de hasta 2 decimales y `currency: "PEN"`.
3. **Given** un token del evento A, **When** se llama a cualquier endpoint agregando
   `?eventId=<B>` u otro parámetro, **Then** la respuesta sigue siendo solo del evento A.
4. **Given** `GET /integrations/event/payments?status=VALIDATED&page=1&pageSize=50`, **When**
   se consulta, **Then** devuelve `{ data, meta: { page, pageSize, total } }` solo con pagos
   validados del evento A, sin URLs de vouchers.
5. **Given** `GET /integrations/event/registrations?status=APPROVED`, **When** se consulta,
   **Then** devuelve equipos aprobados del evento A con `participantsCount`, sin correos, DNI
   ni códigos de estudiante.
6. **Given** un `status` fuera de los valores permitidos o `pageSize` mayor a 100, **When** se
   consulta, **Then** responde 400.

---

### User Story 3 - Revocar tokens y respetar la expiración (Priority: P2)

El administrador revoca un token (p. ej. si se filtró o terminó el convenio). Desde ese momento
el token deja de funcionar, pero el registro se conserva para auditoría. Un token con fecha de
expiración vencida también deja de funcionar.

**Why this priority**: control del ciclo de vida y respuesta ante filtraciones.

**Independent Test**: revocar un token en uso y comprobar que la siguiente llamada de
integración responde 401; poner una expiración pasada y comprobar lo mismo.

**Acceptance Scenarios**:

1. **Given** un token activo, **When** el administrador lo revoca, **Then** el token queda con
   fecha de revocación, aparece como "revocado" en el listado y las llamadas con él responden
   `401 { "statusCode": 401, "message": "Token de integración inválido" }`.
2. **Given** un token expirado, **When** se usa, **Then** responde el mismo 401.
3. **Given** un token de otro evento, **When** se intenta revocar usando el evento equivocado en
   la ruta, **Then** responde 404 y el token no cambia.
4. **Given** un token ya revocado, **When** se vuelve a revocar, **Then** la operación es
   idempotente (conserva la fecha de revocación original).

---

### User Story 4 - Desplegar de forma segura (Priority: P3)

El equipo aplica la migración en producción sin romper la base existente (que tiene deriva entre
migraciones y esquema) y configura el *pepper* de hash.

**Why this priority**: necesario para salir a producción, pero no bloquea el desarrollo.

**Independent Test**: seguir el runbook sobre una copia local de la base y verificar que solo se
crea la tabla nueva.

**Acceptance Scenarios**:

1. **Given** una base con las migraciones previas aplicadas, **When** se aplica la migración
   nueva, **Then** solo se crea la tabla de tokens con su clave foránea e índices.
2. **Given** producción sin `API_TOKEN_PEPPER`, **When** se intenta crear o usar un token,
   **Then** el servidor responde 503 y registra un error de configuración, sin caerse el resto
   de la API.

### Edge Cases

- Header `X-Api-Key` ausente, vacío, con otro prefijo o longitud incorrecta → 401 sin consultar
  la base.
- Token de un evento eliminado: se borra en cascada con el evento → 401.
- Voucher PENDING o VALIDATED de un equipo que luego fue rechazado/cancelado: los pagos se
  clasifican **solo por el estado del voucher** (regla del contrato), por lo que siguen contando
  como pendiente/validado. Se documenta como decisión abierta para el congreso.
- Disciplinas sin equipos aparecen en `byDiscipline` con ceros; ambos tipos de participante
  aparecen siempre en `byParticipantType`.
- Página fuera de rango → `data: []` con el `total` real.
- Montos decimales (p. ej. 12.50 + 0.10) se suman sin errores de coma flotante y se redondean a
  2 decimales.
- Uso intensivo de un token: `lastUsedAt` se actualiza sin bloquear la respuesta y como máximo
  una vez por minuto por token.
- Colisión de prefijo (improbable): se reintenta la generación.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: El sistema MUST permitir a usuarios OWNER_SYSTEM/ADMIN_SYSTEM crear tokens de
  integración asociados a exactamente un evento deportivo, con nombre (1–100 caracteres) y
  expiración opcional futura.
- **FR-002**: El token MUST tener el formato `dfi_` + 43 caracteres base64url (32 bytes
  aleatorios criptográficamente seguros) y MUST mostrarse en claro solo en la respuesta de
  creación.
- **FR-003**: El sistema MUST almacenar únicamente un hash HMAC-SHA256 del token con un pepper
  de entorno (`API_TOKEN_PEPPER`) y un prefijo visible no secreto para identificarlo.
- **FR-004**: En producción el pepper MUST ser obligatorio: sin él, la creación y validación de
  tokens responde 503 y se registra un error al iniciar. En desarrollo/pruebas se deriva de
  `JWT_SECRET` con una advertencia en el log.
- **FR-005**: El sistema MUST listar los tokens de un evento (nombre, prefijo, creado, último
  uso, expiración, revocación, estado ACTIVE/REVOKED/EXPIRED) sin exponer token ni hash.
- **FR-006**: El sistema MUST permitir revocar un token (marca la fecha de revocación y conserva
  el registro); responde 404 si el token no pertenece al evento de la ruta.
- **FR-007**: Los endpoints de integración MUST autenticarse solo con el header `X-Api-Key`,
  independientes del JWT de usuario, y MUST rechazar tokens ausentes, desconocidos, revocados o
  expirados con `401 { "statusCode": 401, "message": "Token de integración inválido" }`.
- **FR-008**: El evento consultado MUST tomarse exclusivamente del token; ningún parámetro de
  ruta o consulta puede cambiarlo.
- **FR-009**: `GET /integrations/event`, `/summary`, `/payments` y `/registrations` MUST
  devolver exactamente las formas JSON del Contrato 2, sin envoltorios adicionales.
- **FR-010**: "Recaudado" (`validated`) MUST ser la suma de `Voucher.amount` con estado
  VALIDATED; los montos se expresan en soles como número con hasta 2 decimales.
- **FR-011**: Los listados MUST paginar con `page` (por defecto 1) y `pageSize` (por defecto 50,
  máximo 100) y validar `status` contra los valores del contrato (400 si no).
- **FR-012**: Ninguna respuesta de integración MUST incluir correos, DNI, códigos de estudiante,
  teléfonos ni URLs de vouchers.
- **FR-013**: Cada uso válido MUST actualizar `lastUsedAt` del token sin bloquear la respuesta.
- **FR-014**: El rate limit global por IP MUST seguir aplicando a los endpoints de integración.
- **FR-015**: La migración MUST crear solo la tabla nueva (FK en cascada con el evento e
  índices) y MUST documentarse cómo aplicarla en producción dada la deriva existente.

### Key Entities

- **Token de integración de evento**: credencial de un sistema externo para un evento. Atributos:
  evento, nombre, prefijo visible, hash, creador (usuario, opcional), último uso, expiración,
  revocación, fechas de creación/actualización. Se elimina junto con su evento.
- **Evento deportivo** (existente): agrupa disciplinas; tiene cero o más tokens.
- **Disciplina → Equipo → Voucher** (existentes): fuente de los conteos y montos; un equipo
  pertenece a un evento a través de su disciplina; un voucher (pago) pertenece a un equipo.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Un administrador genera y copia un token en menos de 1 minuto sin asistencia
  técnica.
- **SC-002**: En el 100 % de las pruebas, un token del evento A nunca devuelve datos del evento
  B, aun manipulando parámetros de la solicitud.
- **SC-003**: Los montos y conteos del resumen coinciden al céntimo con los datos de prueba
  cargados (verificado en pruebas automáticas y en la prueba de humo).
- **SC-004**: Un token revocado o expirado deja de funcionar en la siguiente solicitud (0
  solicitudes aceptadas después de la revocación).
- **SC-005**: El valor en claro de un token no aparece en la base de datos, en los logs ni en
  ninguna respuesta posterior a su creación.

## Assumptions

- El consumidor es el backend del congreso (servidor a servidor); ningún token llega a un
  navegador.
- `participants.total` cuenta a todos los integrantes de los equipos del evento, en cualquier
  estado; `teams.total` y `byParticipantType[].teams` cuentan equipos en cualquier estado.
- `byDiscipline[].teams` expone solo `total`, `approved` y `pending`, como en el contrato.
- Los listados se ordenan del más reciente al más antiguo (pagos por `uploadedAt`, inscripciones
  por `createdAt`), con `id` como desempate.
- No hay límite de tokens activos por evento en esta versión.
- El rate limit global actual (por defecto 120 solicitudes/minuto por IP) es suficiente para el
  consumo del congreso.
