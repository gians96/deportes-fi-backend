# Feature Specification: Proveedores de DNI configurables desde la plataforma

**Feature Branch**: `feat/proveedores-dni`

**Created**: 2026-10-13

**Status**: Reemplazada por `005-pool-tokens-dni` (2026-10-14): un solo token por proveedor se quedó corto. El modelo
`DniProviderConfig` y las rutas `/settings/dni-providers` se retiraron antes de desplegarse; se conserva este
documento como historial de la decisión.

**Input**: "Usar apiperu.dev para consultar el DNI y que sea configurable dentro de la plataforma:
guardado en la base de datos, visible y editable desde la web y dinámico, sin tener que recargar el
environment."
Origen: al completar el perfil, un usuario con rol `OTHER` recibió "No se pudo consultar el DNI"
porque Decolecta respondía `401 Apikey Required / Limit Exceeded` con el token del `.env`.

## Contexto

- Hoy `AcademicService.findByDni` consulta **solo Decolecta** con `DECOLECTA_TOKEN` del `.env`;
  cualquier fallo del proveedor deja al usuario sin forma de validar su DNI y el administrador no
  puede cambiar el token sin tocar el servidor.
- `API_UNDC` ya integra API Perú (`POST https://api.apiperu.dev/dni`, `Authorization: Bearer`,
  404 = no existe, 401 = token inválido) y guarda sus credenciales cifradas (AES-256-GCM con
  `INTEGRATION_SECRET_KEY`). Esta feature adopta el mismo criterio.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Configurar proveedores de DNI desde el panel (Priority: P1)

Un administrador (OWNER o ADMIN) ve los proveedores **Decolecta** y **API Perú** con su estado,
carga o cambia el token y la URL, los activa o desactiva y define cuál se consulta primero. Todo se
guarda **en la base de datos** (nada en variables de entorno); los tokens van cifrados y **nunca** se
devuelven.

**Independent Test**: guardar un token, comprobar que el listado muestra solo una máscara
(`••••abcd`), que en la base queda cifrado y que borrarlo devuelve al token del `.env`.

**Acceptance Scenarios**:

1. **Given** un administrador, **When** guarda un token para API Perú, **Then** responde el proveedor
   con `configured: true`, `tokenMask` y estado `UNVERIFIED`, sin el token.
2. **Given** un cambio hecho desde la plataforma (token, URL, prioridad o activación), **When** se
   consulta el siguiente DNI, **Then** ya rige, **sin reiniciar el servidor**.
3. **Given** un token guardado, **When** el administrador lo borra, **Then** el proveedor queda sin
   configurar. Un `DECOLECTA_TOKEN` o `APIPERU_TOKEN` del entorno **se ignora**.
4. **Given** que el servidor no tiene `INTEGRATION_SECRET_KEY` ni `JWT_SECRET`, **When** se intenta
   guardar un token, **Then** responde 503 y no se guarda nada. Sin la primera, la clave se deriva de
   `JWT_SECRET` y todo funciona sin tocar el entorno.
5. **Given** un usuario sin rol OWNER/ADMIN o sin sesión, **When** llama a cualquier ruta, **Then**
   recibe 403 o 401.

### User Story 2 - Consultar el DNI con respaldo automático (Priority: P1)

Al validar un DNI, el sistema recorre los proveedores **activos y con token** por prioridad. Si uno
falla (token inválido, límite, caída), prueba el siguiente; si uno responde que el DNI no existe,
termina con "no encontrado".

**Acceptance Scenarios**:

1. **Given** Decolecta con un token inválido (401) y API Perú válido, **When** se consulta un DNI,
   **Then** se responde con los datos de API Perú y el estado de Decolecta pasa a `INVALID`.
2. **Given** un proveedor que responde 404, **When** se consulta, **Then** responde "no se encontró"
   sin probar los demás.
3. **Given** todos los proveedores fallan, **When** se consulta, **Then** responde 502
   `"No se pudo consultar el DNI"` (o `"Servicio de consulta por DNI no disponible"` si fue por red).
4. **Given** ningún proveedor activo con token, **When** se consulta, **Then** responde 503
   `"El servicio de consulta por DNI no está configurado"`.
5. **Given** un DNI que no tiene 8 dígitos, **When** se consulta, **Then** responde sin llamar a
   ningún proveedor.

### User Story 3 - Probar un proveedor (Priority: P2)

El administrador prueba un proveedor con un DNI y ve si respondió bien, sin que la respuesta traiga
datos personales; el resultado actualiza el estado del proveedor (`VALID` / `INVALID`).

## Requirements *(mandatory)*

- **FR-001**: Tabla `DniProviderConfig` (una fila por proveedor: `DECOLECTA`, `APIPERU`) con
  `enabled`, `priority` (menor = primero), token cifrado (`tokenCipher/tokenIv/tokenTag`),
  `tokenLast4`, `state` (`UNVERIFIED|VALID|INVALID`), `lastError`, `lastCheckedAt`, `updatedById`.
- **FR-002**: Cifrado AES-256-GCM. Clave: `INTEGRATION_SECRET_KEY` (32 bytes en base64 o 64 hex) si
  existe; si no, derivada de `JWT_SECRET` con HKDF. Sin ninguna no se guarda un token y nunca hay
  texto plano. Cambiar la clave obliga a volver a ingresar los tokens (los guardados dejan de usarse).
- **FR-003**: Toda la configuración vive en la base: token, `apiUrl` (nula = URL oficial),
  prioridad y activación. No se leen tokens ni URLs de variables de entorno. Se consulta en cada
  consulta, sin caché: un cambio rige de inmediato.
- **FR-004**: Prioridad por defecto: Decolecta 0, API Perú 1. Solo entran en la cadena los activos
  con token guardado.
- **FR-005**: Clasificación de respuestas: 200 válido → encontrado; 404 → no encontrado; 401/403 →
  credencial inválida o límite (`INVALID`); 429 → límite; 5xx, red, tiempo agotado o contrato
  inválido → no disponible. Solo 404 detiene la cadena.
- **FR-006**: Cada consulta real actualiza `state`, `lastError` y `lastCheckedAt` del proveedor.
- **FR-007**: Rutas admin: `GET /settings/dni-providers`, `PUT /settings/dni-providers/:provider`,
  `POST /settings/dni-providers/:provider/test`. Ninguna respuesta incluye tokens ni datos
  personales; los errores de negocio van en español.
- **FR-008**: `GET /academic/dni` y `PATCH /auth/me/profile` usan la misma cadena.
- **FR-009**: Migración aditiva revisada a mano; `.env.example` ya no trae `DECOLECTA_*` y
  documenta `INTEGRATION_SECRET_KEY` como opcional.

## Success Criteria

- **SC-001**: Con el token de Decolecta inválido y API Perú configurado desde la plataforma, un
  usuario `OTHER` completa su perfil sin cambiar el servidor.
- **SC-002**: Ninguna respuesta, log ni consulta expone un token; en la base solo hay texto cifrado.

## Supuestos y fuera de alcance

- Las consultas de estudiantes por código (SIVIRENO) no cambian.
- No se guarda histórico de consultas ni consumo de cuota; solo el último estado de cada proveedor.
- Rotación de `INTEGRATION_SECRET_KEY` (re-cifrado) queda fuera de alcance.

## Evidencia de verificación (2026-10-13)

- `bun run test`: suite completa en verde; 87 pruebas nuevas (cifrado y derivación de clave, clientes
  de ambos proveedores con todos los códigos HTTP, servicio de configuración, cadena de respaldo).
  Las specs usan una configuración falsa porque el `ConfigService` real cae a `process.env`, donde
  Prisma ya cargó el `.env`.
- Migración aplicada a una base local y `prisma migrate diff` sin diferencias.
- Prueba de humo con la API compilada, una base temporal y proveedores simulados (Decolecta
  rechazando con 401): sin tokens ni URLs en el entorno se cargan desde la API; la consulta cae a API
  Perú; un usuario `OTHER` completa su perfil; reemplazar el token por uno incorrecto, volver al
  correcto, reordenar prioridades y restablecer la URL rigen **en el mismo proceso**. Un
  `DECOLECTA_TOKEN`/`APIPERU_TOKEN` del entorno nunca llegó a un proveedor; no hay tokens en claro en
  la base, en las respuestas ni en el log; un estudiante recibe 403.
- Pendiente fuera de esta feature: cargar los tokens reales desde el panel al desplegar.
