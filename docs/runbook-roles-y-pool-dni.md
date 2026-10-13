# Runbook — Tesorero, acceso por contraseña y pool de tokens DNI

Cubre las specs `004-tesorero-y-acceso-por-contrasena` y `005-pool-tokens-dni`. **Nunca** ejecutes
migraciones, `db push`, seeds ni el servidor contra producción desde un entorno local: sobrescribe
`DATABASE_URL` con una base de pruebas (el `.env` del backend apunta a producción).

## Spec 004 — Tesorero y acceso por contraseña

### Migración `20261014120000_tesorero_y_acceso_por_contrasena`

Aditiva y reversible:

```sql
ALTER TABLE `User`
  MODIFY `role` ENUM('OWNER_SYSTEM', 'ADMIN_SYSTEM', 'TREASURER', 'REFEREE', 'STUDENT', 'OTHER') NOT NULL DEFAULT 'STUDENT',
  ADD COLUMN `passwordHash` VARCHAR(255) NULL,
  ADD COLUMN `tokenVersion` INTEGER NOT NULL DEFAULT 0;
```

Orden de despliegue: aplicar la migración (`prisma migrate deploy`), luego desplegar el backend y el frontend.
Antes de la migración el backend nuevo no arranca bien (el cliente de Prisma conoce columnas que no
existen), así que no inviertas el orden. Ninguna cuenta existente recibe contraseña ni cambia de rol.

Reversa (solo si no hay cuentas con contraseña ni tesoreros): `ALTER TABLE User DROP COLUMN passwordHash,
DROP COLUMN tokenVersion, MODIFY role ENUM('OWNER_SYSTEM','ADMIN_SYSTEM','REFEREE','STUDENT','OTHER') ...`.
Si ya hay usuarios `TREASURER`, cambia su rol antes.

### Crear la primera cuenta con contraseña

1. Entra como Owner o Administrador a **Admin → Usuarios → Nuevo usuario**.
2. Elige el rol (Estudiante, Otro, Árbitro, Tesorero…), **Acceso: «Contraseña o Google»** y escribe una contraseña
   de 10 a 128 caracteres (hay un botón para generarla). Un estudiante de prueba necesita facultad y escuela para no
   pasar por «Completa tu perfil».
3. Entrega la contraseña por un canal seguro. La persona entra desde `/login` con correo y contraseña.

Cambiar o quitar la contraseña (**Usuarios → Contraseña**) cierra todas las sesiones de esa cuenta.

### Seguridad

- Contraseñas con scrypt (N=32768, r=8, p=1, sal aleatoria) y comparación en tiempo constante; el hash no
  sale por la API ni por los logs.
- `POST /auth/login` responde siempre `401 "Credenciales incorrectas"` y limita intentos: 5 fallos por IP y correo
  y 20 por correo en 15 minutos (en memoria; con varias instancias del backend habría que moverlo a la base).
  Un tercero que conozca un correo puede bloquearlo 15 minutos con 20 intentos; es el costo de frenar la fuerza bruta.
- El bloqueo toma la IP de `X-Forwarded-For` (igual que el límite global): el proxy debe sobrescribirla.
- Si sospechas de una cuenta: cámbiale la contraseña (invalida sus sesiones) o inhabilítala.

### Verificación posterior al despliegue

1. `POST /auth/login` con una cuenta de prueba responde 201; con una clave errónea, 401.
2. Un Tesorero ve `GET /vouchers` (200) y recibe 403 en `GET /users`.
3. Google sigue funcionando para las cuentas existentes.
