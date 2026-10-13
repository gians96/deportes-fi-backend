# Modelo de datos — Pago por salón o ciclo

Cambios **aditivos** sobre `prisma/schema.prisma`. Nada se elimina en este release (patrón
expandir → contraer).

## Enums nuevos

```prisma
enum PricingMode { PER_DISCIPLINE PER_GROUP }
enum GroupScope  { SECTION CYCLE }
enum VoucherKind { TEAM BASE EXTRA }
```

## Modelos nuevos

```prisma
model EventPricing {
  id           Int        @id @default(autoincrement())
  eventId      Int        @unique
  event        SportEvent @relation(fields: [eventId], references: [id], onDelete: Cascade)
  sectionBase  Decimal    @default(0) @db.Decimal(10, 2)
  cycleBase    Decimal    @default(0) @db.Decimal(10, 2)
  sectionExtra Decimal    @default(0) @db.Decimal(10, 2)
  cycleExtra   Decimal    @default(0) @db.Decimal(10, 2)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model ClassGroup {
  id            Int                @id @default(autoincrement())
  eventId       Int
  event         SportEvent         @relation(fields: [eventId], references: [id], onDelete: Cascade)
  schoolId      Int
  school        ProfessionalSchool @relation(fields: [schoolId], references: [id])
  scope         GroupScope
  cycle         String             // romano normalizado: "V"
  section       String             @default("") // "A1"; "" cuando scope = CYCLE
  delegateId    Int
  delegate      User               @relation("GroupDelegate", fields: [delegateId], references: [id])
  baseVoucherId Int?               @unique
  baseVoucher   Voucher?           @relation("GroupBaseVoucher", fields: [baseVoucherId], references: [id])

  teams    Team[]
  vouchers Voucher[] @relation("GroupVouchers")

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([eventId, schoolId, scope, cycle, section])
  @@index([eventId, schoolId, cycle])
}
```

`section = ""` (no `NULL`) para `CYCLE`: en MySQL un índice único admite varios `NULL`, así que un
`NULL` no impediría duplicar el ciclo completo.

## Modelos existentes (campos nuevos)

| Modelo | Campo | Tipo | Notas |
| --- | --- | --- | --- |
| `SportEvent` | `pricingMode` | `PricingMode` | `@default(PER_DISCIPLINE)` |
| `SportEvent` | `pricing`, `groups` | relaciones | `EventPricing?`, `ClassGroup[]` |
| `Voucher` | `kind` | `VoucherKind` | `@default(TEAM)` |
| `Voucher` | `groupId` | `Int?` | grupo de un `BASE`/`EXTRA` (`onDelete: SetNull`) |
| `Voucher` | `teamId` | `Int?` (antes `Int`) | sigue `@unique`; solo `kind = TEAM` (doble escritura de transición) |
| `Team` | `groupId` | `Int?` | `onDelete: SetNull` |
| `Team` | `voucherId` | `Int?` | voucher que cubre al equipo; `onDelete: SetNull`; `@@index([voucherId])` |
| `Team` | `slot` | `Int?` | `1` incluido, `≥2` adicional; `NULL` sin grupo o `REJECTED`/`CANCELLED` |
| `Participant` | `isCaptain` | `Boolean` | `@default(false)` |
| `ProfessionalSchool` | `groups` | relación | `ClassGroup[]` |
| `User` | `delegatedGroups` | relación | `ClassGroup[]` (`GroupDelegate`) |

Restricción en `Team`: `@@unique([groupId, disciplineId, slot])`. Las filas con `groupId` o `slot`
nulos no participan, así que los equipos de eventos anteriores no se ven afectados.

### Relaciones Team ↔ Voucher (dos, con nombre)

```prisma
// Voucher
teamId  Int?     @unique
team    Team?    @relation("LegacyVoucherTeam", fields: [teamId], references: [id], onDelete: Cascade)
teams   Team[]   @relation("TeamVoucher")      // los equipos que cubre

// Team
voucherId     Int?
voucher       Voucher? @relation("TeamVoucher", fields: [voucherId], references: [id], onDelete: SetNull)
legacyVoucher Voucher? @relation("LegacyVoucherTeam")
```

`team.voucher` sigue siendo singular: el panel y la pantalla de estado casi no cambian. Lo que sí
cambia es `voucher.team` (singular) → `voucher.teams` (lista) en el código que lo usaba
(`vouchers.service.ts`, `integrations.service.ts`).

## Invariantes

1. `Voucher.kind = BASE` ⇒ `ClassGroup.baseVoucherId` apunta a él (a lo sumo uno por grupo).
2. `Team.groupId` no nulo ⇒ `Team.voucherId` apunta a un `BASE` (cupo 1) o `EXTRA` (cupo ≥ 2) **del
   mismo grupo**.
3. `Voucher.kind = TEAM` ⇒ `Voucher.teamId` no nulo y `Team.voucherId` = ese voucher.
4. `Team.slot` no nulo ⇒ `Team.groupId` no nulo y estado `PENDING`/`APPROVED`.
5. Un `BASE` `VALIDATED` tiene al menos un equipo enlazado (se exige al validar; los equipos nunca se
   desenlazan).
6. `Team.status = APPROVED` en un equipo de grupo ⇒ su voucher está `VALIDATED`.

## Montos y reparto

- `Voucher.amount` es una **instantánea** de la tarifa al crearse: `BASE` = `sectionBase` o
  `cycleBase`; `EXTRA` = (`sectionExtra` o `cycleExtra`) × equipos enlazados mientras esté `PENDING`.
- Reparto para estadísticas (Contrato 2): el monto en centavos se divide entre los equipos enlazados
  con el método del resto mayor, ordenando por `Team.id`; la suma de las partes es exactamente el
  monto del voucher (función pura `allocateCents`).

## Migración (`prisma/migrations/<timestamp>_pago_por_grupo/migration.sql`)

Revisada a mano; solo cambios de este feature. Orden:

1. Crear enums y tablas `EventPricing`, `ClassGroup` con sus índices y FKs.
2. `ALTER TABLE Voucher`: `teamId` a `NULL`, agregar `kind` (default `'TEAM'`), `groupId` + FK.
3. `ALTER TABLE Team`: agregar `groupId`, `voucherId`, `slot`, índice y único.
4. `ALTER TABLE Participant`: agregar `isCaptain` (default 0).
5. `ALTER TABLE SportEvent`: agregar `pricingMode` (default `'PER_DISCIPLINE'`).
6. **Backfill**: `UPDATE Team t JOIN Voucher v ON v.teamId = t.id SET t.voucherId = v.id`.

Contraer (release posterior, otra migración): quitar `Voucher.teamId`, la relación
`LegacyVoucherTeam` y la doble escritura.

**Deriva conocida** (ver `docs/data-model.md`): `User.isActive`, `Discipline.participantType`,
`matchDurationMinutes` y `courtsCount` existen en producción sin migración. Esta migración no las
corrige; el runbook indica cómo hacer el baseline antes (no se ejecuta nada contra producción).

## Reversión

Antes del paso de contraer, el código anterior sigue funcionando: lee `Voucher.teamId` (se mantuvo
con doble escritura para `TEAM`) y no conoce las columnas nuevas. Los vouchers `BASE`/`EXTRA` no
existen en eventos que nunca se pasaron a `PER_GROUP`.
