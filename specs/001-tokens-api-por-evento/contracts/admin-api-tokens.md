# Contrato — Gestión de tokens por evento (admin)

Base: `/api/v1`. Auth: `Authorization: Bearer <jwt>` con rol `OWNER_SYSTEM` o `ADMIN_SYSTEM`
(`JwtAuthGuard` + `RolesGuard`). Sin sesión → 401; otro rol → 403
`"No tienes permisos para esta acción"`.

Objeto **`EventApiTokenView`** (nunca incluye `token` ni `tokenHash`):

```json
{
  "id": 5,
  "eventId": 3,
  "name": "Congreso CIISIC 2026",
  "tokenPrefix": "dfi_Q2x9aB7c",
  "createdById": 1,
  "lastUsedAt": "2026-10-20T15:04:05.000Z",
  "expiresAt": null,
  "revokedAt": null,
  "createdAt": "2026-09-29T15:00:00.000Z",
  "status": "ACTIVE"
}
```

`status` ∈ `ACTIVE | REVOKED | EXPIRED` (calculado por el servidor; `REVOKED` prevalece).

## `POST /events/:eventId/api-tokens`

Request:

```json
{ "name": "Congreso CIISIC 2026", "expiresAt": "2026-12-31T23:59:59.000Z" }
```

| Campo | Tipo | Reglas |
| --- | --- | --- |
| `name` | string | obligatorio, se recorta, 1–100 caracteres |
| `expiresAt` | string ISO 8601 | opcional; debe ser una fecha futura |

Response `201` — el campo `token` aparece **solo aquí**:

```json
{
  "id": 5,
  "name": "Congreso CIISIC 2026",
  "tokenPrefix": "dfi_Q2x9aB7c",
  "expiresAt": "2026-12-31T23:59:59.000Z",
  "createdAt": "2026-09-29T15:00:00.000Z",
  "token": "dfi_Q2x9aB7c…(47 caracteres en total)"
}
```

Errores: `400` validación (`name` vacío/largo, `expiresAt` inválida o
`"La fecha de expiración debe ser futura"`), `404 "Evento no encontrado"`,
`503 "Los tokens de integración no están configurados en el servidor"` (producción sin
`API_TOKEN_PEPPER`).

## `GET /events/:eventId/api-tokens`

Response `200`: `EventApiTokenView[]` ordenado por `createdAt` descendente (incluye revocados y
expirados). Errores: `404 "Evento no encontrado"`.

## `DELETE /events/:eventId/api-tokens/:id`

Revoca el token (fija `revokedAt`, conserva el registro). Idempotente: si ya estaba revocado,
mantiene la fecha original.

Response `200`: `EventApiTokenView` con `status: "REVOKED"`.
Errores: `404 "Token no encontrado"` si no existe o pertenece a otro evento.
