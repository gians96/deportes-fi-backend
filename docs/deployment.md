# Despliegue — Backend

El backend se despliega como **servicio independiente** (sin docker-compose),
pensado para **Dokploy**. Consume una **MariaDB externa** vía `DATABASE_URL`.

## Imagen Docker

Build multi-stage (Bun para construir, Node 22 alpine para ejecutar). Ver
[`Dockerfile`](../Dockerfile).

- Expone el puerto **3001** y arranca con `node dist/main.js`.
- Crea `uploads/vouchers` dentro del contenedor.
- El runtime es Alpine; Prisma debe incluir `linux-musl-openssl-3.0.x` en
  `binaryTargets` y el contenedor instala `openssl`.

```powershell
docker build -t deportes-fi-backend .
docker run -p 3001:3001 --env-file .env deportes-fi-backend
```

## Variables de entorno

| Variable               | Descripción | Ejemplo |
| ---------------------- | ----------- | ------- |
| `DATABASE_URL`         | URL completa MariaDB externa | `mysql://user:pass@host:3306/deportes_fi` |
| `PORT`                 | Puerto HTTP | `3001` |
| `CORS_ORIGIN`          | Orígenes permitidos (coma) | `https://deportes-fi.undc.edu.pe` |
| `JWT_SECRET`           | Clave de firma JWT | *(secreto fuerte)* |
| `JWT_EXPIRES_IN`       | Expiración del token | `7d` |
| `API_TOKEN_PEPPER`     | Pepper del HMAC-SHA256 de los tokens de integración por evento. **Obligatorio en producción** (sin él, crear/usar tokens responde 503). Cambiarlo invalida todos los tokens | *(secreto ≥ 32 caracteres aleatorios)* |
| `GOOGLE_CLIENT_ID`     | Client ID de Google (mismo que el frontend) | |
| `ACADEMIC_API_URL`     | Endpoint del padrón SIVIRENO (validación de estudiantes) | *(ver `.env.example`)* |
| `DECOLECTA_API_URL`    | Endpoint RENIEC vía Decolecta (validación por DNI) | `https://api.decolecta.com/v1/reniec/dni` |
| `DECOLECTA_TOKEN`      | Token Bearer de Decolecta | *(secreto)* |
| `UPLOADS_DIR`          | Carpeta de archivos subidos | `uploads` |
| `OWNER_EMAILS`         | Correos con rol owner (coma) | |
| `ADMIN_EMAILS`         | Correos con rol admin (coma) | |
| `APP_RATE_LIMIT_WINDOW_MS` | Ventana del rate limit global por IP | `60000` |
| `APP_RATE_LIMIT_MAX_REQUESTS` | Máximo de requests por IP dentro de la ventana | `120` |

> Plantilla completa en [`.env.example`](../.env.example). **Nunca** se commitea
> el `.env` real (está en `.gitignore`).

## Pasos en Dokploy

1. Crear una **Application** apuntando al repositorio del backend (build por
   Dockerfile).
2. Definir todas las variables de entorno anteriores.
3. Exponer el puerto **3001** y mapear el dominio público (`/api/v1`).
4. **Volumen persistente** montado en `UPLOADS_DIR` (`/app/uploads`) para
   conservar los vouchers entre despliegues.
5. Migraciones de base de datos en el arranque/CI:
   ```bash
   bunx prisma migrate deploy
   ```
   (o `prisma db push` si no se usan migraciones versionadas).
   Hay deriva conocida entre `prisma/migrations` y `schema.prisma`; antes de
   aplicar la migración de tokens por evento sigue
   [`runbook-tokens-evento.md`](./runbook-tokens-evento.md).

## Checklist de producción

- [ ] `DATABASE_URL` apunta a la MariaDB correcta y el usuario tiene privilegios.
- [ ] `JWT_SECRET` único y fuerte (no el de ejemplo).
- [ ] `API_TOKEN_PEPPER` definido (aleatorio, ≥ 32 caracteres) y guardado en el
      gestor de secretos; no rotarlo sin reemitir los tokens de integración.
- [ ] `CORS_ORIGIN` con el dominio real del frontend.
- [ ] `GOOGLE_CLIENT_ID` coincide con el del frontend y el dominio está
      autorizado en Google Cloud Console (orígenes JS).
- [ ] Volumen persistente para `uploads/`.
- [ ] Rate limit global ajustado al tráfico esperado.
- [ ] `prisma migrate deploy` ejecutado tras desplegar.
