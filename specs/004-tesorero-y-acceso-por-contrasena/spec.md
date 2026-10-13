# Feature Specification: Rol Tesorero y acceso por contraseña

**Feature Branch**: `feat/tesorero-acceso`

**Created**: 2026-10-14

**Status**: Implementada en el backend (2026-10-14); la pantalla se especifica en `frontend/specs/004-*`

**Input**: "No tengo acceso como alumno, quiero hacer la prueba. Hay un tesorero; que tenga esos roles
(Owner, Administrador del sistema, Tesorero) y este inicio de sesión (Solo Google / Contraseña o
Google), como en el panel del congreso."

## Contexto

- Hoy solo se entra con Google. Los `STUDENT` son cuentas `@undc.edu.pe` numéricas; cualquier otra cuenta
  es `OTHER` y recibe "Solo los estudiantes pueden inscribir un salón o ciclo". No hay forma de crear una
  cuenta de prueba con rol estudiante ni de dar acceso a alguien sin Google.
- Validar pagos (comprobantes) exige hoy `OWNER_SYSTEM` o `ADMIN_SYSTEM`, que también pueden configurar el
  sistema. Se necesita un rol que solo vea y valide pagos.
- El panel del congreso (`backend-ciisic`) ya resolvió ambas cosas (roles con alcance y cuentas con
  contraseña opcional). Esta feature adopta el mismo criterio en deportes-fi.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cuenta con contraseña (Priority: P1)

Un Owner o Administrador crea una cuenta eligiendo rol y **Acceso**: «Solo Google» (como hoy) o
«Contraseña o Google». Con contraseña, la persona entra desde `/login` con correo y contraseña; sirve para
cuentas de prueba (por ejemplo un estudiante sin correo institucional) y para personal sin Google.

**Independent Test**: crear un `STUDENT` con contraseña, iniciar sesión con ella y crear un salón.

**Acceptance Scenarios**:

1. **Given** una cuenta con contraseña, **When** inicia sesión con correo y contraseña correctos, **Then**
   recibe `{ token, user }` igual que con Google.
2. **Given** correo inexistente, cuenta sin contraseña, cuenta inactiva o contraseña errónea, **When** intenta
   entrar, **Then** siempre responde `401 "Credenciales incorrectas"` (no revela cuál fue el motivo) y tarda
   lo mismo.
3. **Given** 5 intentos fallidos con el mismo correo desde la misma IP en 15 minutos, **When** intenta otra
   vez, **Then** responde 429 hasta que pase la ventana; un acceso correcto reinicia el contador.
4. **Given** una cuenta con contraseña, **When** un administrador la cambia o la quita, **Then** las sesiones
   emitidas antes dejan de valer (`tokenVersion`).
5. **Given** un estudiante creado con contraseña y un Gmail, **When** entra también con Google, **Then**
   conserva su rol (no se degrada a `OTHER`).
6. **Given** el hash de la contraseña, **Then** nunca sale por la API ni por los logs; el listado de usuarios
   solo trae `hasPassword` y `googleLinked`.

### User Story 2 - Rol Tesorero (Priority: P1)

El Tesorero ve el dashboard, los equipos y salones, y **valida o rechaza comprobantes**; no aprueba equipos ni
configura nada.

**Acceptance Scenarios**:

1. **Given** un Tesorero, **When** llama `GET /vouchers`, `PATCH /vouchers/:id/validate|reject`,
   `GET /registrations`, `GET /groups`, `GET /groups/:id` o `GET /admin/dashboard`, **Then** funciona.
2. **Given** un Tesorero, **When** llama a usuarios, eventos, disciplinas, facultades, tokens de evento,
   proveedores de DNI, programación o aprobar/rechazar equipos, **Then** recibe 403.
3. **Given** un Administrador, **When** crea o cambia a un Tesorero, **Then** puede; un Administrador sigue
   sin poder tocar a otros administradores ni al Owner.

## Requirements *(mandatory)*

- **FR-001**: `Role` suma `TREASURER`. `User` suma `passwordHash` (nulo = solo Google) y `tokenVersion`.
- **FR-002**: Contraseñas con scrypt (`node:crypto`, sin dependencias nuevas), sal aleatoria, comparación en
  tiempo constante y hash ficticio cuando la cuenta no existe. Largo 10 a 128 caracteres.
- **FR-003**: `POST /auth/login { email, password }` responde como `POST /auth/google`. Bloqueo por intentos
  (5 en 15 minutos por IP y correo) en memoria.
- **FR-004**: El JWT lleva `tv`; el servidor lo compara con `tokenVersion` (ausente = 0, así los tokens
  anteriores siguen valiendo). Cambiar o quitar la contraseña incrementa `tokenVersion`.
- **FR-005**: `POST /users` acepta `TREASURER` y `password` opcional; `PATCH /users/:id/password
  { password | null }`. Owner gestiona todo; Administrador gestiona `STUDENT`, `OTHER`, `REFEREE` y
  `TREASURER`. El Tesorero es un rol no académico (sin facultad ni código).
- **FR-006**: Permisos del Tesorero exactamente los de US2; una prueba lee los roles declarados en cada
  controlador y falla si el Tesorero gana o pierde un permiso sin querer.
- **FR-007**: Entrar con Google conserva el rol de una cuenta que tiene contraseña.
- **FR-008**: Migración aditiva revisada a mano (`ALTER ... MODIFY role ENUM` + 2 columnas); ninguna cuenta
  existente recibe contraseña.

## Casos límite

- Cuenta con contraseña que pasa a «Solo Google»: se borra el hash y se invalidan sus sesiones.
- Contraseña de otra longitud o con espacios al inicio/fin: se respeta tal cual (solo se valida el largo).
- Correo con mayúsculas: se compara en minúsculas.

## Success Criteria

- **SC-001**: Un administrador crea un estudiante de prueba con contraseña y esa persona inscribe un salón sin
  usar Google.
- **SC-002**: Un Tesorero valida un comprobante y no puede cambiar ninguna configuración.
- **SC-003**: Ni respuestas, ni logs, ni consultas exponen contraseñas o hashes.

## Supuestos y fuera de alcance

- Sin «Comisión tecnológica» (decisión del usuario). Sin recuperación de contraseña por correo: la define y la
  cambia un Owner/Administrador.
- El bloqueo por intentos vive en memoria (una instancia); con varias instancias habría que moverlo a la base.

## Evidencia de verificación (2026-10-14)

- `bun run test`: suite completa en verde (399 pruebas; 62 nuevas: scrypt, bloqueo por intentos, login con
  error único, `tv` en el JWT, rol conservado con Google, permisos de `UsersService` y la **matriz de roles**
  que lee `@Roles` de cada controlador). `tsc --noEmit` y `nest build` sin errores; ESLint sin errores nuevos
  en los archivos tocados (los errores de formato previos de otros archivos no se tocaron).
- Migración aplicada a la base local y `prisma migrate diff`: "No difference detected".
- Prueba de humo con la API compilada contra `deportes_fi_local`: un administrador crea un estudiante con
  contraseña (201, sin hash en la respuesta) y un tesorero; ambos entran con `POST /auth/login`; la contraseña
  corta se rechaza (400); el **estudiante con contraseña inscribe un salón** (`POST /groups` 201, voucher base de
  S/100 pendiente); el Tesorero obtiene 200 en `/vouchers`, `/registrations`, `/groups` y `/admin/dashboard` y
  403 en `/users`, `/settings/dni-providers`, `/events/1/api-tokens`, aprobar/rechazar equipos y crear eventos; el
  estudiante recibe 403 en zonas de administración; tras 5 claves erróneas el login responde 429 incluso con la
  clave correcta; correo inexistente responde el mismo 401; cambiar la contraseña invalida el JWT anterior (401) y
  quitarla deja `hasPassword: false`.
- Pendiente: probar el acceso con Google de una cuenta con contraseña contra Google real (solo con pruebas unitarias).
