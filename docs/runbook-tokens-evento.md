# Runbook — Tokens de integración por evento

Cómo llevar a producción la migración `20260929150000_event_api_tokens` y el pepper
`API_TOKEN_PEPPER` (spec `specs/001-tokens-api-por-evento/`). Los pasos A, B y el baseline se
validaron en una MariaDB 11 local (Docker) que reproducía la deriva de producción.

## Contexto

- La migración **solo** crea la tabla `EventApiToken` (índices únicos de `tokenPrefix` y
  `tokenHash`, índice de `eventId`) y la FK `EventApiToken_eventId_fkey` →
  `SportEvent(id)` con `ON DELETE CASCADE`. No modifica tablas existentes.
- **Deriva existente** (no la introduce este cambio): la base de producción tiene columnas
  creadas con `prisma db push` que no están en ninguna migración:
  `User.isActive`, `Discipline.participantType`, `Discipline.matchDurationMinutes` y
  `Discipline.courtsCount`.
- La imagen Docker **no** ejecuta migraciones. La CLI de Prisma sí está dentro de la imagen
  (`node_modules`), así que los comandos se ejecutan con `npx prisma …` desde la consola del
  contenedor del backend en Dokploy, que ya tiene `DATABASE_URL`.
- Nunca ejecutes estos comandos desde una máquina de desarrollo con un `.env` que apunte a
  producción.

## 0. Preparación (obligatorio)

1. Respaldo:
   `mysqldump --single-transaction --routines --triggers -h <host> -u <usuario> -p deportes_fi > deportes_fi_AAAAMMDD.sql`
2. Diagnóstico de solo lectura del historial de migraciones:

   ```sql
   SELECT migration_name, finished_at, rolled_back_at
   FROM _prisma_migrations ORDER BY started_at;
   ```

   - Si la tabla existe y lista las 6 migraciones previas con `finished_at` → **opción A**.
   - Si no existe o está incompleta → **opción B**.
3. Genera el pepper y guárdalo en el gestor de secretos:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

## Opción A — historial de migraciones al día

```bash
npx prisma migrate status     # debe listar solo 20260929150000_event_api_tokens como pendiente
npx prisma migrate deploy     # aplica solo esa migración; la deriva no la bloquea
```

Verifica con `SHOW CREATE TABLE EventApiToken;`.

## Opción B — la base se mantiene con `db push`

```bash
# Previsualización (solo lectura): debe mostrar únicamente CREATE TABLE EventApiToken y su FK
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script

# Aplicar. NUNCA con --accept-data-loss: si Prisma advierte pérdida de datos, abortar y revisar.
npx prisma db push --skip-generate
```

Si más adelante se adopta `migrate deploy`, primero hay que registrar el historial sin
ejecutarlo (la base ya tiene esos cambios):

```bash
npx prisma migrate resolve --applied 20260602180302_init
# … una vez por cada migración existente, incluida:
npx prisma migrate resolve --applied 20260929150000_event_api_tokens
```

## Baseline de la deriva (recomendado, en un cambio aparte)

1. En desarrollo, con una BD *shadow* local vacía, generar la migración que captura la deriva:

   ```bash
   bunx prisma migrate diff --from-migrations prisma/migrations \
     --to-schema-datamodel prisma/schema.prisma \
     --shadow-database-url "mysql://root:<pass>@localhost:3311/deportes_fi_shadow" --script
   ```

   Hoy produce exactamente: `ALTER TABLE Discipline ADD COLUMN courtsCount …,
   matchDurationMinutes …, participantType …` y `ALTER TABLE User ADD COLUMN isActive …`.
   Guardarla como `prisma/migrations/<timestamp>_baseline_drift/migration.sql` y versionarla.
2. En producción (ya tiene esas columnas), **antes** de cualquier `migrate deploy` que la
   incluya:

   ```bash
   npx prisma migrate resolve --applied <timestamp>_baseline_drift
   ```

   Si se ejecuta `deploy` antes del `resolve`, fallará por columnas duplicadas y habrá que
   marcarla con `migrate resolve --rolled-back` y luego `--applied`.
3. Resultado esperado: `npx prisma migrate status` → "Database schema is up to date!" y
   `migrate diff --from-migrations … --to-schema-datamodel …` vacío.

## Configuración y despliegue

1. Definir `API_TOKEN_PEPPER` en Dokploy (≥ 32 caracteres aleatorios). **No cambiarlo** después:
   invalida todos los tokens emitidos.
2. Desplegar la nueva versión del backend **después** de crear la tabla (si se despliega antes,
   los endpoints de tokens fallarán con 500 hasta aplicar la migración; el resto de la API no se
   ve afectado).
3. Sin `API_TOKEN_PEPPER` en producción, el log muestra un `ERROR` al iniciar y crear/usar tokens
   responde `503`; el resto de la API funciona.

## Prueba de humo en producción

1. Panel admin → Eventos → "Tokens API" → crear un token de prueba y copiarlo.
2. `curl -H "X-Api-Key: <token>" https://<host>/api/v1/integrations/event` → datos del evento.
3. Revocar el token y repetir → `401 {"statusCode":401,"message":"Token de integración inválido"}`.

## Rollback

1. Volver a la imagen anterior del backend.
2. `DROP TABLE EventApiToken;` (no tiene dependientes).
3. Solo en la opción A: `DELETE FROM _prisma_migrations WHERE migration_name =
   '20260929150000_event_api_tokens';`
