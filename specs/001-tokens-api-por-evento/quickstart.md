# Quickstart: prueba de humo local

> **Nunca** contra la base de producción. El `.env` local puede apuntar a producción: las
> variables se sobrescriben en la sesión de PowerShell (las variables de proceso tienen prioridad
> sobre `.env` tanto en Prisma como en `@nestjs/config`).

## 1. Entorno local

```powershell
$env:DATABASE_URL = 'mysql://root:<contraseña local>@localhost:3311/deportes_fi'
$env:JWT_SECRET = 'dev-local-secret-cambiar'
$env:API_TOKEN_PEPPER = 'dev-local-pepper-0123456789abcdef0123456789'
$env:PORT = '3030'
$env:NODE_ENV = 'development'
$env:OWNER_EMAILS = 'owner.local@example.test'
$env:ADMIN_EMAILS = 'admin.local@example.test'

bunx prisma db push --skip-generate   # BD local (Docker deportes-mariadb)
bunx prisma generate
bun run prisma:seed                   # facultad, escuelas y owner/admin locales
bun run build; node dist/main.js      # http://localhost:3030/api/v1
```

Cargar datos de prueba: dos eventos (A y B), disciplinas pagadas/gratuitas `STUDENT`/`OTHER`,
equipos en los cuatro estados y vouchers VALIDATED/PENDING/REJECTED.

## 2. JWT de administrador local

Mismo payload y secreto que `AuthService.signToken`:

```powershell
$jwt = node -e "console.log(require('jsonwebtoken').sign({ sub: 1, email: 'owner.local@example.test', role: 'OWNER_SYSTEM' }, process.env.JWT_SECRET, { expiresIn: '1h' }))"
```

## 3. Emitir, usar y revocar

```powershell
$base = 'http://localhost:3030/api/v1'
curl.exe -s -X POST "$base/events/1/api-tokens" -H "Authorization: Bearer $jwt" `
  -H 'Content-Type: application/json' -d '{\"name\":\"Congreso CIISIC 2026\"}'
# → copiar "token" (solo se muestra aquí)
$key = 'dfi_...'
curl.exe -s "$base/integrations/event" -H "X-Api-Key: $key"
curl.exe -s "$base/integrations/event/summary" -H "X-Api-Key: $key"
curl.exe -s "$base/integrations/event/payments?status=VALIDATED&page=1&pageSize=50" -H "X-Api-Key: $key"
curl.exe -s "$base/integrations/event/registrations?status=APPROVED" -H "X-Api-Key: $key"
curl.exe -s "$base/integrations/event?eventId=2" -H "X-Api-Key: $key"   # sigue siendo el evento 1
curl.exe -s -X DELETE "$base/events/1/api-tokens/1" -H "Authorization: Bearer $jwt"
curl.exe -s "$base/integrations/event" -H "X-Api-Key: $key"             # 401
```

## 4. Verificaciones esperadas

- La respuesta de creación trae `token`; `GET /events/1/api-tokens` no trae `token` ni
  `tokenHash`.
- En la base, `EventApiToken.tokenHash` es un hex de 64 caracteres y el token en claro no
  aparece.
- Los números del resumen coinciden con los datos cargados; ningún id/nombre del evento B
  aparece con el token del evento A.
- Tras revocar (o con `expiresAt` vencida): `401 {"statusCode":401,"message":"Token de
  integración inválido"}`.
- Detener el servidor al terminar.
