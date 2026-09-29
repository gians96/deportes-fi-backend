# AGENTS.md — Backend (deportes-fi)

Guía para agentes de IA y desarrolladores que trabajen en este repositorio.

## Qué es

API REST (NestJS 11 + Prisma + MariaDB) del Sistema de Deportes de la Facultad de
Ingeniería UNDC. Documentación detallada en [`docs/`](./docs/README.md).

## Entorno y comandos

- **Runtime / package manager**: Bun. Usa `bun install`, `bun run <script>`,
  `bunx <bin>`.
- **Shell del proyecto**: Windows PowerShell. Encadena con `;`, **no** con `&&`.
  Para fijar el directorio: `& { Set-Location 'ruta'; comando }`.
- Comandos frecuentes:
  - Dev: `bun run start:dev` → `http://localhost:3001/api/v1` (puerto 3001).
  - Build: `bun run build` · Prod: `bun run start:prod`.
  - Prisma: `bunx prisma generate`, `bunx prisma db push`,
    `bunx prisma migrate dev`, `bun run prisma:seed`.
  - Lint: `bun run lint` · Format: `bun run format`.

## Arquitectura

- Prefijo global **`/api/v1`** (`main.ts`).
- Módulos en `src/<dominio>/`: `auth`, `users`, `faculties`, `events`,
  `disciplines`, `registrations`, `vouchers`, `standings`, `scheduling`, `admin`,
  `academic`, `event-tokens`, `integrations`, `prisma`, `common`.
- Patrón por módulo: `*.controller.ts`, `*.service.ts`, `*.module.ts`, `dto/`.
- **Prisma** es la capa de datos (`PrismaService`). Esquema en
  `prisma/schema.prisma`.
- **Auth**: Google Identity → `JwtStrategy` valida el JWT y rechaza usuarios con
  `isActive=false`. `@CurrentUser()` inyecta el `RequestUser` (`id`, `role`, ...).
- **Autorización**: `JwtAuthGuard` + `RolesGuard` + `@Roles(...)`. Las reglas
  finas (p. ej. "admin solo gestiona STUDENT") viven en el *service* usando el
  `actor`.
- **Integraciones servidor a servidor**: `EventTokenGuard` (`X-Api-Key`,
  independiente del JWT) + `@CurrentEventToken()`. El `eventId` sale **solo** del
  token; todo query de `src/integrations` debe filtrar por él. Los tokens se
  guardan como HMAC-SHA256 con `API_TOKEN_PEPPER` (ver
  `specs/001-tokens-api-por-evento/`).

## Convenciones de código

- TypeScript estricto. DTOs con `class-validator`; el `ValidationPipe` global usa
  whitelist (no aceptes campos fuera del DTO).
- Mensajes de error de negocio en **español** vía
  `BadRequestException`/`ForbiddenException`/`NotFoundException`.
- Validaciones de límite del sistema en el servidor aunque el frontend ya valide
  (p. ej. integrantes duplicados, plazos, voucher obligatorio).
- No introducir `any`; preferir tipos de `@prisma/client`.

## Reglas de negocio clave (no romper)

- Cualquier correo verificado por Google inicia sesión; `@undc.edu.pe`
  numérico es `STUDENT`, el resto es `OTHER`, salvo `OWNER_EMAILS`/`ADMIN_EMAILS`.
- `ADMIN_SYSTEM` solo crea/gestiona usuarios `STUDENT`; no toca admins/owners.
- No inhabilitar a un `OWNER_SYSTEM` ni a uno mismo.
- Inscripción: respetar `registrationDeadline`, mín/máx jugadores, política de
  género, **sin integrantes duplicados** (código/DNI), `maxTeams` y voucher
  obligatorio si la disciplina es `isPaid`.
- `delegateId` en `POST /registrations` **solo** se respeta si el actor es
  admin/owner (creación manual de equipos).
- El rate limit es global por IP y vive como guard de aplicación; no hacerlo
  específico de Decolecta o de un endpoint aislado.

## Seguridad

- Nunca commitear `.env` (ya está en `.gitignore`). Usa `.env.example` como
  plantilla.
- No loguear secretos ni el JWT. CORS controlado por `CORS_ORIGIN`.
- Mantener activo el rate limit global (`APP_RATE_LIMIT_WINDOW_MS` /
  `APP_RATE_LIMIT_MAX_REQUESTS`) para proteger la plataforma.
- Validar tipo/tamaño de los archivos de voucher (Multer).

## Antes de dar por terminado

1. `bun run build` (o que `start:dev` recompile) sin errores TypeScript.
2. Verificar rutas mapeadas en el log de Nest tras reiniciar.
3. Mantener el contrato en [`docs/api-contract.md`](./docs/api-contract.md)
   actualizado si cambian endpoints/DTOs.
