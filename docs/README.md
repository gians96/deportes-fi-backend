# Documentación — Backend (deportes-fi)

API REST del **Sistema de Deportes de la Facultad de Ingeniería (UNDC)**, construida con NestJS 11 + Prisma sobre MariaDB.

## Índice

- [overview.md](./overview.md) — Qué hace, qué se quiere lograr y lo planteado (roadmap).
- [api-contract.md](./api-contract.md) — Contrato de la API: endpoints, auth, request/response.
- [data-model.md](./data-model.md) — Modelo de datos (Prisma) y enums.
- [deployment.md](./deployment.md) — Despliegue (Docker / Dokploy), variables de entorno.
- [runbook-tokens-evento.md](./runbook-tokens-evento.md) — Migración de tokens por evento en producción (deriva, baseline, pepper, rollback).

## Flujo actual

- Cualquier correo verificado por Google puede iniciar sesión. Los correos
  `@undc.edu.pe` numéricos son `STUDENT`; el resto entra como `OTHER`.
- `STUDENT` completa facultad/escuela. `OTHER` completa solo DNI validado con
  Decolecta y no pertenece a facultad ni escuela dentro del sistema.
- `/registrations/mine` muestra equipos donde el usuario es delegado o jugador
  vinculado.
- `/admin/inscripciones` es el centro único para gestionar equipos gratuitos y
  de pago, incluyendo teléfono de contacto del equipo/delegado; `/admin/vouchers`
  queda como compatibilidad.
- Toda la API tiene rate limit global por IP para proteger el uso de la
  plataforma.
- Tokens de integración por evento (`/events/:eventId/api-tokens`, admin) dan
  acceso de solo lectura a `/integrations/event/*` con `X-Api-Key` (Contrato 2
  del ecosistema CIISIC); el evento sale solo del token.

## Stack

| Capa            | Tecnología                                  |
| --------------- | ------------------------------------------- |
| Framework       | NestJS 11                                   |
| Lenguaje        | TypeScript                                  |
| Runtime / PM    | Bun                                         |
| ORM             | Prisma 6 (`mysql` provider)                 |
| Base de datos   | MariaDB externa (`DATABASE_URL`)            |
| Auth            | Google Identity + JWT (`@nestjs/jwt`)       |
| Validación      | class-validator / class-transformer         |
| Subida archivos | Multer (`uploads/` local)                   |
| Seguridad       | helmet, compression, cookie-parser          |

## Arranque local

```powershell
bun install
bunx prisma generate
bunx prisma db push          # o: bun run prisma:migrate
bun run prisma:seed          # datos iniciales (roles, facultad, owner)
bun run start:dev            # http://localhost:3001/api/v1
```

> Prefijo global de la API: **`/api/v1`**. Puerto por defecto: **3001**.
