# Modelo de datos — Backend (Prisma)

Provider: `mysql` (MariaDB externa). Fuente de verdad:
[`prisma/schema.prisma`](../prisma/schema.prisma).

## Enums

| Enum                 | Valores |
| -------------------- | ------- |
| `Role`               | `OWNER_SYSTEM`, `ADMIN_SYSTEM`, `TREASURER`, `REFEREE`, `STUDENT`, `OTHER` |
| `Gender`             | `M`, `F`, `O` |
| `DisciplineModality` | `TEAM`, `INDIVIDUAL` |
| `GenderPolicy`       | `MALE`, `FEMALE`, `MIXED`, `FREE` |
| `CompetitionFormat`  | `ELIMINATION`, `POINTS` |
| `ParticipantType`    | `STUDENT`, `OTHER` |
| `RegistrationStatus` | `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`, `DRAFT` (spec 006), `OBSERVED` (spec 007) |
| `VoucherStatus`      | `PENDING`, `VALIDATED`, `REJECTED` |
| `PricingMode`        | `PER_DISCIPLINE` (por defecto), `PER_GROUP` |
| `GroupScope`         | `SECTION`, `CYCLE` |
| `VoucherKind`        | `TEAM`, `BASE`, `EXTRA` |
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
Team *───1 Voucher            (un voucher puede cubrir varios equipos: Team.voucherId)
SportEvent 1───0/1 EventPricing   SportEvent 1───* ClassGroup
ClassGroup 1───* Team             ClassGroup 1───* Voucher (BASE/EXTRA)
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
- **Team**: nace `PENDING`; `rejectionReason` cuando se rechaza y `observation` cuando está `OBSERVED` (spec 007).
- **Participant**: guarda `fullName`/`studentCode`/`dni` (snapshot del padrón) y
  puede vincularse a un `User` real vía `userId`. El vínculo se crea
  automáticamente al inscribir un equipo y al loguear/completar perfil, casando
  por `studentCode` o `dni`. El delegado responsable de la inscripción vive en
  `Team.delegateId`; no necesita formar parte de la lista de jugadores.
- **Voucher**: puede cubrir varios equipos (`Team.voucherId`); `kind` = `TEAM` (un equipo, flujo
  por disciplina), `BASE` (pago general de un grupo) o `EXTRA` (equipo adicional). `imageUrl` apunta
  a `uploads/vouchers/...`. `teamId` (relación histórica 1:1) es opcional y solo lo usan los `TEAM`,
  con doble escritura mientras dure la transición; se eliminará en una migración posterior.
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

### Tesorero y acceso por contraseña (spec 004)

- `Role.TREASURER`: ve y valida pagos (comprobantes) y nada más; ver la matriz en `src/common/roles-matrix.spec.ts`.
- `User.passwordHash` (nulo = solo Google): scrypt `scrypt$N$r$p$sal$hash`, nunca sale por la API.
  `User.tokenVersion` sube al cambiar o quitar la contraseña; el JWT lleva `tv` y la sesión con otra versión
  se rechaza.
- Migración `20261014120000_tesorero_y_acceso_por_contrasena` (modifica el enum y agrega 2 columnas).

### Pool de tokens de DNI (spec 005, reemplaza a la spec 003)

- **DniToken**: un token de Decolecta o API Perú (puede haber varios por proveedor) con alias, `priority`
  (menor = primero), `enabled`, `state` (`ACTIVE`/`EXHAUSTED`/`INVALID`), cupo (`queryLimit`,
  `queriesUsed`), renovación (`renewalPeriod`, `renewsAt`), `apiUrl` (nula = URL oficial), `lastError`,
  `lastUsedAt`, `exhaustedAt` y el token **cifrado** (AES-256-GCM: `tokenCipher`, `tokenIv`, `tokenTag`) con
  `tokenLast4` para la máscara. La clave sale de `INTEGRATION_SECRET_KEY` o, si falta, de `JWT_SECRET`; nunca
  se guarda en la base. Índice `[enabled, state, priority]`.
- **DniLookupLog**: bitácora de cada consulta (`tokenId` con `SET NULL` al borrar el token, `dniMask`
  `76****07`, `result`, `httpStatus`, `durationMs`, `origin` `PROFILE|ROSTER|PANEL`, `detail`). Nunca guarda
  el nombre ni el token.
- **DniPersonCache**: DNI, nombre y proveedor de las personas ya consultadas; vigencia de 30 días
  (`DNI_CACHE_DAYS`).
- Migración `20261014130000_pool_tokens_dni`: crea las tres tablas, copia los tokens de `DniProviderConfig`
  (mismo cifrado) y elimina la tabla de la spec 003.

### Borradores y conexión con API_UNDC (spec 006)

- **Team.status = `DRAFT`**: equipo guardado y aún no enviado (solo en eventos por salón o ciclo). Conserva su
  `slot` y `voucherId`. Se excluye de aprobación, tesorería, Contrato 2, panel y clasificaciones. Migración
  `20261014140000_borrador_de_equipos`: agrega el valor al final del `ENUM` (aditiva; ningún equipo cambia).
- **UndcApiConfig** (una fila, `id = 1`): `baseUrl`, API key cifrada (`keyCipher`, `keyIv`, `keyTag`,
  `keyLast4`), `timeoutMs`, `enabled`, `lastStatus` (`OK`|`FAILED`), `lastError`, `lastCheckedAt`,
  `updatedById`. Migración `20261014150000_config_api_undc`.

### Edición manual y estado Observado (spec 007)

- **Team.status = `OBSERVED`**: equipo devuelto al delegado con una observación. A diferencia de `REJECTED`/`CANCELLED`
  conserva su `slot` y su `voucherId`. El delegado lo edita y lo reenvía (`PENDING`) sin plazo; el staff puede pasar un
  equipo a cualquier estado (`PATCH /registrations/:id/status`). No se aprueba en bloque al validar un comprobante.
  El Contrato 2 lo informa como `PENDING`.
- **Team.observation** (`TEXT` nulo, ≤ 500 caracteres validados en el DTO): texto de la observación; se limpia al cambiar
  de estado o al reenviar. Migración `20261024120000_estado_observado`: agrega el valor al final del `ENUM` y la columna
  (aditiva; ningún equipo cambia). Ver [`runbook-estado-observado.md`](./runbook-estado-observado.md).

### Pago por salón o ciclo (spec 002)

- **SportEvent.pricingMode**: `PER_DISCIPLINE` (por defecto, comportamiento histórico) o
  `PER_GROUP`. **EventPricing** (1:1 con el evento) guarda `sectionBase`, `cycleBase`,
  `sectionExtra` y `cycleExtra`; los vouchers guardan una instantánea del monto.
- **ClassGroup**: salón (`SECTION`) o ciclo completo (`CYCLE`) de una escuela en un evento.
  Único por `(eventId, schoolId, scope, cycle, section)`; `section = ''` en un ciclo (no `NULL`,
  porque un índice único de MySQL admite varios `NULL`). `baseVoucherId` es único: un solo pago
  base por grupo. La exclusión ciclo/salones se valida en transacción serializable.
- **Team**: `groupId`, `voucherId` (voucher que lo cubre) y `slot` (1 = incluido en el pago base,
  ≥ 2 = adicional; `NULL` sin grupo o si el equipo fue rechazado). `UNIQUE(groupId, disciplineId,
  slot)` impide dos equipos con el mismo cupo; las filas sin grupo no participan.
- **Participant.isCaptain**: capitán/a del equipo.
- Invariantes: un `BASE` validado cubre al menos un equipo; un equipo aprobado de un grupo tiene su
  voucher `VALIDATED`; `Team.voucherId` de un grupo apunta a un `BASE`/`EXTRA` de **su** grupo.
- Migración `20261013120000_pago_por_grupo` (solo agrega, rellena `Team.voucherId`) y runbook:
  [`runbook-pago-por-grupo.md`](./runbook-pago-por-grupo.md).

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
