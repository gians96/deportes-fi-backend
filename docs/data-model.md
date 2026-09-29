# Modelo de datos — Backend (Prisma)

Provider: `mysql` (MariaDB externa). Fuente de verdad:
[`prisma/schema.prisma`](../prisma/schema.prisma).

## Enums

| Enum                 | Valores |
| -------------------- | ------- |
| `Role`               | `OWNER_SYSTEM`, `ADMIN_SYSTEM`, `REFEREE`, `STUDENT`, `OTHER` |
| `Gender`             | `M`, `F`, `O` |
| `DisciplineModality` | `TEAM`, `INDIVIDUAL` |
| `GenderPolicy`       | `MALE`, `FEMALE`, `MIXED`, `FREE` |
| `CompetitionFormat`  | `ELIMINATION`, `POINTS` |
| `ParticipantType`    | `STUDENT`, `OTHER` |
| `RegistrationStatus` | `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED` |
| `VoucherStatus`      | `PENDING`, `VALIDATED`, `REJECTED` |
| `MatchStatus`        | `PENDING`, `IN_PROGRESS`, `PLAYED`, `CANCELLED`, `POSTPONED` |

## Entidades y relaciones

```
Faculty 1───* ProfessionalSchool
Faculty 1───* SportEvent           ProfessionalSchool 1───* SportEvent (opcional)
Faculty 1───* User                 ProfessionalSchool 1───* User (opcional)

SportEvent 1───* Discipline
SportEvent 1───* EventApiToken      (tokens de integración; cascada al borrar)
Discipline 1───* Team
Discipline 1───* Match
Discipline 1───* Standing

User (delegate) 1───* Team
Team 1───* Participant
Team 1───1 Voucher
Team 1───1 Standing
Team *──* Match (home / away / winner)
User 0/1 ──* Participant (vínculo opcional al usuario real)
```

## Notas de diseño

- **User**: `email` único; `googleSub` único y opcional (pre-registro sin Google
  hasta el primer login). `isActive` controla el acceso (soft-delete). `STUDENT`
  usa `studentCode`, facultad y escuela; `REFEREE` accede solo a gestión de
  fixture/resultados; `OTHER` identifica a usuarios no
  estudiantiles con `dni` validado por Decolecta y sin
  facultad/escuela.
- **Discipline**: `cost` es `Decimal(10,2)`; `maxTeams = 0` significa sin límite;
  `registrationDeadline` cierra inscripciones. `participantType` (`STUDENT` por
  defecto) define la fuente de validación de integrantes: `STUDENT` valida
  contra el padrón SIVIRENO por código; `OTHER` valida por DNI contra RENIEC
  (Decolecta). En formato `POINTS`, `winPoints`, `drawPoints`, `lossPoints` y
  `allowDraw` configuran el cálculo de la tabla. `matchDurationMinutes` (default 30)
  y `courtsCount` (lozas disponibles, default 1) alimentan al programador de
  horarios (`POST /scheduling/round-one`).
- **Team**: nace `PENDING`; `rejectionReason` cuando se rechaza.
- **Participant**: guarda `fullName`/`studentCode`/`dni` (snapshot del padrón) y
  puede vincularse a un `User` real vía `userId`. El vínculo se crea
  automáticamente al inscribir un equipo y al loguear/completar perfil, casando
  por `studentCode` o `dni`. El delegado responsable de la inscripción vive en
  `Team.delegateId`; no necesita formar parte de la lista de jugadores.
- **Voucher**: 1:1 con `Team`; `imageUrl` apunta a `uploads/vouchers/...`.
- **Match** / **Standing**: soporte para brackets (eliminación) y tabla de
  posiciones (puntos). Endpoints de avance/resultados pendientes (ver roadmap).
  La implementacion actual genera round-robin para `POINTS`, eliminacion simple
  para `ELIMINATION`, recalcula `Standing` y avanza ganadores de llave.
- **EventApiToken**: token de integración de un sistema externo para **un solo**
  `SportEvent` (`eventId`, cascada al borrar el evento). Guarda `name`,
  `tokenPrefix` (único, primeros 12 caracteres visibles `dfi_xxxxxxxx`),
  `tokenHash` (único, HMAC-SHA256 hex con `API_TOKEN_PEPPER`; el token en claro
  nunca se persiste), `createdById` (sin FK, como `Voucher.validatedById`),
  `lastUsedAt`, `expiresAt` y `revokedAt` (revocar conserva el registro). Estado
  derivado: `REVOKED` si `revokedAt`, `EXPIRED` si `expiresAt <= ahora`, si no
  `ACTIVE`. Detalle en `specs/001-tokens-api-por-evento/data-model.md`.
- Borrados en cascada: `Discipline → Team → Participant/Voucher`, etc., vía
  `onDelete: Cascade`.

## Migraciones

```powershell
bunx prisma migrate dev --name <cambio>   # entorno de desarrollo
bunx prisma migrate deploy                # producción (CI/Dokploy)
bunx prisma db push                       # sincronizar sin migración (rápido)
bunx prisma generate                      # regenerar cliente
bun run prisma:seed                       # datos iniciales
```

> **Deriva conocida**: `User.isActive`, `Discipline.participantType`,
> `Discipline.matchDurationMinutes` y `Discipline.courtsCount` existen en
> `schema.prisma` (y en producción, aplicadas con `db push`) pero no en ninguna
> migración. Por eso `migrate dev` propondrá agregarlas. Cómo hacer el baseline
> sin tocar producción: [`runbook-tokens-evento.md`](./runbook-tokens-evento.md).
> La migración `20260929150000_event_api_tokens` solo crea `EventApiToken`.
