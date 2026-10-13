# API Contract — Backend

- **Base URL**: `http://localhost:3001/api/v1` (local) · `https://<host>/api/v1` (prod)
- **Formato**: JSON salvo `POST /registrations` que es `multipart/form-data`.
- **Auth**: header `Authorization: Bearer <jwt>`. El token se obtiene en
  `POST /auth/google` o, para cuentas con contraseña, en `POST /auth/login`.
- **Roles**: `OWNER_SYSTEM`, `ADMIN_SYSTEM`, `TREASURER`, `REFEREE`, `STUDENT`, `OTHER`.

Notación de la columna *Auth*:
- `público` — sin token.
- `auth` — cualquier usuario autenticado.
- `admin` — solo `OWNER_SYSTEM` o `ADMIN_SYSTEM`.
- `pagos` — `OWNER_SYSTEM`, `ADMIN_SYSTEM` o `TREASURER` (ve y valida pagos; ver spec 004).
- `fixture` — `OWNER_SYSTEM`, `ADMIN_SYSTEM` o `REFEREE`.
- `token de evento` — header `X-Api-Key: dfi_<token>` (servidor a servidor, sin
  JWT). Ver [Integración por evento](#integración-por-evento-contrato-2).

---

## Auth

### `POST /auth/google` — `público`
Inicia sesión con el `idToken` de Google Identity. Cualquier correo verificado
por Google puede autenticarse. Los correos configurados como owner/admin
conservan su rol; los correos numéricos `@undc.edu.pe` son `STUDENT`; los demás
correos son `OTHER`. En el login se **vinculan** los
`Participant` previos que coincidan por `studentCode` o `dni`.
```json
// request
{ "idToken": "<google-id-token>" }
// response 200
{
  "token": "<jwt>",
  "user": {
    "id": 1, "email": "ej@undc.edu.pe", "fullName": "...",
    "role": "STUDENT", "studentCode": "2020...", "dni": null,
    "facultyId": null, "schoolId": null, "avatarUrl": null
  }
}
```
Errores: `401` token inválido o correo Google no verificado.

### `POST /auth/login` — `público`
Inicia sesión con correo y contraseña. Solo para cuentas a las que un Owner/Administrador les
asignó contraseña («Contraseña o Google», spec 004); las demás entran únicamente con Google.
```json
{ "email": "alumno@example.com", "password": "********" }
```
Responde igual que `POST /auth/google` (`{ token, user }`). El JWT lleva `tv` (versión de credenciales):
cambiar o quitar la contraseña invalida las sesiones anteriores.

Errores: `401 "Credenciales incorrectas"` **siempre igual** (correo inexistente, cuenta sin contraseña,
inactiva o contraseña errónea). `429` tras 5 fallos por IP y correo en 15 minutos (o 20 por correo
desde cualquier IP); un acceso correcto reinicia el contador.

### Rate limit global

Toda la API está protegida por un límite global por IP configurable con
`APP_RATE_LIMIT_WINDOW_MS` y `APP_RATE_LIMIT_MAX_REQUESTS`. Si se excede,
responde `429 Too Many Requests` y cabeceras `X-RateLimit-*`.

### `GET /auth/me` — `auth`
Devuelve el perfil del usuario del token (incluye `studentCode` y `dni`).

### `PATCH /auth/me/profile` — `auth`
Completa el perfil según el rol.

Para `STUDENT`, exige facultad y escuela profesional:
```json
{ "facultyId": 1, "schoolId": 3 }
```

Para `OTHER`, exige solo DNI. No guarda facultad ni escuela; valida el DNI con los
[proveedores de DNI](#ajustes-proveedores-de-dni) configurados (Decolecta, API Perú…),
actualiza `fullName` y vincula participantes por `dni`:
```json
{ "dni": "12345678" }
```

---

## Academic

Los dos endpoints normalizan su salida al mismo objeto **`AcademicPerson`**:
```json
{ "fullName": "PEREZ JUAN", "studentCode": "2020..." | null, "dni": "12345678" | null }
```

### `GET /academic/student?buscador=<dni|codigo>` — `auth`
Consulta el padrón **SIVIRENO** (disciplinas de tipo `STUDENT`). **Solo responde
cuando hay exactamente un resultado** (privacidad). `404` si no hay coincidencia
única.

### `GET /academic/dni?numero=<8 dígitos>` — `auth`
Consulta el DNI en los **proveedores configurados** (Decolecta, API Perú; disciplinas de tipo
`OTHER`), por prioridad y con respaldo automático. Valida que `numero` tenga 8 dígitos. `404` si el
DNI no existe; `503` si no hay ningún proveedor activo con token; `502` si ninguno pudo responder.
Devuelve `AcademicPerson` con `studentCode: null`.

> Detalle de los servicios externos en
> [Integraciones externas](#integraciones-externas).

---

## Ajustes: tokens de consulta de DNI

Pool de tokens que validan el DNI (spec 005): varios por proveedor (Decolecta, API Perú), cada uno con
**prioridad**, cupo y renovación. Todo vive **en la base de datos** (no en variables de entorno) y un cambio
rige en la siguiente consulta, sin reiniciar. Solo `OWNER_SYSTEM`/`ADMIN_SYSTEM`. Ninguna respuesta incluye
el valor de un token; solo la consulta manual devuelve un nombre.

| Método | Ruta | Notas |
| ------ | ---- | ----- |
| GET    | `/settings/dni-tokens` | `{ encryptionKey, providers[], tokens[] }` ordenados por prioridad |
| POST   | `/settings/dni-tokens` | Agrega un token (ver ↓); responde la vista del token |
| PATCH  | `/settings/dni-tokens/:id` | Todos los campos opcionales; un `token` nuevo lo devuelve a `ACTIVE` |
| DELETE | `/settings/dni-tokens/:id` | 204; su historial se conserva sin el token |
| POST   | `/settings/dni-tokens/:id/reset` | Contador en 0 y `ACTIVE` |
| POST   | `/settings/dni-tokens/:id/test` | `{ "dni": "12345678" }` → `{ ok, result, message, token }`; gasta una consulta real, sin datos personales |
| GET    | `/settings/dni-tokens/usage?days=30` | Consultas por día (hora de Lima) y por token, por resultado |
| GET    | `/settings/dni-tokens/logs?page=1` | Bitácora de 20 en 20, la más reciente primero; DNI enmascarado (`76****07`) |
| POST   | `/settings/dni-tokens/lookup` | `{ "dni": "…" }` → `{ found, dni, fullName?, source: CACHE\|PROVIDER, provider? }` usando pool y caché |
| DELETE | `/settings/dni-tokens/cache` | Vacía la caché → `{ deleted }` |

```jsonc
// POST /settings/dni-tokens
{ "provider": "DECOLECTA", "name": "Decolecta cuenta congreso", "token": "…",
  "apiUrl": null,            // nulo o vacío = URL oficial
  "priority": 10,            // menor = primero; si se omite, al final de la lista
  "enabled": true,
  "queryLimit": 1000,        // cupo del plan; nulo = sin límite conocido
  "queriesUsed": 0,
  "renewalPeriod": "MONTHLY", // DAILY | MONTHLY | YEARLY | NONE
  "renewsAt": "2026-11-01T00:00:00.000Z" }

// Vista de un token (nunca trae el valor)
{ "id": 1, "provider": "DECOLECTA", "providerLabel": "Decolecta (RENIEC)", "name": "…",
  "tokenMask": "••••a1b2", "apiUrl": "https://api.decolecta.com/v1/reniec/dni", "customUrl": false,
  "priority": 10, "enabled": true, "state": "ACTIVE",       // ACTIVE | EXHAUSTED | INVALID
  "available": true, "queryLimit": 1000, "queriesUsed": 40, "queriesRemaining": 960, "usagePercent": 4,
  "renewalPeriod": "MONTHLY", "renewsAt": "…", "lastError": null, "lastUsedAt": "…", "exhaustedAt": null }
```

- **Cómo se consulta un DNI**: caché (30 días) → tokens `enabled` y `ACTIVE` con cupo, por `priority` y luego `id`.
  401/403 → `INVALID`; 429/402 → `EXHAUSTED`; 5xx, red o tiempo agotado → solo `lastError` (el token sigue
  disponible); 404 → ese proveedor no lo conoce y se prueba **un token del otro proveedor** antes de responder
  que no existe. Cada consulta real suma 1 al contador y, al alcanzar `queryLimit`, el token queda `EXHAUSTED`.
- **Renovación**: al vencer `renewsAt` el contador vuelve a 0 y el token a `ACTIVE` (un `INVALID` no se
  rehabilita solo); la siguiente fecha conserva el día del ciclo.
- `token`: se aceptan pegados con "Bearer "; se guardan **cifrados** (AES-256-GCM) y solo se muestran los
  últimos 4 caracteres. `encryptionKey`: `dedicated` (`INTEGRATION_SECRET_KEY`), `derived` (de `JWT_SECRET`) o
  `none` (503 al guardar).
- Errores: `400` (token corto, alias vacío, URL inválida, fecha inválida, DNI mal formado), `404` (token
  inexistente), `503` (sin clave de cifrado), `401`/`403` (sesión o rol).
- Reemplaza a `/settings/dni-providers` de la spec 003 (nunca desplegada).

---

## Faculties & Schools

| Método | Ruta                 | Auth  | Body |
| ------ | -------------------- | ----- | ---- |
| GET    | `/faculties`         | auth  | — (lista con `schools`) |
| POST   | `/faculties`         | admin | `{ name, acronym? }` |
| PATCH  | `/faculties/:id`     | admin | `{ name?, acronym? }` |
| DELETE | `/faculties/:id`     | admin | — |
| POST   | `/schools`           | admin | `{ name, facultyId }` |
| PATCH  | `/schools/:id`       | admin | `{ name? }` |
| DELETE | `/schools/:id`       | admin | — |

---

## Events

| Método | Ruta                        | Auth  | Notas |
| ------ | --------------------------- | ----- | ----- |
| GET    | `/events`                   | público | Incluye `facultyId`, `schoolId`, `_count.disciplines` |
| GET    | `/events/:id`               | público | |
| GET    | `/events/:id/disciplines`   | público | Disciplinas del evento |
| POST   | `/events`                   | admin | ver body ↓ |
| PATCH  | `/events/:id`               | admin | campos parciales |
| DELETE | `/events/:id`               | admin | |

```json
// POST /events
{
  "name": "Juegos FI 2026",
  "description": "…",
  "facultyId": 1,
  "schoolId": null,
  "startDate": "2026-07-01",
  "endDate": "2026-07-15",
  "isOpen": true
}
```

### Tokens de integración del evento

Credenciales para que un sistema externo (backend del congreso) lea los datos de
**un solo** evento. Solo se guarda el hash HMAC-SHA256 (con `API_TOKEN_PEPPER`);
el token en claro se devuelve **una única vez** al crearlo.

| Método | Ruta                                  | Auth  | Notas |
| ------ | ------------------------------------- | ----- | ----- |
| POST   | `/events/:eventId/api-tokens`         | admin | `{ name, expiresAt? }` → `201` con `token` (única vez), `Cache-Control: no-store` |
| GET    | `/events/:eventId/api-tokens`         | admin | Lista sin `token` ni hash, orden `createdAt` desc |
| DELETE | `/events/:eventId/api-tokens/:id`     | admin | Revoca (fija `revokedAt`, conserva el registro; idempotente) |

```json
// POST /events/3/api-tokens
{ "name": "Congreso CIISIC 2026", "expiresAt": "2026-12-31T23:59:59.000Z" }
// response 201
{ "id": 5, "name": "Congreso CIISIC 2026", "tokenPrefix": "dfi_Q2x9aB7c",
  "expiresAt": "2026-12-31T23:59:59.000Z", "createdAt": "2026-09-29T15:00:00.000Z",
  "token": "dfi_<43 caracteres base64url>" }

// GET /events/3/api-tokens y DELETE → EventApiTokenView (lista / objeto)
{ "id": 5, "eventId": 3, "name": "Congreso CIISIC 2026", "tokenPrefix": "dfi_Q2x9aB7c",
  "createdById": 1, "lastUsedAt": null, "expiresAt": null, "revokedAt": null,
  "createdAt": "2026-09-29T15:00:00.000Z", "status": "ACTIVE" }
```

- `name`: 1–100 caracteres (se recorta). `expiresAt`: ISO 8601 opcional y futura
  (`400 "La fecha de expiración debe ser futura"`).
- `status` ∈ `ACTIVE | REVOKED | EXPIRED` (calculado; `REVOKED` prevalece).
- Errores: `404 "Evento no encontrado"`, `404 "Token no encontrado"` (no existe o
  es de otro evento), `503` si falta `API_TOKEN_PEPPER` en producción.

### Tarifas del evento (pago por salón o ciclo)

| Método | Ruta                   | Auth  | Notas |
| ------ | ---------------------- | ----- | ----- |
| GET    | `/events/:id/pricing`  | auth  | Modo de cobro y tarifas. Un evento sin configurar responde `PER_DISCIPLINE` y tarifas en `0` |
| PUT    | `/events/:id/pricing`  | admin | Fija el modo y las cuatro tarifas (≥ 0, hasta 2 decimales) |

```json
{ "eventId": 3, "pricingMode": "PER_GROUP", "sectionBase": 100, "cycleBase": 150,
  "sectionExtra": 20, "cycleExtra": 30 }
```

- `PER_DISCIPLINE` (valor por defecto) es el cobro de siempre, por disciplina y por equipo.
  `PER_GROUP` cobra por salón o ciclo completo: ver [Grupos](#grupos-salón-o-ciclo).
- Volver a `PER_DISCIPLINE` con grupos ya creados responde `400`.
- Cambiar las tarifas no modifica los vouchers ya emitidos: guardan su monto.
- Errores: `404 "Evento no encontrado"`, `400` por tarifas negativas o con más de 2 decimales.

---

## Disciplines

| Método | Ruta                | Auth  | Notas |
| ------ | ------------------- | ----- | ----- |
| GET    | `/disciplines`      | público | Filtros opcionales `?eventId=&facultyId=&schoolId=`; cada disciplina incluye `teamsCount` |
| GET    | `/disciplines/:id`  | público | Incluye `event`, equipos aprobados y `teamsCount` |
| POST   | `/disciplines`      | admin | ver body ↓ |
| PATCH  | `/disciplines/:id`  | admin | campos parciales |
| DELETE | `/disciplines/:id`  | admin | |

```json
// POST /disciplines
{
  "eventId": 1,
  "name": "Fútbol 7 Varones",
  "modality": "TEAM",            // TEAM | INDIVIDUAL
  "genderPolicy": "MALE",        // MALE | FEMALE | MIXED | FREE
  "format": "ELIMINATION",       // ELIMINATION | POINTS
  "participantType": "STUDENT",  // STUDENT (padrón SIVIRENO) | OTHER (DNI/RENIEC)
  "minPlayers": 7,
  "maxPlayers": 12,
  "maxTeams": 16,                // 0 = sin límite
  "isPaid": true,
  "cost": 50.0,
  "rulesText": "…",
  "extraInfo": "…",
  "registrationDeadline": "2026-06-20T23:59:00.000Z",
  "winPoints": 3,
  "drawPoints": 1,
  "lossPoints": 0,
  "allowDraw": true
}
```
`participantType` define cómo se buscan los integrantes en el frontend:
`STUDENT` → `GET /academic/student`; `OTHER` → `GET /academic/dni`.
`teamsCount` devuelve la cantidad total de equipos inscritos en la disciplina
(sin filtrar por estado) para mostrar el avance de cupos en el panel admin.

---

## Registrations (equipos)

| Método | Ruta                         | Auth  | Notas |
| ------ | ---------------------------- | ----- | ----- |
| GET    | `/registrations?status=`     | pagos | `status` ∈ `PENDING\|APPROVED\|REJECTED\|CANCELLED`; filtros `?eventId=&facultyId=&schoolId=&disciplineId=&isPaid=&participantType=` |
| GET    | `/registrations/mine`        | auth  | Equipos donde el usuario es **delegado o integrante** (match por `userId`) |
| POST   | `/registrations`             | auth  | **multipart/form-data** ver ↓ |
| PATCH  | `/registrations/:id/approve` | admin | |
| PATCH  | `/registrations/:id/reject`  | admin | `{ "reason": "…" }` |

> El panel principal de administración es `/admin/inscripciones`. Allí se
> gestionan equipos gratuitos y de pago en un solo flujo. Para pagos, el modal
> muestra el voucher incrustado y usa `/vouchers/:id/validate` para validar y
> aprobar; el rechazo principal se realiza con `/registrations/:id/reject` para
> permitir una nueva inscripción. `/admin/vouchers` queda como vista secundaria
> de compatibilidad.

### `POST /registrations` (multipart/form-data)
| Campo            | Tipo   | Obligatorio | Notas |
| ---------------- | ------ | ----------- | ----- |
| `disciplineId`   | number | sí          | |
| `teamName`       | string | sí          | |
| `phone`          | string | no          | Teléfono de contacto del equipo/delegado; visible en admin |
| `operationNumber`| string | si pagada   | nº de operación del voucher |
| `delegateId`     | number | no          | **solo lo respeta si el actor es admin/owner** (equipo manual); en flujo público el delegado es el usuario autenticado |
| `participants`   | string | sí          | **JSON** del arreglo de jugadores (ver ↓); el delegado no va aquí salvo que también juegue y se agregue como integrante |
| `voucher`        | file   | si pagada   | imagen del comprobante |
| `groupId`        | number | si el evento es `PER_GROUP` | salón o ciclo que paga; ver [Grupos](#grupos-salón-o-ciclo) |
| `extraVoucherId` | number | no          | suma un equipo adicional a un comprobante EXTRA pendiente del mismo grupo |

```jsonc
// participants (JSON.stringify)
[
  { "fullName": "PEREZ JUAN", "studentCode": "2020...", "dni": "12345678",
    "gender": "M" },
  { "fullName": "...", "studentCode": "...", "dni": null, "gender": "F",
    "countsAsPlayer": true }
]
```
Reglas del servidor: plazo de inscripción vigente, mín/máx de jugadores,
política de género, **sin integrantes duplicados** (código/DNI), límite de
equipos y voucher obligatorio si `isPaid`. El equipo nace en estado `PENDING`.
Cada integrante se **vincula automáticamente** a su `User` (si existe) por
`studentCode` o `dni`, de modo que el estudiante vea ese equipo en
`/registrations/mine`.

### Equipos en eventos que cobran por salón o ciclo (`PER_GROUP`)

Aplica a las disciplinas de estudiantes de un evento `PER_GROUP`; las demás siguen el flujo
anterior. Cada integrante de `participants` acepta además `"isCaptain": true`.

- El servidor toma **ciclo y sección del grupo** (los del cuerpo se ignoran); en un ciclo
  completo guarda `section = "CICLO COMPLETO"`.
- **Cupo por disciplina** (`slot`): el primer equipo de cada disciplina es el cupo 1, cubierto
  por el pago base del grupo, y **no lleva voucher**; adjuntar uno responde `400`. Los
  siguientes son adicionales (cupo ≥ 2) y exigen un comprobante: `voucher` nuevo (crea un
  voucher `EXTRA` con la tarifa adicional) o `extraVoucherId` de un `EXTRA` pendiente del grupo
  (el monto pasa a tarifa × equipos activos). Sin ninguno: `400 "El equipo adicional requiere su
  comprobante de pago (S/ 20.00)"`.
- Nómina: exactamente un capitán/a; todos con código de estudiante y DNI de 8 dígitos; sin DNI
  repetidos dentro del equipo. Un mismo alumno puede estar en equipos de distintas disciplinas.
- Se respetan plazo y `maxTeams` de la disciplina. El evento debe estar abierto.
- Errores: `400 "…primero registra tu salón o ciclo"` (falta `groupId`), `404 "Salón o ciclo no
  encontrado"` (inexistente o de otro evento), `403` si el actor no es el delegado del grupo
  (el staff puede), `409` si dos solicitudes pelean el mismo cupo y se agotan los reintentos.
- La respuesta es el equipo con `participants` y `voucher`, más `groupId` y `slot`.
- `PATCH /registrations/:id/approve` exige que el voucher que cubre al equipo (base o extra)
  esté `VALIDATED` y no acepta equipos `REJECTED`/`CANCELLED` (se registran de nuevo).
  `PATCH /registrations/:id/reject` libera el cupo (`slot = null`).

---

## Grupos (salón o ciclo)

Unidad que paga en los eventos `PER_GROUP`: un **salón** (escuela + ciclo + sección) o un
**ciclo completo** (todas sus secciones). El ciclo se normaliza a romano (I–XII) y la sección,
de texto libre, a mayúsculas alfanuméricas sin espacios ("5" o "ciclo V" → `V`; "a-1" → `A1`).
Un grupo es único por evento + escuela + alcance + ciclo + sección.

| Método | Ruta                 | Auth  | Notas |
| ------ | -------------------- | ----- | ----- |
| POST   | `/groups`            | auth (estudiante o admin) | **multipart/form-data**; crea el grupo y su voucher base |
| GET    | `/groups/mine`       | auth  | Grupos del usuario (delegado); `?eventId=` |
| GET    | `/groups/:id`        | delegado o pagos | Detalle |
| GET    | `/groups`            | pagos | `?eventId=` (obligatorio) `&schoolId=&cycle=&status=` (estado del voucher base) |

`POST /groups`: `eventId`, `scope` (`SECTION`|`CYCLE`), `schoolId`, `cycle`, `section`
(obligatoria para un salón, ignorada para un ciclo), `operationNumber`, `delegateId` (solo admin) y
`voucher` (imagen, obligatoria). El voucher base (`kind: BASE`) queda `PENDING` con la tarifa base
del evento (`sectionBase` o `cycleBase`).

```jsonc
// GroupDetail
{ "id": 12, "eventId": 3, "scope": "SECTION", "label": "Ingeniería de Sistemas · V · A1",
  "school": { "id": 1, "name": "Ingeniería de Sistemas" }, "cycle": "V", "section": "A1",
  "delegate": { "id": 40, "fullName": "…" },
  "baseVoucher": { "id": 77, "kind": "BASE", "status": "PENDING", "amount": 100,
    "operationNumber": "123456", "imageUrl": "/uploads/vouchers/…", "rejectionReason": null },
  "disciplines": [ { "disciplineId": 7, "name": "Futsal", "teams": [
    { "id": 301, "name": "Los Bits", "slot": 1, "status": "PENDING", "voucherId": 77 } ] } ],
  "extraVouchers": [ { "id": 81, "kind": "EXTRA", "status": "PENDING", "amount": 20,
    "operationNumber": "124", "imageUrl": "…", "rejectionReason": null, "teamIds": [305] } ] }
```

Reglas y errores de `POST /groups`:
- Solo eventos `PER_GROUP`, abiertos, con tarifas y con alguna disciplina de estudiantes vigente;
  la escuela debe pertenecer a la facultad del evento.
- **409** `"Este salón ya está inscrito"` / `"Este ciclo ya está inscrito"` aunque se escriba
  distinto (la base de datos garantiza la unicidad).
- **400** si el ciclo ya participa completo o, al revés, ya tiene salones inscritos: un ciclo es
  completo **o** salones sueltos. Un grupo cuyo voucher base fue rechazado y sin equipos activos
  no bloquea; ese mismo salón se recupera reemplazando el comprobante.
- `400` por ciclo fuera de I–XII, sección vacía o de más de 10 caracteres, falta del comprobante;
  `403` si el rol no es estudiante ni admin; `404` evento, escuela o delegado inexistentes.

---

## Vouchers

| Método | Ruta                      | Auth  | Body |
| ------ | ------------------------- | ----- | ---- |
| GET    | `/vouchers?status=`       | pagos | `status` ∈ `PENDING\|VALIDATED\|REJECTED`; filtros `?eventId=&facultyId=&schoolId=&disciplineId=` |
| PATCH  | `/vouchers/:id/validate`  | pagos | — |
| PATCH  | `/vouchers/:id/reject`    | pagos | `{ "reason": "…" }` |
| PATCH  | `/vouchers/:id/replace`   | delegado del grupo/equipo o admin | **multipart**: `voucher` (imagen) y `operationNumber`; solo si está `REJECTED` |

Cada elemento de la lista incluye datos del equipo y de la disciplina para la
validación: `teamName`, `phone`, `operationNumber`, `amount`, `imageUrl`,
`status`, `disciplineName`, **`participantType`**, `genderPolicy`,
`minPlayers`/`maxPlayers`, `eventName`, `facultyName`, `schoolName`,
`participantsCount` y `participants[]` (cada uno con su `userId` si está
vinculado).

Un voucher tiene `kind`: `TEAM` (un solo equipo, flujo por disciplina), `BASE` (pago general de un
grupo) o `EXTRA` (equipo adicional); puede cubrir varios equipos. Los de grupo se listan con
`groupId`, `groupLabel` y `teams[]` (`id`, `name`, `disciplineName`, `slot`, `status`); los campos
históricos describen el primer equipo (vacíos si todavía no cubre ninguno).

- `validate` de un `BASE`/`EXTRA` valida el pago una sola vez y **aprueba en bloque** los equipos que
  cubre y cumplen las reglas. Responde el voucher más `approvedTeamIds: number[]` y
  `skipped: [{ "teamId", "reason" }]` (los que quedaron `PENDING` y por qué). Un `BASE` sin
  equipos responde `400 "El salón aún no registra equipos"`. Validar de nuevo aprueba los equipos
  que se sumaron después. Un voucher `TEAM` se valida como siempre.
- `reject` de un `BASE`/`EXTRA` devuelve a `PENDING` los equipos que había aprobado.
- `replace`: conserva el `id` y los equipos que cubre; vuelve a `PENDING` y limpia el motivo.
  `403` si no es el responsable, `400` si no está rechazado.

---

## Users

| Método | Ruta                  | Auth  | Notas |
| ------ | --------------------- | ----- | ----- |
| GET    | `/users`              | admin | Incluye `isActive`, `dni`, facultad/escuela, `hasPassword` y `googleLinked` (nunca el hash) |
| POST   | `/users`              | admin | Alta por correo, con contraseña opcional (ver ↓) |
| PATCH  | `/users/:id`          | admin | `{ fullName?, email?, dni?, facultyId?, schoolId? }` |
| PATCH  | `/users/:id/active`   | admin | `{ "isActive": false }` |
| PATCH  | `/users/:id/password` | admin | `{ "password": "…" }` (10–128 caracteres) o `{ "password": null }` para dejar la cuenta en «Solo Google»; invalida sus sesiones |
| PATCH  | `/users/:id/role`     | admin | `{ "role": "STUDENT" | "OTHER" | "REFEREE" | "TREASURER" }` (solo el Owner asigna `ADMIN_SYSTEM` y `OWNER_SYSTEM`) |

```json
// POST /users  (sin `password`: la cuenta entra solo con Google, que se vincula al primer login)
{ "email": "x@undc.edu.pe", "fullName": "…", "role": "OTHER",
  "dni": "12345678" }
// Con `password` la cuenta también entra con correo y contraseña (POST /auth/login)
{ "email": "alumno@example.com", "fullName": "…", "role": "STUDENT",
  "facultyId": 1, "schoolId": 3, "password": "…" }
```
Reglas: un `ADMIN_SYSTEM` puede gestionar/crear roles no administrativos
(`STUDENT`, `OTHER`, `REFEREE` y `TREASURER`); no se puede inhabilitar a un `OWNER_SYSTEM` ni a uno
mismo. Un usuario `OTHER`, `REFEREE` o `TREASURER` no requiere `facultyId` ni `schoolId`. Una cuenta con
contraseña conserva su rol al entrar también con Google (no se recalcula por el correo). Un usuario con
`isActive=false` no puede autenticarse (rechazado en `JwtStrategy`).

---

## Standings & Results

| Método | Ruta                          | Auth   | Notas |
| ------ | ----------------------------- | ------ | ----- |
| GET    | `/standings/:disciplineId`    | público| Tabla, fixture y partidos publicados |
| GET    | `/disciplines/:disciplineId/fixture` | fixture | Fixture admin con equipos aprobados, partidos y tabla |
| POST   | `/disciplines/:disciplineId/fixture/generate` | admin | `{ "resetPlayed": false }`; sorteo **aleatorio** de equipos aprobados (round-robin o eliminación simple). En eliminación **minimiza los byes**: empareja la mayor cantidad posible por ronda y solo deja un pase libre cuando la cantidad es impar (soporta cantidades impares / no potencias de 2). |
| POST   | `/disciplines/:disciplineId/fixture/arrange`  | admin | `{ "teamOrder": [3, 1, 2, ...] }`; reconstruye el fixture con el orden manual de equipos. Requiere exactamente los IDs aprobados (sin repetidos ni faltantes) y que **no** existan partidos jugados. |
| PATCH  | `/matches/:id`                | fixture | `{ "scheduledAt"?, "status"? }` |
| PATCH  | `/matches/:id/result`         | fixture | `{ "homeScore": 2, "awayScore": 1 }`; recalcula tabla o avanza llave |
| POST   | `/disciplines/:disciplineId/standings/recalculate` | admin | Recalcula tabla desde partidos jugados |
| GET    | `/results/mine`               | auth   | Historial del usuario |

---

## Programación de horarios

| Método | Ruta                  | Auth  | Notas |
| ------ | --------------------- | ----- | ----- |
| POST   | `/scheduling/round-one` | admin | Asigna `scheduledAt` a los partidos de **round 1** de las disciplinas indicadas |

```json
// POST /scheduling/round-one
{ "disciplineIds": [1, 3, 5], "startAt": "2026-06-15T14:00:00.000Z",
  "slotMinutes": 30, "dryRun": true }
```

Reglas del algoritmo (coloreo de grafos por franjas):
- Solo considera partidos con `round = 1` y **ambos equipos definidos**.
- Dos partidos están en conflicto si comparten al menos un jugador
  (`countsAsPlayer = true`), identificado por `studentCode` → `dni` → `userId` →
  nombre normalizado. Los partidos en conflicto nunca caen en la misma franja, de
  modo que **ningún estudiante juega dos partidos en simultáneo**.
- El tiempo se divide en franjas uniformes de `slotMinutes` (por defecto, la mayor
  `matchDurationMinutes` entre las disciplinas seleccionadas).
- Por franja, cada disciplina no supera su `courtsCount` (lozas independientes por
  disciplina). Los partidos se asignan por mayor grado de conflicto primero
  (Welsh–Powell), buscando la franja más temprana disponible.
- `dryRun: true` (default) solo devuelve la propuesta; `dryRun: false` persiste los
  `scheduledAt`. Respuesta: `{ applied, startAt, slotMinutes, slotsUsed,
  totalMatches, disciplines, matches: [{ matchId, disciplineId, disciplineName,
  homeTeam*, awayTeam*, slot, court, scheduledAt }] }`.

---

## Admin

| Método | Ruta                | Auth  | Notas |
| ------ | ------------------- | ----- | ----- |
| GET    | `/admin/dashboard`  | pagos | Métricas agregadas del panel |

---

## Integración por evento (Contrato 2)

Implementa el **Contrato 2** de `backend-ciisic/docs/arquitectura-ecosistema.md`.
Consumidor: backend del congreso (servidor a servidor). Respuestas en **JSON plano**
(sin envoltorio).

| Método | Ruta                                   | Auth            | Notas |
| ------ | -------------------------------------- | --------------- | ----- |
| GET    | `/integrations/event`                  | token de evento | Datos del evento |
| GET    | `/integrations/event/summary`          | token de evento | Resumen de equipos, participantes y pagos |
| GET    | `/integrations/event/payments`         | token de evento | `?status=VALIDATED\|PENDING\|REJECTED&page=1&pageSize=50` |
| GET    | `/integrations/event/registrations`    | token de evento | `?status=PENDING\|APPROVED\|REJECTED\|CANCELLED&page=1&pageSize=50` |

**Autenticación**: `X-Api-Key: dfi_<token>` (no usa `Authorization`). El evento
se toma **exclusivamente del token**; parámetros como `?eventId=` se ignoran.
Token ausente, mal formado, inexistente, revocado o expirado:

```json
{ "statusCode": 401, "message": "Token de integración inválido" }
```

Aplica el rate limit global por IP. Sin `API_TOKEN_PEPPER` en producción:
`503 { "statusCode": 503, "message": "Los tokens de integración no están configurados en el servidor" }`.

```json
// GET /integrations/event
{ "id": 3, "name": "Juegos Semana Sistémica 2026", "description": "<p>…</p>",
  "startDate": "2026-10-19T00:00:00.000Z", "endDate": "2026-10-24T00:00:00.000Z", "isOpen": true }

// GET /integrations/event/summary
{
  "event": { "id": 3, "name": "Juegos Semana Sistémica 2026", "startDate": "…", "endDate": "…" },
  "currency": "PEN",
  "teams": { "total": 40, "pending": 5, "approved": 32, "rejected": 2, "cancelled": 1 },
  "participants": { "total": 310 },
  "payments": {
    "validated": { "count": 30, "amount": 1500 },
    "pending": { "count": 4, "amount": 200 },
    "rejected": { "count": 1, "amount": 50 }
  },
  "byDiscipline": [
    { "disciplineId": 7, "name": "Fútbol 7 varones", "participantType": "STUDENT", "isPaid": true, "cost": 50,
      "teams": { "total": 12, "approved": 10, "pending": 2 }, "validatedAmount": 500, "pendingAmount": 100 }
  ],
  "byParticipantType": [
    { "participantType": "STUDENT", "teams": 35, "validatedAmount": 1300, "pendingAmount": 200 },
    { "participantType": "OTHER", "teams": 5, "validatedAmount": 200, "pendingAmount": 0 }
  ],
  "generatedAt": "2026-10-20T15:04:05.000Z"
}

// GET /integrations/event/payments
{ "data": [ { "id": 11, "amount": 50, "status": "VALIDATED", "operationNumber": "123456",
  "uploadedAt": "…", "updatedAt": "…", "teamName": "Los Bits",
  "disciplineName": "Fútbol 7 varones", "participantType": "STUDENT" } ],
  "meta": { "page": 1, "pageSize": 50, "total": 35 } }

// GET /integrations/event/registrations
{ "data": [ { "id": 21, "name": "Los Bits", "status": "APPROVED",
  "disciplineName": "Fútbol 7 varones", "participantType": "STUDENT",
  "participantsCount": 9, "createdAt": "…" } ],
  "meta": { "page": 1, "pageSize": 50, "total": 40 } }
```

Reglas:
- "Recaudado" (`validated`) = suma de `Voucher.amount` con `status = VALIDATED`.
  Los pagos se clasifican solo por el estado del voucher (un voucher `PENDING` de
  un equipo rechazado sigue contando como pendiente).
- **Pagos compartidos** (spec 002): cada voucher cuenta **una sola vez** aunque cubra varios equipos
  (`payments.<estado>.count` son vouchers distintos). Para `byDiscipline` y `byParticipantType` el
  monto se reparte entre los equipos que cubre en centavos exactos (el resto, de a un centavo, a
  los de menor `id`), por lo que `Σ byDiscipline.validatedAmount = payments.validated.amount`.
  Un pago base pendiente que aún no cubre equipos cuenta como pendiente en `payments` pero no en
  el desglose. Las formas JSON no cambian; en `payments` un voucher de grupo muestra en
  `teamName` la etiqueta del grupo y en `disciplineName` "Pago base (salón)", "Pago base (ciclo)"
  o "Adicional · <disciplina>".
- Montos en soles como número con hasta 2 decimales (se suman con `Decimal`).
- `teams.total`, `participants.total` y `byParticipantType[].teams` cuentan
  equipos/integrantes en cualquier estado. `byDiscipline` incluye todas las
  disciplinas del evento (orden por nombre) con `teams` = `total`/`approved`/`pending`;
  `byParticipantType` siempre trae `STUDENT` y `OTHER`.
- Orden: pagos por `uploadedAt` desc; inscripciones por `createdAt` desc (desempate
  por `id`). Página fuera de rango → `data: []` con el `total` real.
- `status` inválido, `page` < 1 o `pageSize` fuera de 1–100 → `400` con el formato
  estándar de validación de Nest.
- Ninguna respuesta incluye correos, DNI, códigos de estudiante, teléfonos,
  nombres de integrantes ni URLs de vouchers.

---

## Integraciones externas

El backend consume dos servicios externos para validar la identidad de los
integrantes. Las URLs y credenciales se configuran por variables de entorno
(ver `.env.example`); **nunca** se exponen al frontend.

### SIVIRENO — Padrón académico UNDC
- **Var. entorno**: `ACADEMIC_API_URL`
  (`https://sivireno.undc.edu.pe/tiger/consulta/con_searchEstudiante.php`).
- **Consumido por**: `GET /academic/student` y el enriquecimiento de perfil en
  `POST /auth/google`.
- **Uso**: validar integrantes de disciplinas `participantType = STUDENT` y
  precargar datos del estudiante al loguear.
- **Normalización**: la respuesta cruda (`estudiante`/`codEstu` y variantes) se
  mapea a `AcademicPerson { fullName, studentCode, dni }`. Solo se devuelve si
  hay **un único** resultado (privacidad).

### Decolecta y API Perú — consulta de DNI
- **Configuración**: en la base de datos, desde el panel (ver
  [Ajustes: tokens de consulta de DNI](#ajustes-tokens-de-consulta-de-dni)); no hay variables de entorno.
- **API Perú**: `POST https://api.apiperu.dev/dni` con `{ "dni": "…" }` y `Authorization: Bearer`;
  `404` = no existe, `401` = token inválido, `429` = cupo agotado, éxito = `{ success, data: { numero,
  nombre_completo } }`.
- **Decolecta**: `GET ?numero=<8 dígitos>` (URL por defecto `https://api.decolecta.com/v1/reniec/dni`) con
  `Authorization: Bearer <token>`; éxito = `{ first_name, first_last_name, second_last_name, full_name,
  document_number }`.
- **Consumido por**: `GET /academic/dni` (origen `ROSTER`) y `PATCH /auth/me/profile` para usuarios `OTHER`
  (origen `PROFILE`); ambos se mapean a `AcademicPerson { fullName, dni, studentCode: null }`.
- **Errores**: `503` si no hay ningún token configurado (o ninguno disponible); `404` si ningún proveedor
  conoce el DNI; `502` si todos los tokens disponibles fallaron (token rechazado, cupo agotado o servicio
  caído). Las repeticiones dentro de 30 días salen de la caché y no gastan cupo.

---

## Errores comunes

| Código | Significado |
| ------ | ----------- |
| 400    | Validación de DTO o regla de negocio (mensaje en `message`) |
| 401    | Token ausente/ inválido o usuario inhabilitado; en integraciones, `{ "statusCode": 401, "message": "Token de integración inválido" }` |
| 403    | Rol insuficiente para la operación |
| 429    | Rate limit global excedido |
| 404    | Recurso no encontrado |
| 503    | Servicio externo no disponible (p. ej. `DECOLECTA_TOKEN` ausente) o `API_TOKEN_PEPPER` ausente en producción (tokens de integración) |
