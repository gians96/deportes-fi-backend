# Contrato — Integración por token de evento (Contrato 2)

Implementa el **Contrato 2** de `backend-ciisic/docs/arquitectura-ecosistema.md`. Base:
`/api/v1`. Respuestas en JSON plano (sin envoltorio).

## Autenticación

- Header `X-Api-Key: dfi_<token>`; no requiere ni usa `Authorization`.
- El evento se toma **solo del token**. Parámetros como `?eventId=` se ignoran (el
  `ValidationPipe` con `whitelist` los descarta).
- Token ausente, mal formado, inexistente, revocado o expirado:

```json
{ "statusCode": 401, "message": "Token de integración inválido" }
```

- Producción sin `API_TOKEN_PEPPER`: `503 { "statusCode": 503, "message": "Los tokens de
  integración no están configurados en el servidor" }`.
- Aplica el rate limit global por IP (`429` + cabeceras `X-RateLimit-*`).

## `GET /integrations/event`

```json
{ "id": 3, "name": "Juegos Semana Sistémica 2026", "description": "<p>…</p>", "startDate": "2026-10-19T00:00:00.000Z", "endDate": "2026-10-24T00:00:00.000Z", "isOpen": true }
```

`description` es el HTML saneado del evento o `null`.

## `GET /integrations/event/summary`

```json
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
    {
      "disciplineId": 7, "name": "Fútbol 7 varones", "participantType": "STUDENT", "isPaid": true, "cost": 50,
      "teams": { "total": 12, "approved": 10, "pending": 2 },
      "validatedAmount": 500, "pendingAmount": 100
    }
  ],
  "byParticipantType": [
    { "participantType": "STUDENT", "teams": 35, "validatedAmount": 1300, "pendingAmount": 200 },
    { "participantType": "OTHER", "teams": 5, "validatedAmount": 200, "pendingAmount": 0 }
  ],
  "generatedAt": "2026-10-20T15:04:05.000Z"
}
```

Reglas de cálculo:

| Campo | Regla |
| --- | --- |
| `teams.*` | equipos de las disciplinas del evento, por `Team.status`; `total` = todos |
| `participants.total` | integrantes (`Participant`) de todos los equipos del evento |
| `payments.<estado>` | vouchers de equipos del evento por `Voucher.status` (`count` y suma de `amount`) |
| `byDiscipline[]` | todas las disciplinas del evento (incluso sin equipos), orden por nombre; `teams` solo `total`/`approved`/`pending` |
| `byParticipantType[]` | siempre `STUDENT` y `OTHER`, en ese orden; `teams` = total de equipos |
| montos | soles, `number` con hasta 2 decimales (`Decimal` → `Number(x.toFixed(2))`) |

Invariantes: `Σ byDiscipline.validatedAmount = payments.validated.amount`;
`Σ byParticipantType.teams = teams.total`.

## `GET /integrations/event/payments`

Query: `status` ∈ `VALIDATED | PENDING | REJECTED` (opcional), `page` ≥ 1 (defecto 1),
`pageSize` 1–100 (defecto 50). Orden: `uploadedAt` desc, `id` desc.

```json
{
  "data": [
    { "id": 11, "amount": 50, "status": "VALIDATED", "operationNumber": "123456", "uploadedAt": "…", "updatedAt": "…", "teamName": "Los Bits", "disciplineName": "Fútbol 7 varones", "participantType": "STUDENT" }
  ],
  "meta": { "page": 1, "pageSize": 50, "total": 35 }
}
```

`operationNumber` puede ser `null`. No incluye `imageUrl`.

## `GET /integrations/event/registrations`

Query: `status` ∈ `PENDING | APPROVED | REJECTED | CANCELLED` (opcional), `page`, `pageSize`
(igual que pagos). Orden: `createdAt` desc, `id` desc.

```json
{
  "data": [
    { "id": 21, "name": "Los Bits", "status": "APPROVED", "disciplineName": "Fútbol 7 varones", "participantType": "STUDENT", "participantsCount": 9, "createdAt": "…" }
  ],
  "meta": { "page": 1, "pageSize": 50, "total": 40 }
}
```

`participantsCount` = integrantes registrados del equipo.

## Errores de validación (listados)

`status` fuera de los valores permitidos, `page` < 1, `pageSize` fuera de 1–100 o no numéricos →
`400` con el formato estándar de Nest:
`{ "message": ["…"], "error": "Bad Request", "statusCode": 400 }`.

## Datos excluidos

Ninguna respuesta incluye correos, DNI, códigos de estudiante, teléfonos, nombres de integrantes
ni URLs de vouchers.
