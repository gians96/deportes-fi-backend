# Implementation Plan: Pago por salón o ciclo con voucher compartido

**Branch**: `feat/pago-por-grupo` | **Date**: 2026-10-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-pago-por-grupo/spec.md`

## Summary

Un voucher puede cubrir varios equipos. Se agregan `EventPricing` (tarifas por evento), `ClassGroup`
(salón o ciclo que paga), `Voucher.kind` (`TEAM`/`BASE`/`EXTRA`) y, en `Team`, `groupId`,
`voucherId` y `slot`. Un módulo nuevo `src/groups/` crea grupos y su voucher base; `registrations`
aprende a asignar cupo y a exigir voucher solo para equipos adicionales; `vouchers` valida y
rechaza en bloque; `integrations` cuenta vouchers distintos y reparte centavos sin cambiar las
formas del Contrato 2. Todo cuelga de la bandera `SportEvent.pricingMode`, así los eventos actuales
no cambian.

## Technical Context

**Language/Version**: TypeScript 5.7, Node 22 en runtime, Bun 1.2.

**Primary Dependencies**: NestJS 11, Prisma 6.19, class-validator/class-transformer, Multer. **Sin
dependencias nuevas.**

**Storage**: MariaDB 11. Tablas nuevas `EventPricing`, `ClassGroup`; columnas nuevas en `Voucher`,
`Team`, `Participant`, `SportEvent`.

**Testing**: Jest 30 + ts-jest con *fakes* de Prisma en memoria (patrón de
`src/integrations/integrations.service.spec.ts`); humo manual en :3030 contra MariaDB Docker :3311.

**Target Platform**: contenedor Linux (Dokploy). **Project Type**: web-service.

**Performance Goals**: `summary` de un evento con cientos de equipos < 300 ms (consultas en bloque,
reparto en memoria).

**Constraints**: formas exactas del Contrato 2; cero cambios para `PER_DISCIPLINE`; dinero con
`Prisma.Decimal`; unicidad y cupos garantizados por la base de datos; sin tocar producción.

**Scale/Scope**: decenas de grupos por escuela, cientos de equipos por evento.

## Constitution Check

| Principio | Verificación | Estado |
| --- | --- | --- |
| I. Contrato fuente de verdad | `contracts/pagos-por-grupo.md` y `integraciones-delta.md`; Contrato 2 sin campos nuevos; `docs/api-contract.md` se actualiza en el mismo cambio | ✅ |
| II. Seguridad por defecto | Endpoints con `JwtAuthGuard` y permisos finos en el service (`actor`); integraciones siguen sin PII; rate limit global intacto; vouchers con las mismas reglas de Multer | ✅ |
| III. Reglas en el servidor | Precio, cupo, exclusión ciclo/sección, capitán y DNI/código se validan en servidor, en transacción; errores en español | ✅ |
| IV. Prisma y migraciones | Migración aditiva revisada a mano + runbook; deriva existente documentada, no corregida; sin `db push` ni nada contra producción | ✅ |
| V. Pruebas | Jest sin BD para precios, normalización, `allocateCents`, cupos, exclusión, validación en bloque, agregación y aislamiento; humo local | ✅ |

Sin violaciones: no aplica *Complexity Tracking*.

## Decisiones de diseño

1. **Bandera por evento (`pricingMode`)** en lugar de reemplazar el flujo: riesgo cero para eventos
   en curso y para el congreso. Descartado: cambiar todo a grupos (rompe datos históricos).
2. **Voucher 1:N Team con `Team.voucherId`**: `team.voucher` sigue singular, por lo que admin y
   estado casi no cambian. Descartado: tabla puente (más joins sin beneficio) y duplicar el
   voucher por equipo (cuenta doble el dinero).
3. **Cupo `slot` + `UNIQUE(groupId, disciplineId, slot)`**: la base resuelve las carreras; el
   servicio reintenta una vez ante `P2002`. Cupo `NULL` al rechazar/cancelar para no cobrar como
   adicional un reemplazo.
4. **`ClassGroup.baseVoucherId` único** en lugar de un índice parcial (Prisma no los soporta).
5. **Sección vacía `""` para `CYCLE`** (no `NULL`) para que el único compuesto funcione en MySQL.
6. **Sección y ciclo en texto libre normalizado** (decisión del usuario): ciclo a romano I–XII,
   sección a alfanumérico en mayúsculas. No se consulta SIVIRENO.
7. **Doble escritura de `Voucher.teamId`** solo para `TEAM` durante un release: permite revertir el
   código sin perder datos; se contrae después.
8. **Reparto en centavos (`allocateCents`)**: mantiene exactas las sumas del Contrato 2 sin cambiar
   su forma.
9. **Validar un `BASE` exige ≥ 1 equipo**: garantiza `Σ byDiscipline.validatedAmount =
   payments.validated.amount`.
10. **Un `EXTRA` puede cubrir varios equipos** (`extraVoucherId`) como P3: el modelo ya lo permite;
    se implementa al final y es descartable sin rehacer nada.

## Project Structure

### Documentation (this feature)

```text
specs/002-pago-por-grupo/
├── spec.md
├── plan.md
├── data-model.md
├── quickstart.md
├── tasks.md
├── checklists/requirements.md
└── contracts/
    ├── pagos-por-grupo.md
    └── integraciones-delta.md
```

### Source Code

```text
prisma/
├── schema.prisma                          # enums, EventPricing, ClassGroup, columnas nuevas
└── migrations/<ts>_pago_por_grupo/migration.sql
src/
├── groups/                                # NUEVO
│   ├── groups.module.ts · groups.controller.ts · groups.service.ts
│   ├── group-normalize.ts                 # normalizeCycle, normalizeSection, groupLabel
│   ├── group-pricing.ts                   # tarifas por scope, allocateCents
│   └── dto/create-group.dto.ts
├── events/                                # + pricing (GET/PUT)
├── registrations/                         # groupId, cupo, capitán, voucher solo en extras
├── vouchers/                              # kind, validar/rechazar en bloque, replace
├── integrations/                          # vouchers distintos + reparto en centavos
├── admin/admin.service.ts                 # sin cambios funcionales (cuenta PENDING)
└── app.module.ts                          # registra GroupsModule
docs/  api-contract.md · data-model.md · runbook-pago-por-grupo.md
```

## Orden de implementación (fases del plan general)

1. **Esquema y migración** (US1–US7 dependen de esto).
2. **Núcleo puro** (`group-normalize`, `group-pricing`) con pruebas: no toca la base.
3. **Grupos y tarifas** (US1, US7).
4. **Registro con cupos** (US2, US3).
5. **Validación en bloque y re-subida** (US4, US5).
6. **Contrato 2** (US6) y regresión `PER_DISCIPLINE`.
7. **Documentación, runbook y humo local**.

## Riesgos y mitigaciones

| Riesgo | Mitigación |
| --- | --- |
| Romper el Contrato 2 en producción | Formas sin cambios, pruebas de regresión 001, invariantes verificadas |
| Doble conteo de dinero | Conteo por voucher distinto + prueba con voucher compartido |
| Carrera por cupos o por salón duplicado | Únicos en BD + reintento + prueba con *fake* que simula `P2002` |
| Deriva de migraciones en producción | Runbook con baseline previo; nada se ejecuta contra producción |
| Texto libre genera duplicados "A" vs "A1" | Normalización + revisión del admin; documentado como límite conocido |
| Revertir tras migrar | Doble escritura de `Voucher.teamId` durante el release de transición |
