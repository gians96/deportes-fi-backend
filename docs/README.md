# Documentación — Backend (deportes-fi)

API REST del **Sistema de Deportes de la Facultad de Ingeniería (UNDC)**, construida con NestJS 11 + Prisma sobre MariaDB.

## Índice

- [overview.md](./overview.md) — Qué hace, qué se quiere lograr y lo planteado (roadmap).
- [api-contract.md](./api-contract.md) — Contrato de la API: endpoints, auth, request/response.
- [data-model.md](./data-model.md) — Modelo de datos (Prisma) y enums.
- [deployment.md](./deployment.md) — Despliegue (Docker / Dokploy), variables de entorno.
- [runbook-tokens-evento.md](./runbook-tokens-evento.md) — Migración de tokens por evento en producción (deriva, baseline, pepper, rollback).
- [Integración con el congreso](#integración-con-el-congreso-semana-sistémica) — Tokens por evento consumidos por `backend-ciisic` para la "Semana Sistémica" (Contrato 2).
- [`../AGENTS.md`](../AGENTS.md) — Forma de trabajar: comandos, reglas, ecosistema y checklist.

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

## Integración con el congreso (Semana Sistémica)

deportes-fi es el **proveedor del Contrato 2** de
`backend-ciisic/docs/arquitectura-ecosistema.md`: el backend del congreso (CIISIC) lee,
servidor a servidor y en solo lectura, los equipos y pagos de **un** evento deportivo para
sumarlos a la recaudación de la "Semana Sistémica" en su panel.

1. Un OWNER/ADMIN genera el token en el frontend de deportes-fi: **Admin → Eventos → «Tokens
   API»** del evento (`POST /events/:eventId/api-tokens`). El token `dfi_…` se muestra una sola
   vez.
2. Un administrador del congreso lo registra en su panel: **Eventos → (evento) →
   Integraciones**, con la URL base de esta API (`https://<host>/api/v1`) y el token (el congreso
   lo guarda cifrado).
3. `backend-ciisic` llama con `X-Api-Key`:
   - `GET /integrations/event`: botón «Probar» (identifica el evento del token).
   - `GET /integrations/event/summary`: tarjeta «Semana Sistémica» (recaudado = vouchers
     `VALIDATED`); el congreso lo cachea 60 s.
   - `GET /integrations/event/payments` y `/registrations`: listados paginados disponibles.
4. El evento sale **solo** del token. Revocarlo (o que expire) corta la integración con
   `401 "Token de integración inválido"`; el congreso muestra el error en su panel.

Detalle: [api-contract.md → Integración por evento (Contrato 2)](./api-contract.md#integración-por-evento-contrato-2)
y [Tokens de integración del evento](./api-contract.md#tokens-de-integración-del-evento).
Producción (`API_TOKEN_PEPPER`, migración): [runbook-tokens-evento.md](./runbook-tokens-evento.md).
Spec: [`../specs/001-tokens-api-por-evento/`](../specs/001-tokens-api-por-evento/). En local, con
el ecosistema levantado, este backend corre con `PORT=3030` (`http://localhost:3030/api/v1`)
porque el 3001 es del panel del congreso.

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
