# Implementation Plan: Tokens API por evento

**Branch**: `feat/tokens-evento` | **Date**: 2026-09-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-tokens-api-por-evento/spec.md`

## Summary

Nuevo modelo `EventApiToken` (hash HMAC-SHA256 con pepper, prefijo visible, expiración y
revocación), módulo admin `src/event-tokens/` para emitir/listar/revocar tokens por evento, guard
`EventTokenGuard` (`X-Api-Key`) independiente del JWT y módulo `src/integrations/` con los cuatro
endpoints de solo lectura del Contrato 2, siempre acotados al evento del token. Migración que solo
crea la tabla nueva + runbook de producción que contempla la deriva existente. Decisiones en
[research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript 5.7 (target ES2023), Node 22 en runtime, Bun 1.2 para
instalar/compilar.

**Primary Dependencies**: NestJS 11 (`@nestjs/common`, `@nestjs/config`, `@nestjs/passport`),
Prisma 6.19 (`@prisma/client`), class-validator/class-transformer, `node:crypto`. Sin
dependencias nuevas.

**Storage**: MariaDB 11 (provider `mysql`). Tabla nueva `EventApiToken`.

**Testing**: Jest 30 + ts-jest (`src/**/*.spec.ts`), `@nestjs/testing` + supertest con un
*fake* de Prisma en memoria (sin base real). Prueba de humo manual contra MariaDB local
(`localhost:3311`) con el servidor en el puerto 3030.

**Target Platform**: contenedor Linux (Node 22 alpine) desplegado en Dokploy.

**Project Type**: web-service (API REST).

**Performance Goals**: resumen de un evento con cientos de equipos en < 300 ms; dos consultas
por resumen, dos por listado (datos + conteo).

**Constraints**: formas JSON exactas del Contrato 2; ningún dato personal en integraciones; el
evento solo del token; token en claro una sola vez.

**Scale/Scope**: decenas de disciplinas y cientos de equipos por evento; pocos tokens por
evento.

## Constitution Check

*GATE: verificado antes de diseñar y de nuevo tras el diseño.*

| Principio | Verificación | Estado |
| --- | --- | --- |
| I. Contrato fuente de verdad | Formas del Contrato 2 replicadas en `contracts/integraciones.md`; `docs/api-contract.md` se actualiza en el mismo cambio | ✅ |
| II. Seguridad por defecto | Hash HMAC + pepper, token en claro una vez, guard propio, 401 exacto, sin PII, rate limit global intacto, admin con `JwtAuthGuard`+`RolesGuard` | ✅ |
| III. Reglas en el servidor | DTOs con `class-validator` (nombre, expiración futura, `status`, paginación) y mensajes en español | ✅ |
| IV. Prisma y migraciones | Migración revisada a mano solo con la tabla nueva; deriva documentada, no corregida | ✅ |
| V. Pruebas | Unitarias de token/hash, guard, servicio admin, agregación y aislamiento entre eventos; humo local | ✅ |

Sin violaciones: no aplica *Complexity Tracking*.

## Project Structure

### Documentation (this feature)

```text
specs/001-tokens-api-por-evento/
├── spec.md
├── plan.md              # este archivo (incluye runbook resumido)
├── research.md
├── data-model.md
├── quickstart.md        # prueba de humo local
├── contracts/
│   ├── admin-api-tokens.md
│   └── integraciones.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
prisma/
├── schema.prisma                                   # + EventApiToken, SportEvent.apiTokens
└── migrations/20260929150000_event_api_tokens/migration.sql

src/
├── app.module.ts                                   # registra EventTokensModule e IntegrationsModule
├── common/
│   ├── decorators/current-event-token.decorator.ts # @CurrentEventToken() + EventTokenContext
│   └── guards/
│       ├── event-token.guard.ts                    # X-Api-Key → { tokenId, eventId }
│       └── event-token.guard.spec.ts
├── event-tokens/
│   ├── api-token.util.ts                           # generar / hashear / validar formato / pepper
│   ├── api-token.util.spec.ts
│   ├── api-token-hasher.service.ts                 # pepper desde ConfigService (503 si falta)
│   ├── dto/create-event-api-token.dto.ts
│   ├── event-tokens.controller.ts                  # /events/:eventId/api-tokens
│   ├── event-tokens.service.ts
│   ├── event-tokens.service.spec.ts
│   └── event-tokens.module.ts                      # exporta ApiTokenHasher
└── integrations/
    ├── dto/integration-list-query.dto.ts           # status + page/pageSize
    ├── integrations.controller.ts                  # /integrations/event/*
    ├── integrations.service.ts                     # consultas acotadas + agregación
    ├── integrations.module.ts
    ├── integrations.service.spec.ts                # agregación + aislamiento (fake en memoria)
    └── integrations.http.spec.ts                   # HTTP extremo a extremo con supertest

test/fakes/in-memory-prisma.ts                      # fake de Prisma compartido (fuera del build)

docs/
├── api-contract.md                                 # secciones admin + integración
├── data-model.md, deployment.md, README.md         # entidad, variable y enlace al runbook
└── runbook-tokens-evento.md                        # runbook de migración/pepper
```

**Structure Decision**: se sigue el patrón por módulo del repositorio (`controller`/`service`/
`module`/`dto`). El guard y el decorador van en `src/common/` porque son transversales; la
criptografía vive en `event-tokens` y se exporta al módulo de integraciones.

## Variables de entorno

| Variable | Uso |
| --- | --- |
| `API_TOKEN_PEPPER` | **Nueva.** Pepper del HMAC. Obligatoria en producción (sin ella: 503 en tokens + error en log). En desarrollo se deriva de `JWT_SECRET` con advertencia. Cambiarla invalida todos los tokens. |

## Runbook de migración en producción (resumen)

Detalle completo en `docs/runbook-tokens-evento.md`.

**Contexto**: la base de producción tiene columnas creadas con `prisma db push` que no están en
ninguna migración (deriva): `User.isActive`, `Discipline.participantType`,
`Discipline.matchDurationMinutes` y `Discipline.courtsCount`. La imagen Docker no ejecuta
migraciones. La migración nueva `20260929150000_event_api_tokens` solo crea `EventApiToken`.

1. **Respaldo** (`mysqldump --single-transaction`) y diagnóstico de solo lectura:
   `SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY
   started_at;`. Ejecutar todo desde el contenedor del backend en Dokploy (tiene
   `DATABASE_URL`), nunca desde una máquina de desarrollo.
2. **Opción A** — `_prisma_migrations` existe con las 6 migraciones previas aplicadas:
   `npx prisma migrate deploy` (aplica solo la nueva; la deriva no la bloquea).
3. **Opción B** — se sigue usando `db push`: previsualizar con
   `npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel
   prisma/schema.prisma --script` (debe mostrar solo el `CREATE TABLE EventApiToken` y su FK) y
   luego `npx prisma db push --skip-generate` **sin** `--accept-data-loss`. Si más adelante se
   pasa a `migrate deploy`: `npx prisma migrate resolve --applied
   20260929150000_event_api_tokens`.
4. **Baseline de la deriva** (cambio aparte, recomendado): generar en local una migración con
   `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel
   prisma/schema.prisma --shadow-database-url <shadow local> --script`, versionarla y marcarla en
   producción con `npx prisma migrate resolve --applied <nombre>` **antes** de cualquier
   `migrate deploy` que la incluya. Si producción no tiene `_prisma_migrations`, marcar primero
   cada migración existente con `migrate resolve --applied`.
5. Configurar `API_TOKEN_PEPPER` en Dokploy, desplegar la nueva versión y hacer la prueba de
   humo (crear token de prueba, `GET /integrations/event`, revocar).
6. **Rollback**: `DROP TABLE EventApiToken;` (sin dependencias) y, en la opción A, borrar la
   fila de `_prisma_migrations` de esa migración; volver a la versión anterior de la imagen.

## Complexity Tracking

No aplica.
