# Data Model: Tokens API por evento

Estilo del repositorio: modelos PascalCase, campos camelCase, **sin `@@map`** (la tabla se llama
igual que el modelo), `DateTime` → `DATETIME(3)`, `String` → `VARCHAR(191)`.

## Entidad nueva: `EventApiToken`

```prisma
model EventApiToken {
  id          Int        @id @default(autoincrement())
  eventId     Int
  event       SportEvent @relation(fields: [eventId], references: [id], onDelete: Cascade)
  name        String
  tokenPrefix String     @unique
  tokenHash   String     @unique
  createdById Int?
  lastUsedAt  DateTime?
  expiresAt   DateTime?
  revokedAt   DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([eventId])
}
```

Relación inversa en `SportEvent`: `apiTokens EventApiToken[]`.

| Campo | Tipo | Reglas |
| --- | --- | --- |
| `id` | Int PK | autoincremental |
| `eventId` | Int FK → `SportEvent.id` | obligatorio; `ON DELETE CASCADE` (borrar el evento borra sus tokens) |
| `name` | String | 1–100 caracteres, recortado; descriptivo ("Congreso CIISIC 2026") |
| `tokenPrefix` | String único | primeros 12 caracteres del token (`dfi_` + 8); no secreto |
| `tokenHash` | String único | HMAC-SHA256 hex (64) del token con `API_TOKEN_PEPPER`; nunca se expone |
| `createdById` | Int? | id del usuario que lo creó (sin FK, igual que `Voucher.validatedById`) |
| `lastUsedAt` | DateTime? | último uso válido (precisión ~1 min) |
| `expiresAt` | DateTime? | `null` = no expira; si existe debe ser futura al crear |
| `revokedAt` | DateTime? | `null` = no revocado; se conserva el registro |
| `createdAt` / `updatedAt` | DateTime | automáticos |

### Estado derivado (no persistido)

| Estado | Condición (en orden) |
| --- | --- |
| `REVOKED` | `revokedAt != null` |
| `EXPIRED` | `expiresAt != null && expiresAt <= now` |
| `ACTIVE` | en otro caso |

Un token solo autentica en estado `ACTIVE`.

### Transiciones

```
(crear) ──► ACTIVE ──(revocar)──► REVOKED
              │
              └──(pasa expiresAt)──► EXPIRED ──(revocar)──► REVOKED
```

No hay reactivación: para volver a integrar se emite un token nuevo.

## Entidades existentes usadas (solo lectura)

```
SportEvent 1───* Discipline 1───* Team 1───1 Voucher
                                   Team 1───* Participant
SportEvent 1───* EventApiToken (nuevo)
```

- Alcance de evento: `Voucher → Team → Discipline.eventId` y `Team → Discipline.eventId`.
- `Voucher.amount` (`Decimal(10,2)`) = costo de la disciplina al inscribirse; `Voucher.status`
  ∈ `PENDING | VALIDATED | REJECTED`.
- `Team.status` ∈ `PENDING | APPROVED | REJECTED | CANCELLED`.
- `Discipline.participantType` ∈ `STUDENT | OTHER`, `isPaid`, `cost`.

## Migración

`prisma/migrations/20260929150000_event_api_tokens/migration.sql`: solo `CREATE TABLE
EventApiToken` (índices únicos de prefijo y hash, índice de `eventId`) y la FK
`EventApiToken_eventId_fkey` con `ON DELETE CASCADE ON UPDATE CASCADE`. Runbook en `plan.md` y
en `docs/runbook-tokens-evento.md`.
