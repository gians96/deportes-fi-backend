# API Contract — Backend

- **Base URL**: `http://localhost:3001/api/v1` (local) · `https://<host>/api/v1` (prod)
- **Formato**: JSON salvo `POST /registrations` que es `multipart/form-data`.
- **Auth**: header `Authorization: Bearer <jwt>`. El token se obtiene en
  `POST /auth/google`.
- **Roles**: `OWNER_SYSTEM`, `ADMIN_SYSTEM`, `REFEREE`, `STUDENT`, `OTHER`.

Notación de la columna *Auth*:
- `público` — sin token.
- `auth` — cualquier usuario autenticado.
- `admin` — solo `OWNER_SYSTEM` o `ADMIN_SYSTEM`.
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

Para `OTHER`, exige solo DNI. No guarda facultad ni escuela; valida el DNI con
Decolecta, actualiza `fullName` y vincula participantes por `dni`:
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
Consulta **RENIEC vía Decolecta** (disciplinas de tipo `OTHER`). Valida que
`numero` tenga 8 dígitos. `404` si el DNI no existe; `503` si falta el token de
Decolecta. Devuelve `AcademicPerson` con `studentCode: null`.

> Detalle de los servicios externos en
> [Integraciones externas](#integraciones-externas).

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
| GET    | `/registrations?status=`     | admin | `status` ∈ `PENDING\|APPROVED\|REJECTED\|CANCELLED`; filtros `?eventId=&facultyId=&schoolId=&disciplineId=&isPaid=&participantType=` |
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

---

## Vouchers

| Método | Ruta                      | Auth  | Body |
| ------ | ------------------------- | ----- | ---- |
| GET    | `/vouchers?status=`       | admin | `status` ∈ `PENDING\|VALIDATED\|REJECTED`; filtros `?eventId=&facultyId=&schoolId=&disciplineId=` |
| PATCH  | `/vouchers/:id/validate`  | admin | — |
| PATCH  | `/vouchers/:id/reject`    | admin | `{ "reason": "…" }` |

Cada elemento de la lista incluye datos del equipo y de la disciplina para la
validación: `teamName`, `phone`, `operationNumber`, `amount`, `imageUrl`,
`status`, `disciplineName`, **`participantType`**, `genderPolicy`,
`minPlayers`/`maxPlayers`, `eventName`, `facultyName`, `schoolName`,
`participantsCount` y `participants[]` (cada uno con su `userId` si está
vinculado).

---

## Users

| Método | Ruta                  | Auth  | Notas |
| ------ | --------------------- | ----- | ----- |
| GET    | `/users`              | admin | Incluye `isActive`, `dni`, facultad/escuela |
| POST   | `/users`              | admin | Pre-registro por correo (ver ↓) |
| PATCH  | `/users/:id`          | admin | `{ fullName?, email?, dni?, facultyId?, schoolId? }` |
| PATCH  | `/users/:id/active`   | admin | `{ "isActive": false }` |
| PATCH  | `/users/:id/role`     | admin | `{ "role": "STUDENT" }`, `{ "role": "OTHER" }` o `{ "role": "REFEREE" }` |

```json
// POST /users  (pre-registro: se vincula al primer login con Google)
{ "email": "x@undc.edu.pe", "fullName": "…", "role": "OTHER",
  "dni": "12345678" }
```
Reglas: un `ADMIN_SYSTEM` puede gestionar/crear roles no administrativos
(`STUDENT`, `OTHER` y `REFEREE`); no se puede inhabilitar a un `OWNER_SYSTEM` ni a uno
mismo. Un usuario `OTHER` o `REFEREE` no requiere `facultyId` ni `schoolId`. Un usuario con
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
| GET    | `/admin/dashboard`  | admin | Métricas agregadas del panel |

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

### Decolecta — RENIEC (consulta de DNI)
- **Var. entorno**: `DECOLECTA_API_URL`
  (`https://api.decolecta.com/v1/reniec/dni`) y `DECOLECTA_TOKEN`.
- **Método**: `GET ?numero=<8 dígitos>` con header
  `Authorization: Bearer <DECOLECTA_TOKEN>`.
- **Consumido por**: `GET /academic/dni` y `PATCH /auth/me/profile` para
  usuarios `OTHER`.
- **Uso**: validar integrantes de disciplinas `participantType = OTHER` y
  completar el perfil de usuarios no estudiantiles.
- **Respuesta cruda**: `{ first_name, first_last_name, second_last_name,
  full_name, document_number }` → se mapea a `AcademicPerson { fullName:
  full_name, dni: document_number, studentCode: null }`.
- **Errores**: `503` si `DECOLECTA_TOKEN` no está configurado; `404` si el DNI
  no existe.

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
