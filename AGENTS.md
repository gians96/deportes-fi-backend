# AGENTS.md — Backend (deportes-fi)

Guía para agentes de IA y desarrolladores que trabajen en este repositorio.

## Qué es

API REST (NestJS 11 + Prisma + MariaDB) del Sistema de Deportes de la Facultad de
Ingeniería UNDC. Documentación detallada en [`docs/`](./docs/README.md). Principios no
negociables en [`.specify/memory/constitution.md`](./.specify/memory/constitution.md).

En el ecosistema es el **proveedor del Contrato 2**: tokens de integración por evento con los
que el backend del congreso (`backend-ciisic`) lee, en solo lectura, los equipos y pagos de un
evento deportivo para la "Semana Sistémica".

## Entorno y comandos

- **Runtime / package manager**: Bun. Usa `bun install`, `bun run <script>`,
  `bunx <bin>`.
- **Shell del proyecto**: Windows PowerShell. Encadena con `;`, **no** con `&&`.
  Para fijar el directorio: `& { Set-Location 'ruta'; comando }`.
- Comandos frecuentes:
  - Dev: `bun run start:dev` → `http://localhost:3001/api/v1` (puerto 3001).
    En el ecosistema local usa `$env:PORT = '3030'` (el 3001 es del panel del congreso) →
    `http://localhost:3030/api/v1`.
  - Build: `bun run build` · Prod: `bun run start:prod`.
  - Pruebas: `bun run test` (Jest sobre `src/**/*.spec.ts`, con *fakes*; no necesitan base de
    datos). `bun run test:e2e` falla desde antes (el scaffold espera `GET /` → "Hello World!").
  - Prisma: `bunx prisma generate`, `bunx prisma db push`,
    `bunx prisma migrate dev`, `bun run prisma:seed`.
  - Lint: `bun run lint` · Format: `bun run format`. Ambos corrigen **todo** el repositorio
    (`--fix`/`--write`) y hay deuda previa de formato: dentro de un feature revisa solo tus
    archivos (`bunx eslint <archivos>`).
- **Base local**: MariaDB en Docker `deportes-mariadb` (`localhost:3311`, base `deportes_fi`). El
  `.env` puede apuntar a producción: antes de usar Prisma, seeds o el servidor, sobrescribe en la
  sesión `$env:DATABASE_URL` (y `JWT_SECRET`, `API_TOKEN_PEPPER`, `PORT`); las variables del
  proceso tienen prioridad sobre `.env`. Guía paso a paso:
  `specs/001-tokens-api-por-evento/quickstart.md`.
- **Docker**: `Dockerfile` multi-stage (Bun → Node 22 alpine), puerto 3001; la imagen **no**
  ejecuta migraciones (ver [`docs/deployment.md`](./docs/deployment.md)).

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
- `src/common/`: guards (`JwtAuthGuard`, `RolesGuard`, `AppRateLimitGuard` global,
  `EventTokenGuard`), decoradores (`@CurrentUser`, `@Roles`, `@CurrentEventToken`), `upload/` y
  `rich-text.ts`.
- Respuestas en **JSON plano** (no hay interceptor de envoltura).

## Convenciones de código

- TypeScript estricto. DTOs con `class-validator`; el `ValidationPipe` global usa
  whitelist (no aceptes campos fuera del DTO).
- Mensajes de error de negocio en **español** vía
  `BadRequestException`/`ForbiddenException`/`NotFoundException`.
- Validaciones de límite del sistema en el servidor aunque el frontend ya valide
  (p. ej. integrantes duplicados, plazos, voucher obligatorio).
- No introducir `any`; preferir tipos de `@prisma/client`.
- Esquema Prisma: modelos en PascalCase, campos en camelCase, sin `@@map`, `onDelete` explícito
  en relaciones dependientes.

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

**Tokens de integración por evento** (Contrato 2, `specs/001-tokens-api-por-evento`):

- Formato `dfi_` + 43 caracteres base64url (32 bytes aleatorios); prefijo visible de 12
  caracteres (`dfi_` + 8). El valor en claro solo se devuelve **una vez**, al crearlo
  (`POST /events/:eventId/api-tokens`, `Cache-Control: no-store`); los listados nunca traen el
  token ni su hash.
- Se guarda `HMAC-SHA256(token)` con `API_TOKEN_PEPPER`. En producción, sin pepper, crear o usar
  tokens responde 503; en desarrollo se deriva de `JWT_SECRET` con advertencia. Cambiar el pepper
  invalida todos los tokens emitidos.
- Un token pertenece a **un solo** evento; `?eventId=` y cualquier otro parámetro se ignoran. El
  aislamiento entre eventos está probado: no lo rompas.
- Estado calculado `ACTIVE | REVOKED | EXPIRED` (`REVOKED` prevalece); revocar fija `revokedAt`,
  conserva el registro y es idempotente; `expiresAt` debe ser futura.
- Token ausente, mal formado, inexistente, revocado o expirado → exactamente
  `401 { "statusCode": 401, "message": "Token de integración inválido" }`.
- Las respuestas de `/integrations/event/*` no incluyen correos, DNI, códigos de estudiante,
  teléfonos, nombres de integrantes ni URLs de vouchers. "Recaudado" = suma de `Voucher.amount`
  con `status = VALIDATED` (solo por el estado del voucher). Paginación: `page ≥ 1`,
  `pageSize` 1–100 (si no, 400).

## Seguridad

- Nunca commitear `.env` (ya está en `.gitignore`). Usa `.env.example` como
  plantilla.
- No loguear secretos ni el JWT. CORS abierto (`*`, sin cookies): la seguridad es el JWT o el
  token del evento (`X-Api-Key`), no el origen.
- Mantener activo el rate limit global (`APP_RATE_LIMIT_WINDOW_MS` /
  `APP_RATE_LIMIT_MAX_REQUESTS`) para proteger la plataforma.
- Validar tipo/tamaño de los archivos de voucher (Multer).
- `API_TOKEN_PEPPER` es obligatorio en producción (≥ 32 caracteres aleatorios, en el gestor de
  secretos); ni el pepper ni los tokens `dfi_` se registran en logs ni se versionan.
- Nunca ejecutar migraciones, `db push`, seeds ni el servidor contra la base de producción desde
  un entorno local.

## Ecosistema y comunicación entre sistemas

Este repositorio es parte del ecosistema de la Facultad de Ingeniería (UNDC). La fuente de
verdad de los contratos entre sistemas es
`backend-ciisic/docs/arquitectura-ecosistema.md` (contratos 1 a 5).

### Papel del backend de deportes-fi

- **Expone** a `backend-ciisic` (servidor a servidor, `X-Api-Key: dfi_…`):
  `GET /api/v1/integrations/event`, `/summary`, `/payments` y `/registrations`. El congreso usa
  `/integrations/event` para su botón "Probar" y `/integrations/event/summary` para la tarjeta
  "Semana Sistémica" (lo cachea 60 s); `payments` y `registrations` quedan disponibles.
- **Expone** al frontend de deportes-fi: toda la API `/api/v1` con JWT, incluida la gestión de
  tokens `/events/:eventId/api-tokens` (OWNER/ADMIN).
- **Consume**: SIVIRENO (padrón, `ACADEMIC_API_URL`), Decolecta (RENIEC) y Google Identity.
  No llama a otros sistemas del ecosistema.
- **Configuración del flujo**: el token se genera en el frontend (Admin → Eventos → «Tokens
  API») y un administrador del congreso lo registra en su panel (Eventos → Integraciones) con la
  URL base `https://<host>/api/v1`. Resumen en [`docs/README.md`](./docs/README.md#integración-con-el-congreso-semana-sistémica).

### Mapa del ecosistema

| Sistema | Repositorio | Rol | Expone | Consume |
|---|---|---|---|---|
| API del congreso | `gians96/backend-ciisic` | Eventos, inscripciones, credenciales, DNI, verificación, Google, portal | API admin (JWT admin), `/api/v1/site/*` (token de acceso del evento), `/api/v1/me/*` (JWT de inscrito), `/api/v1/auth/*` | API_UNDC, deportes-fi, Decolecta/apiperu, Brevo, Google |
| Panel del congreso | `gians96/administrator-ciisic-frontend` | Administración + portal "Mis inscripciones" | UI (BFF Nitro) | backend-ciisic (vía BFF, cookie httpOnly → Bearer) |
| Landing del evento | `gians96/ciisic-undc-web` | Sitio público e inscripción | UI (SSR + BFF Nitro) | backend-ciisic `/api/v1/site/*` con el token del evento, solo desde su servidor |
| API UNDC | `API_UNDC` | Datos académicos (SIVIRENO, horarios…) | `POST /externo/estudiantes/verificar` (`X-API-Key` con scope `estudiantes:verificar`) | SIVIRENO, API Perú |
| SIGENET | `app-web-sigenet` | Frontend administrativo de API_UNDC | UI (pestaña Clientes API) | API_UNDC |
| **Deportes FI (este repositorio: backend)** | `deportes-fi/backend` + `deportes-fi/frontend` | Inscripción de equipos y pagos | `GET /api/v1/integrations/event/*` (`X-Api-Key` = token por evento) | — |

Flujos entre sistemas:

1. **Verificación de estudiantes** (contrato 1): backend-ciisic → API_UNDC con una API key
   creada en SIGENET → Clientes API. La URL y la key se configuran en el panel del congreso
   (Sistema), no en variables de entorno.
2. **Semana Sistémica** (contrato 2): backend-ciisic → deportes-fi con un token por evento
   generado en deportes-fi (Eventos → Tokens API) y registrado en el panel del congreso
   (Eventos → Integraciones).
3. **Landing ↔ backend** (contrato 3): la landing llama a `/api/v1/site/*` desde su servidor
   con el token de acceso del evento (panel → Eventos → Acceso).
4. **Panel ↔ backend** (contrato 4): el BFF del panel agrega el Bearer desde una cookie httpOnly.
5. **Google y portal** (contrato 5): el panel y la landing usan el client ID guardado en el
   backend (Sistema); el backend verifica los ID tokens.

Puertos locales (desarrollo): landing 3000 · panel 3001 · backend-ciisic 3010 · API_UNDC 3020 ·
deportes-fi backend 3030 (con `PORT=3030`; su valor por defecto choca con el panel).
MySQL en Docker `ciisic-mysql` :3310 (BD `ciisic_vii`, `jp`) y MariaDB `deportes-mariadb` :3311.

### Protocolo de cambio de contrato

1. El cambio empieza en el repositorio **proveedor** con una spec (`specs/NNN-*/`) que incluye
   `contracts/`.
2. Se actualiza `backend-ciisic/docs/arquitectura-ecosistema.md` si afecta a otro sistema.
3. Cambios compatibles hacia atrás; si no es posible, se versiona o se mantiene un alias
   temporal (como las rutas legacy del congreso) y se retira cuando el consumidor migró.
4. El consumidor se actualiza en **su propio** repositorio y rama.
5. Se hace una prueba integrada local con los dos sistemas levantados antes de desplegar.

Este backend es el proveedor del Contrato 2: sus cambios empiezan aquí
(`specs/NNN-*/contracts/`) y se reflejan en [`docs/api-contract.md`](./docs/api-contract.md).

### Trabajo con agentes de IA (varias sesiones en paralelo)

- **Un agente por repositorio a la vez.** Antes de empezar: `git status` y `git log --oneline -10`.
  Si hay cambios sin comitear que no son tuyos, detente y coordina; no los mezcles ni los descartes.
- **No modifiques otros repositorios.** Si un cambio requiere al otro sistema, documenta el
  contrato y pide el cambio a quien trabaja en ese repositorio.
- **Git**: ramas `feat/*`; `git add <rutas explícitas>` (nunca `-A` ni `.`); commits pequeños con
  mensajes convencionales en español; **no** hagas push, merge ni despliegues sin confirmación
  humana; nunca reescribas historia publicada.
- **Secretos**: nunca en el repositorio ni en los reportes; `.env` fuera de git; producción solo
  con permiso explícito y empezando por un respaldo de solo lectura.
- **Al terminar**, deja un reporte: commits (hash y mensaje), pruebas ejecutadas y resultado,
  cambios de contrato y pendientes.

`backend/` y `frontend/` son repositorios git independientes: trabaja en uno a la vez y no
toques archivos de la carpeta padre `deportes-fi/`.

## SDD con Spec Kit

- Constitución: [`.specify/memory/constitution.md`](./.specify/memory/constitution.md)
  (prevalece sobre prácticas ad hoc; esta guía no puede contradecirla). Cada `plan.md` incluye su
  verificación contra ella.
- Cada feature vive en `specs/NNN-nombre/` (numeración secuencial):
  1. `spec.md`: historias priorizadas, escenarios Given/When/Then, requisitos `FR-xxx`, casos
     límite y criterios de éxito (+ `checklists/requirements.md`).
  2. `plan.md`: diseño técnico; `research.md`, `data-model.md`, `contracts/*.md` y
     `quickstart.md` (prueba de humo) cuando aplican.
  3. `tasks.md`: tareas con casillas `- [ ]` por fases e historias.
  4. Implementación en commits pequeños: marca cada tarea `- [x]` al terminarla, cierra con la
     "Evidencia de verificación" y cambia el estado de la spec a "Implementada".
- En Claude Code: `/speckit-specify` → `/speckit-clarify` → `/speckit-plan` → `/speckit-tasks` →
  `/speckit-analyze` → `/speckit-implement` (`/speckit-converge` agrega lo que falte). Los scripts
  están en `.specify/scripts/powershell/`.
- Specs: `001-tokens-api-por-evento`.

## Antes de dar por terminado

1. `bun run build` (o que `start:dev` recompile) sin errores TypeScript.
2. Verificar rutas mapeadas en el log de Nest tras reiniciar.
3. Mantener el contrato en [`docs/api-contract.md`](./docs/api-contract.md)
   actualizado si cambian endpoints/DTOs.
4. `bun run test` en verde, incluidas las suites nuevas (toda lógica nueva de seguridad,
   agregación o aislamiento de datos lleva pruebas Jest sin base de datos real).
5. ESLint sin errores nuevos en los archivos tocados.
6. Si cambia el esquema: migración revisada a mano en `prisma/migrations/` más su runbook (ver
   [`docs/runbook-tokens-evento.md`](./docs/runbook-tokens-evento.md)); `data-model.md` y
   `deployment.md` si aplica; variables nuevas en `.env.example` sin valores reales.
7. Prueba de humo local (servidor en el puerto 3030 contra la base Docker) y tareas marcadas en
   `tasks.md`.
8. Si cambia el Contrato 2: actualizar también `backend-ciisic/docs/arquitectura-ecosistema.md`
   (coordinando con quien trabaja ese repositorio) y probar con el congreso levantado.
9. `git status` muestra solo tus archivos; `git add <rutas explícitas>`.
