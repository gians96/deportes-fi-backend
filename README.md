# Deportes FI — Backend

API REST de gestión deportiva para la **Facultad de Ingeniería (UNDC)**.
Construida con **NestJS 11**, **TypeScript**, **Prisma 6** (MariaDB/MySQL),
**JWT** + **Google Auth Library** y **Multer** para archivos.
Gestor de paquetes: **Bun**.

## Requisitos

- Bun >= 1.2
- MariaDB/MySQL accesible vía `DATABASE_URL`

## Configuración

```bash
cp .env.example .env
```

| Variable | Descripción |
| --- | --- |
| `DATABASE_URL` | URL completa de MariaDB (`mysql://user:pass@host:3306/db`) |
| `PORT` | Puerto del servidor (default `3001`) |
| `CORS_ORIGIN` | Orígenes permitidos, separados por coma |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | Configuración de JWT |
| `API_TOKEN_PEPPER` | Pepper del hash de los tokens de integración por evento (obligatorio en producción) |
| `GOOGLE_CLIENT_ID` | Client ID de Google (igual que el frontend) |
| `ACADEMIC_API_URL` | Endpoint del padrón SIVIRENO (estudiantes) |
| `DECOLECTA_API_URL` / `DECOLECTA_TOKEN` | Endpoint y token RENIEC vía Decolecta (usuarios/participantes `OTHER` por DNI) |
| `UPLOADS_DIR` | Directorio de archivos subidos (default `uploads`) |
| `OWNER_EMAILS` / `ADMIN_EMAILS` | Correos con rol elevado (separados por coma) |
| `APP_RATE_LIMIT_WINDOW_MS` / `APP_RATE_LIMIT_MAX_REQUESTS` | Límite global por IP para proteger toda la API |

## Base de datos

```bash
bun install
bunx prisma generate
bunx prisma migrate dev --name init   # crea las tablas
bun run prisma:seed                    # facultad, escuelas y owners/admins
```

## Desarrollo

```bash
bun run start:dev
```

API disponible en `http://localhost:3001/api/v1`.

## Build de producción

```bash
bun run build
node dist/main.js
```

## Endpoints principales (prefijo `/api/v1`)

- `POST /auth/google` — login con ID token de Google
- `GET /auth/me` — perfil autenticado
- `GET /academic/student?buscador=` — consulta padrón SIVIRENO (único resultado)
- `GET /academic/dni?numero=` — consulta RENIEC vía Decolecta (8 dígitos)
- `GET /events`, `GET /events/:id`, `GET /events/:id/disciplines`
- `GET /disciplines`, `GET /disciplines/:id`
- `POST /registrations` (multipart con voucher), `GET /registrations/mine`
- `PATCH /registrations/:id/approve|reject`
- `GET /vouchers`, `PATCH /vouchers/:id/validate|reject`
- `GET /users`, `PATCH /users/:id/role`
- `GET /standings/:disciplineId`, `GET /results/mine`
- `GET /admin/dashboard`
- `POST|GET /events/:eventId/api-tokens`, `DELETE /events/:eventId/api-tokens/:id` — tokens de integración (admin)
- `GET /integrations/event`, `/summary`, `/payments`, `/registrations` — integración con `X-Api-Key` (ver `docs/api-contract.md`)

## Autenticación

1. El frontend obtiene un **ID token** de Google y lo envía a `POST /auth/google`.
2. El backend verifica el token de Google y extrae el código
   (parte antes de `@`) cuando corresponde.
3. El rol se resuelve por correo:
   - correos configurados en env conservan `OWNER_SYSTEM` o `ADMIN_SYSTEM`;
   - correos `@undc.edu.pe` numéricos como `123456789@undc.edu.pe` son `STUDENT`;
   - cualquier otro correo verificado por Google es `OTHER`.
4. Para `STUDENT` se intenta enriquecer el perfil contra el padrón académico por
   código. Para `OTHER`, el perfil se completa luego solo con DNI validado por
   Decolecta.
5. Devuelve un **JWT** usado en `Authorization: Bearer`.

## Roles y flujo de inscripción

- `STUDENT`: usuario estudiantil. Debe completar facultad y escuela profesional,
  y solo puede inscribir disciplinas para estudiantes.
- `OTHER`: usuario no estudiantil. No pertenece a facultad ni
  escuela dentro del sistema; completa perfil solo con DNI. Puede ver e inscribir
  disciplinas para estudiantes y para otros.
- `OWNER_SYSTEM` / `ADMIN_SYSTEM`: usuarios administrativos. Pueden crear equipos
  manualmente y designar delegado.

El delegado es el responsable de la inscripción, pero no se guarda como jugador
del equipo. Los jugadores se validan por `studentCode` en disciplinas
`STUDENT`, y por `dni` en disciplinas `OTHER`. `/registrations/mine` devuelve
equipos donde el usuario es delegado o integrante vinculado.

La API aplica un rate limit global por IP a todos los endpoints. Al excederlo,
responde `429 Too Many Requests` y cabeceras `X-RateLimit-*`.

## Docker / Dokploy

Se despliega por separado, **solo con su Dockerfile** (sin docker-compose).
La base de datos es un servicio externo consumido por `DATABASE_URL`.

```bash
docker build -t deportes-fi-backend .
docker run -p 3001:3001 \
  -e DATABASE_URL="mysql://user:pass@host:3306/deportes_fi" \
  -e JWT_SECRET=xxxx \
  -e GOOGLE_CLIENT_ID=xxxx \
  -e CORS_ORIGIN=https://tu-frontend \
  -v deportes_uploads:/app/uploads \
  deportes-fi-backend
```

> En Dokploy monta un **volumen persistente** en `/app/uploads` para conservar
> los comprobantes subidos. Ejecuta `prisma migrate deploy` en el arranque o como
> job previo al despliegue.
