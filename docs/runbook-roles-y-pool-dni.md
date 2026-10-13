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

## Spec 005 — Pool de tokens de consulta de DNI

### Migración `20261014130000_pool_tokens_dni`

Crea `DniToken`, `DniLookupLog` y `DniPersonCache`, **copia** a `DniToken` los tokens que hubiera en
`DniProviderConfig` (mismo cifrado; siguen siendo válidos con la misma clave) y elimina `DniProviderConfig`. La
spec 003 nunca se desplegó, así que en producción esa tabla no existe todavía: si la migración `20261013170000`
aún no se aplicó, Prisma las aplica en orden y el resultado es el mismo (la copia no encuentra filas).

Despliegue: aplicar la migración (`prisma migrate deploy`) y luego backend y frontend. Reversa: restaurar el
respaldo previo; la tabla antigua se elimina y no se recrea.

### Después de desplegar

1. Entra como Owner o Administrador a **Admin → Integraciones**.
2. **Agregar token** por cada cuenta de Decolecta o API Perú: alias, proveedor, token y —si lo conoces— límite de
   consultas y renovación (mensual, diaria, anual o ninguna) con su próxima fecha. Menor prioridad = se usa primero.
3. Pulsa **Probar** con un DNI real en cada uno (gasta una consulta). Un token rechazado queda «Inválido»; uno sin
   cupo, «Agotado».
4. Los tokens del `.env` (`DECOLECTA_*`, `APIPERU_*`) ya no se leen: hay que cargarlos una vez en el panel.

### Operación

- **Un token falla o se agota**: la consulta sigue con el siguiente por prioridad, sin intervención. Agrega otro
  token del mismo proveedor cuando quieras más capacidad. «Reiniciar» devuelve un token a «Activo» con el contador en
  0 (úsalo si el proveedor renovó tu plan antes de la fecha).
- **Sin tokens disponibles**: la inscripción por DNI responde 503 y el usuario debe esperar o escribir sus datos si
  el flujo lo permite. El aviso rojo del panel lo indica.
- **Caché**: los nombres consultados se reutilizan 30 días (no gastan cupo). «Vaciar caché» la borra (por ejemplo si
  RENIEC corrigió un nombre). Guarda solo DNI y nombre.
- **Bitácora**: guarda el DNI enmascarado, el resultado y el origen; no se purga sola. Si crece demasiado, bórrala
  con SQL (`DELETE FROM DniLookupLog WHERE createdAt < ...`).
- **Cambiaste `JWT_SECRET` o `INTEGRATION_SECRET_KEY`**: los tokens guardados ya no se pueden descifrar; cada uno se
  marca «Inválido» («No se pudo descifrar…») al intentar usarlo. Vuelve a ingresarlos. Para evitarlo en producción
  define `INTEGRATION_SECRET_KEY` (32 bytes en base64 o 64 hex) y no la cambies.
- Un DNI que ningún proveedor conoce cuesta una consulta en cada proveedor antes de responder «no existe».
