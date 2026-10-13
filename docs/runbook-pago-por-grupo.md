# Runbook — Pago por salón o ciclo (voucher compartido)

Cómo llevar a producción la migración `20261013120000_pago_por_grupo` (spec
`specs/002-pago-por-grupo/`). Complementa [`runbook-tokens-evento.md`](./runbook-tokens-evento.md),
cuyas secciones de preparación y de **deriva** aplican igual.

## Contexto

- La migración **solo agrega**: enums `PricingMode`, `GroupScope`, `VoucherKind`; tablas
  `EventPricing` y `ClassGroup`; columnas `SportEvent.pricingMode`, `Team.{groupId,voucherId,slot}`,
  `Voucher.{kind,groupId}`, `Participant.isCaptain`; y vuelve **opcional** `Voucher.teamId`
  (conserva su `UNIQUE`). Termina con un `UPDATE` que rellena `Team.voucherId` desde `Voucher.teamId`
  (idempotente).
- No elimina nada: el código anterior sigue funcionando después de migrar porque lee
  `Voucher.teamId`, que el código nuevo sigue escribiendo para los vouchers `TEAM`.
- Los eventos existentes quedan en `PER_DISCIPLINE` y se comportan igual. El cobro por salón o ciclo
  se activa evento por evento (`PUT /events/:id/pricing`).
- La imagen Docker **no** ejecuta migraciones. Nunca ejecutes estos comandos desde una máquina de
  desarrollo con un `.env` que apunte a producción.

## 0. Preparación (obligatorio)

1. Respaldo:
   `mysqldump --single-transaction --routines --triggers -h <host> -u <usuario> -p deportes_fi > deportes_fi_AAAAMMDD.sql`
2. Estado del historial: `SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at;`
   - Con las migraciones previas al día → **opción A**. Si no existe o está incompleta → **opción B**
     (ver el runbook de tokens: la base se mantiene con `db push`).
3. Si la deriva documentada (`User.isActive`, `Discipline.participantType`, …) sigue sin baseline,
   resuélvelo **antes y en un cambio aparte**, como indica el runbook de tokens.

## A. Historial de migraciones al día

```bash
npx prisma migrate status    # solo debe quedar pendiente 20261013120000_pago_por_grupo
npx prisma migrate deploy
```

## B. La base se mantiene con `db push`

```bash
# Previsualización (solo lectura): debe mostrar únicamente los cambios de esta lista
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script
# Aplicar el SQL revisado de prisma/migrations/20261013120000_pago_por_grupo/migration.sql
# (incluye el rellenado de Team.voucherId) y, si se adopta migrate deploy, registrarla:
npx prisma migrate resolve --applied 20261013120000_pago_por_grupo
```

NUNCA uses `--accept-data-loss`: si Prisma advierte pérdida de datos, aborta y revisa.

## Verificación posterior

```sql
SELECT COUNT(*) FROM Team t JOIN Voucher v ON v.teamId = t.id WHERE t.voucherId IS NULL OR t.voucherId <> v.id;  -- 0
SELECT kind, COUNT(*) FROM Voucher GROUP BY kind;                                                              -- todo TEAM
```

Y `npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code`
debe responder "No difference detected" (salvo la deriva previa conocida).

## Orden de despliegue

1. Respaldo y migración (arriba).
2. Backend nuevo. El Contrato 2 no cambia de forma; el congreso no necesita desplegar nada.
3. Frontend nuevo (otro repositorio).
4. Configurar el evento: `PUT /events/:id/pricing` con `PER_GROUP` y las tarifas; revisar el
   `registrationDeadline` de cada disciplina (el grupo no se puede crear después del último plazo).
5. Aviso al mantenedor del congreso: en `payments`, `teamName` y `disciplineName` de un pago de grupo
   describen el grupo (ver `specs/002-pago-por-grupo/contracts/integraciones-delta.md`).

## Rollback

- **Código**: volver a la imagen anterior es seguro mientras no se ejecute la migración de
  contracción; la columnas nuevas no estorban y `Voucher.teamId` sigue poblado para los `TEAM`.
  Los vouchers `BASE`/`EXTRA` y los grupos solo existen en eventos pasados a `PER_GROUP`; el código
  anterior no los conoce, por lo que no conviene revertir después de abrir inscripciones por grupo.
- **Datos**: revertir la migración implica borrar grupos, tarifas y vouchers de grupo; con eventos ya
  inscritos, restaurar el respaldo.

## Contracción (cambio posterior, no incluido aquí)

Cuando ningún despliegue dependa de la relación histórica: migración que elimina `Voucher.teamId`,
la relación `LegacyVoucherTeam` y la doble escritura en `RegistrationsService.create`.

## Evidencia de verificación (2026-10-13, entorno local)

Se probó contra un **MySQL 8.0.30 nativo temporal** (puerto 3399, directorio de datos propio, ya
eliminado). No se probó contra MariaDB 11 (Docker no estaba disponible); repetir los pasos de
verificación en una MariaDB 11 antes de producción.

- Se creó la base con el esquema **anterior** (`db push`), se sembraron equipos y vouchers de un
  evento por disciplina y se aplicó `migration.sql` tal cual: sin errores; `Team.voucherId` quedó
  rellenado y `kind = TEAM`; `prisma migrate diff` contra `schema.prisma` → **sin diferencias**.
- Prueba de humo con la API compilada (puerto 3030): tarifas, alta de salón (409 duplicado
  normalizado, exclusión ciclo/sección), tres equipos con un solo voucher, adicionales (cupos 2 y 3,
  voucher EXTRA de S/40), validación en bloque, rechazo y re-subida, permisos (403) y Contrato 2
  (suma por disciplina = recaudado, sin `imageUrl`). Un evento por disciplina siguió registrando,
  validando y sumando como antes.
- Concurrencia real: 6 solicitudes por el mismo salón → 1 grupo (5 × 409); ciclo completo contra
  salones → nunca conviven; 5 adicionales simultáneos → 5 cupos distintos sin vouchers huérfanos.
- Restricciones únicas de la base comprobadas con `INSERT` directos (cupo y grupo duplicados).
