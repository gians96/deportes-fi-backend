# Constitución — Backend Deportes FI (UNDC)

Principios no negociables del API REST del Sistema de Deportes de la Facultad de Ingeniería
(UNDC). Complementa `AGENTS.md` (guía operativa) y `docs/` (contrato y modelo de datos).

## Core Principles

### I. El contrato es la fuente de verdad

- Todo endpoint, DTO o forma de respuesta nueva o modificada MUST quedar documentada en
  `docs/api-contract.md` en el mismo cambio.
- Los contratos entre sistemas del ecosistema (p. ej. **Contrato 2** de
  `backend-ciisic/docs/arquitectura-ecosistema.md`) MUST implementarse exactamente: mismos
  campos, tipos y códigos de estado; no se agregan envoltorios ni campos extra sin actualizar
  primero ese documento.
- Prefijo global `/api/v1`; JSON plano (no existe interceptor de envoltura de respuestas).

### II. Seguridad por defecto

- Autenticación de usuarios con Google Identity + JWT (`JwtAuthGuard`); autorización con
  `RolesGuard` + `@Roles(...)`. Las reglas finas viven en el *service* recibiendo el `actor`
  (`@CurrentUser()`).
- Las credenciales **entrantes** (tokens de integración) MUST guardarse solo como hash
  HMAC-SHA256 con un *pepper* de entorno; el valor en claro se muestra una única vez.
- Nunca se commitean secretos (`.env` está ignorado; se documentan en `.env.example`), ni se
  registran en logs el JWT, tokens o pepper.
- El rate limit global por IP (`AppRateLimitGuard`, guard de aplicación) MUST permanecer activo
  para todos los endpoints, incluidos los de integración.
- Las respuestas de integración devuelven datos mínimos: sin correos, DNI, códigos de
  estudiante, teléfonos ni URLs de vouchers.

### III. Reglas de negocio en el servidor

- DTOs con `class-validator`; el `ValidationPipe` global usa `whitelist` y `transform`.
- Toda validación de límite del sistema se aplica en el servidor aunque el frontend ya valide
  (plazos, mín/máx de jugadores, duplicados, voucher obligatorio, filtros de consulta).
- Errores de negocio en **español** mediante `BadRequestException`, `ForbiddenException`,
  `NotFoundException`, etc.
- TypeScript sin `any`; se prefieren los tipos generados de `@prisma/client`.

### IV. Datos con Prisma y migraciones revisadas

- `prisma/schema.prisma` es la fuente de verdad (provider `mysql` sobre MariaDB). Estilo:
  modelos en PascalCase, campos en camelCase, sin `@@map`; `onDelete` explícito en relaciones
  dependientes.
- Todo cambio de esquema MUST ir acompañado de una migración en `prisma/migrations/` revisada a
  mano (solo los cambios del feature) y de un runbook de aplicación en producción.
- La deriva (*drift*) existente entre migraciones y esquema se documenta; no se corrige de forma
  silenciosa dentro de otro cambio.
- Nunca se ejecutan migraciones, `db push`, seeds ni el servidor contra la base de datos de
  producción desde un entorno local; en local se usa MariaDB en Docker
  (`localhost:3311/deportes_fi`).

### V. Pruebas y verificación

- Toda lógica nueva de seguridad, agregación o aislamiento de datos MUST tener pruebas Jest
  (`src/**/*.spec.ts`) que no dependan de una base de datos real (mocks o *fakes* en memoria).
- El aislamiento entre eventos (un token de un evento nunca lee datos de otro) es un requisito
  probado, no asumido.
- Los endpoints nuevos se verifican además con una prueba de humo local (servidor en el puerto
  3030 contra la BD local).

## Stack y convenciones

- NestJS 11 + TypeScript, Prisma 6 (`@prisma/client`), MariaDB externa vía `DATABASE_URL`,
  `@nestjs/config`, Passport JWT, Multer, helmet, compression. Gestor: **Bun** (`bun.lock`).
- Módulos por dominio en `src/<dominio>/` con `*.controller.ts`, `*.service.ts`,
  `*.module.ts` y `dto/`; guards y decoradores compartidos en `src/common/`.
- Shell del proyecto: Windows PowerShell (encadenar con `;`).
- Despliegue independiente con su `Dockerfile` (Dokploy); la imagen no ejecuta migraciones.

## Flujo de trabajo y puertas de calidad

- Flujo SDD con Spec Kit: `spec.md` → `plan.md` (+ `data-model.md`, `contracts/`) →
  `tasks.md` → implementación, en `specs/NNN-nombre/`.
- Commits pequeños con Conventional Commits en español; nunca `git add -A`.
- **Definición de terminado**:
  1. `bun run build` sin errores TypeScript.
  2. `bun run test` en verde (las suites nuevas incluidas).
  3. ESLint sin errores nuevos en los archivos tocados (hay deuda previa de formato en
     archivos existentes; no se corrige de forma masiva dentro de un feature).
  4. `docs/api-contract.md` (y `data-model.md`/`deployment.md` si aplica) actualizados.
  5. Migración revisada + runbook, y variables nuevas documentadas en `.env.example`.
  6. Prueba de humo local ejecutada y tareas marcadas en `tasks.md`.

## Governance

- Esta constitución prevalece sobre prácticas ad hoc; `AGENTS.md` es la guía operativa diaria y
  no puede contradecirla.
- Enmiendas: cambio en este archivo con justificación en el commit; versionado semántico
  (MAJOR: se elimina o redefine un principio; MINOR: principio o sección nueva; PATCH:
  redacción).
- Cada `plan.md` incluye una verificación explícita contra estos principios.

**Version**: 1.0.0 | **Ratified**: 2026-09-29 | **Last Amended**: 2026-09-29
