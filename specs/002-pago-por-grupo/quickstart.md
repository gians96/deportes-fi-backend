# Quickstart — Prueba de humo local (pago por grupo)

Solo contra la base **local** de Docker. Nunca contra producción (`AGENTS.md`).

```powershell
# 1. Base local y variables de la sesión (las del proceso tienen prioridad sobre .env)
docker start deportes-mariadb
$env:DATABASE_URL = 'mysql://root:<pass-local>@localhost:3311/deportes_fi'
$env:JWT_SECRET = 'local-dev-secret-de-al-menos-32-caracteres'
$env:API_TOKEN_PEPPER = 'local-dev-pepper-de-al-menos-32-caracteres'
$env:PORT = '3030'

# 2. Migración y cliente
bunx prisma migrate deploy
bunx prisma generate

# 3. Servidor
bun run start:dev
```

Pasos de verificación (con un JWT de admin y uno de estudiante locales):

1. `PUT /api/v1/events/:id/pricing` → `PER_GROUP`, 100 / 150 / 20 / 30.
2. `POST /api/v1/groups` (multipart, imagen de prueba) → grupo `SECTION` "V A1" con voucher base 100.
3. Repetir con `cycle=5`, `section=a-1` → **409**.
4. `POST /api/v1/registrations` ×5 (una por disciplina) con `groupId` → todas cupo 1, sin voucher.
5. Segundo equipo de Futsal sin voucher → 400; con voucher → cupo 2 y `EXTRA` de 20.
6. `PATCH /api/v1/vouchers/:baseId/validate` → equipos válidos `APPROVED`, `skipped` con motivos.
7. Con un token de evento: `GET /api/v1/integrations/event/summary` y `/payments` → un solo pago
   base de 100 y `Σ byDiscipline.validatedAmount = payments.validated.amount`.
8. Rechazar un voucher y reemplazarlo con `PATCH /api/v1/vouchers/:id/replace`.
9. Regresión: un evento `PER_DISCIPLINE` se inscribe y se valida como antes.

Esperado en el log de Nest: rutas `GroupsController` y `/events/:eventId/pricing` mapeadas.
