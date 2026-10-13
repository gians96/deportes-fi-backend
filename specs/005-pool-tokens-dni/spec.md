# Feature Specification: Pool de tokens para la consulta de DNI, con caché

**Feature Branch**: `feat/pool-tokens-dni`

**Created**: 2026-10-14

**Status**: Implementada en el backend (2026-10-14); la pantalla se especifica en `frontend/specs/005-*`. Reemplaza el diseño de la spec 003

**Input**: "Integraciones: hoy solo se admiten Decolecta y API Perú como filas fijas. Que sea una gestión de cada uno
de ellos, poder agregar más; si uno falla o se acaban las consultas, poder agregar más tokens del mismo proveedor
y que se administren por prioridad: si uno falla, sigue con el siguiente. Hazlo igual que
admin-ciisic.episundc.pe/consultas y que cachee las consultas."

## Contexto

- La spec 003 dejó **una fila por proveedor** (`DniProviderConfig`): un solo token de Decolecta y uno de API Perú.
  Si ese token se agota o falla, el proveedor queda inutilizable hasta que alguien cambie el token.
- El panel del congreso (`backend-ciisic`, `src/api/document-lookup`) ya resolvió esto con un **pool de tokens**:
  cada token tiene alias, prioridad, límite de consultas, renovación y estado, y hay caché y bitácora. Esta feature
  adopta el mismo diseño en deportes-fi.
- La spec 003 no se desplegó nunca (sin push), así que se puede reemplazar sin compatibilidad.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Administrar varios tokens (Priority: P1)

Un administrador (OWNER o ADMIN) ve la lista de tokens (de Decolecta y de API Perú, varios por proveedor), agrega,
edita, pausa, reactiva, reinicia y elimina tokens, y define la **prioridad** de cada uno (menor número = primero).
Todo se guarda en la base de datos, cifrado, y rige en la siguiente consulta sin reiniciar nada.

**Acceptance Scenarios**:

1. **Given** un token nuevo, **When** se guarda, **Then** se lista con una máscara (`••••abcd`), estado `ACTIVE` y sin
   exponer el valor; el token nunca se devuelve.
2. **Given** dos tokens del mismo proveedor, **When** el primero (menor prioridad) falla con 401, **Then** se marca
   `INVALID` y la consulta sigue con el segundo.
3. **Given** un token con límite de consultas, **When** se alcanza el límite, **Then** pasa a `EXHAUSTED` y las
   consultas siguientes usan el próximo; al llegar su fecha de renovación vuelve a `ACTIVE` con el contador en 0.
4. **Given** un proveedor que responde 429 o 402, **Then** el token queda `EXHAUSTED` aunque no tenga límite local.
5. **Given** un token pausado (`enabled = false`), `INVALID` o `EXHAUSTED`, **Then** no se consulta hasta reactivarlo,
   reiniciarlo, renovarlo o reemplazar su valor.
6. **Given** un error transitorio (red caída, 5xx, tiempo agotado), **Then** el token no cambia de estado (solo
   registra el último error) y se prueba el siguiente.

### User Story 2 - Consulta con caché y respaldo (Priority: P1)

Al validar un DNI se consulta primero la **caché** (30 días); si no está, se recorren los tokens disponibles por
prioridad. Si un proveedor dice que el DNI no existe, se prueba **un token del otro proveedor** antes de responder
"no existe" (así lo hace el congreso).

**Acceptance Scenarios**:

1. **Given** un DNI consultado hace menos de 30 días, **When** se vuelve a consultar, **Then** responde desde la caché
   sin llamar a ningún proveedor ni gastar el cupo.
2. **Given** que ningún token está configurado, **Then** 503 "El servicio de consulta por DNI no está configurado".
3. **Given** tokens pero ninguno disponible, **Then** 503 "El servicio de consulta por DNI no está disponible por el
   momento".
4. **Given** que todos los tokens disponibles fallan, **Then** 502 "No se pudo consultar el DNI" (algún token fue
   rechazado) o "Servicio de consulta por DNI no disponible" (solo fallas transitorias).
5. **Given** un DNI que ningún proveedor encuentra, **Then** `null` (el controlador responde 404).

### User Story 3 - Probar, consultar y auditar (Priority: P2)

El administrador **prueba** un token con un DNI (gasta una consulta real; no se muestran datos personales), hace una
**consulta manual** con el pool y la caché, ve el **uso de los últimos 30 días** y una **bitácora** con el DNI
enmascarado (`76****07`), y puede **vaciar la caché**.

## Requirements *(mandatory)*

- **FR-001**: Modelo `DniToken` (proveedor, alias, token cifrado AES-256-GCM, `tokenLast4`, `apiUrl?`, `priority`,
  `enabled`, `state` `ACTIVE|EXHAUSTED|INVALID`, `queryLimit?`, `queriesUsed`, `renewalPeriod`
  `DAILY|MONTHLY|YEARLY|NONE`, `renewsAt?`, `lastError?`, `lastUsedAt?`, `exhaustedAt?`). La clave sale de
  `INTEGRATION_SECRET_KEY` o, si falta, de `JWT_SECRET` (como en la spec 003); nunca se guarda en la base.
- **FR-002**: Solo se consultan tokens `enabled` con `state = ACTIVE` y límite no alcanzado, por `priority` y luego
  `id`. La renovación es perezosa e idempotente: al seleccionar tokens se renuevan los vencidos
  (`queriesUsed = 0`, `ACTIVE` salvo `INVALID`, siguiente `renewsAt` conservando el día del ciclo).
- **FR-003**: Clasificación: 200 con nombre → encontrado; 404 → no existe en ese proveedor; 401/403 → `INVALID`;
  429/402 → `EXHAUSTED`; 5xx, red, tiempo agotado o contrato inesperado → transitorio.
- **FR-004**: Cada consulta real suma 1 al contador (encontrado o no existe) de forma atómica y marca `EXHAUSTED` al
  alcanzar `queryLimit`. Un token nuevo o con valor reemplazado vuelve a `ACTIVE` con el último error limpio.
- **FR-005**: `DniPersonCache(dni, fullName, provider, fetchedAt)`: solo DNI y nombre; vigencia de 30 días
  (`DNI_CACHE_DAYS`); una entrada vencida es un fallo de caché y se sobrescribe. `DELETE /settings/dni-tokens/cache` la
  vacía.
- **FR-006**: `DniLookupLog` registra cada consulta (token, proveedor, DNI enmascarado, resultado, HTTP, duración,
  origen `PROFILE|ROSTER|PANEL`, detalle de hasta 300 caracteres). Un fallo al registrar nunca rompe la consulta. Al
  eliminar un token su historial se conserva sin el token.
- **FR-007**: Rutas (OWNER/ADMIN, nunca devuelven tokens ni datos personales salvo la consulta manual): `GET`/`POST`
  `/settings/dni-tokens`, `PATCH`/`DELETE` `/settings/dni-tokens/:id`, `POST :id/reset`, `POST :id/test`, `GET usage`,
  `GET logs`, `POST lookup`, `DELETE cache`. Reemplazan `/settings/dni-providers` de la spec 003.
- **FR-008**: `AcademicService.findByDni(dni, origin)` usa el pool; `GET /academic/dni` es `ROSTER` y el perfil es
  `PROFILE`. Mensajes de error en español.
- **FR-009**: Migración `20261014130000_pool_tokens_dni`: crea las tres tablas, **copia** a `DniToken` las filas con
  token de `DniProviderConfig` (mismo cifrado, mismo valor) y elimina la tabla antigua.

## Casos límite

- Token que no se puede descifrar (se cambió `JWT_SECRET`/`INTEGRATION_SECRET_KEY`): se marca `INVALID` con
  "No se pudo descifrar: vuelve a ingresarlo" y se sigue con el siguiente.
- El límite local se baja por debajo de lo usado: el token queda `EXHAUSTED` al guardar.
- DNI que no tiene 8 dígitos: no se consulta a nadie.

## Success Criteria

- **SC-001**: Con dos tokens de Decolecta y el primero agotado, un usuario completa su perfil sin intervención.
- **SC-002**: Repetir un DNI dentro de 30 días no gasta cupo.
- **SC-003**: Ninguna respuesta, log ni consulta expone un token; la bitácora solo trae DNI enmascarados.

## Supuestos y fuera de alcance

- No hay proveedor «personalizado»: un proveedor nuevo se agrega al catálogo (`dni-provider.catalog.ts` y su cliente
  en `dni-lookup.ts`) cuando haya su documentación.
- La caché guarda DNI y nombre durante 30 días; se puede vaciar. La bitácora no se purga automáticamente.
- Rotación de la clave de cifrado fuera de alcance: cambiarla obliga a volver a ingresar los tokens.

## Evidencia de verificación

- `bun run test`: suite completa en verde (435 pruebas; 27 suites). Nuevas: renovación (fin de mes, bisiesto,
  anual), `DniTokensService` (alta con cifrado y máscara, prioridades de 10 en 10, varios tokens por proveedor,
  límite que agota o reactiva, URL vacía = oficial, reinicio, renovación perezosa e idempotente, contador atómico) y
  `DniLookupService` (caché de 30 días con vigencia, respaldo entre tokens del mismo proveedor, 401 → inválido,
  429/402 → agotado, 5xx sin cambio de estado, agotamiento por límite local, 404 cruzado entre proveedores, 503/502
  con sus mensajes, token que no se puede descifrar, bitácora que no rompe la consulta, uso por día en hora de Lima,
  historial que sobrevive al borrado del token, ningún token en errores ni bitácora). `tsc --noEmit` y `nest build`
  sin errores; ESLint sin errores en los archivos tocados.
- Migración aplicada a la base local con una fila de la spec 003 de ejemplo: se copió a `DniToken` (mismo cifrado,
  prioridad y estado) y `DniProviderConfig` se eliminó; `prisma migrate diff`: "No difference detected".
- Prueba de humo con la API compilada, la base local y proveedores simulados: sin tokens, la consulta responde 503
  "no está configurado"; se crean 4 tokens (dos de Decolecta con uno rechazado, uno con límite 2 y uno de API Perú) y
  el listado no contiene ningún valor de token ni campo cifrado. Consultando como estudiante: el token rechazado
  pasa a `INVALID` y se usa el siguiente; repetir el DNI sale de la caché (el proveedor no recibe la llamada); al
  llegar al límite el token queda `EXHAUSTED` y pasa al siguiente; un DNI que Decolecta no conoce (404) se resuelve
  con un token de API Perú; uno que ninguno conoce responde 404. «Probar» el token rechazado → `unauthorized` y
  `INVALID`; «Reiniciar» → `ACTIVE` con 0 usadas; la consulta manual usa la caché, «Vaciar caché» borra 4
  entradas y la siguiente consulta vuelve al proveedor. La bitácora trae 14 filas con DNI enmascarado, sin nombres
  ni DNI completos. El Tesorero y el estudiante reciben 403 y la ruta antigua `/settings/dni-providers`, 404.
- Pendiente: probar contra Decolecta y API Perú reales (hace falta un token propio), y la migración en MariaDB 11.
