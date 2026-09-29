# Research: Tokens API por evento

Decisiones técnicas tomadas antes de implementar. Cada una indica la alternativa descartada.

## D1. Formato del token

- **Decisión**: `dfi_` + base64url (sin relleno) de 32 bytes de `crypto.randomBytes` → 47
  caracteres (`/^dfi_[A-Za-z0-9_-]{43}$/`).
- **Por qué**: 256 bits de entropía; el prefijo `dfi_` permite detectarlo en escáneres de
  secretos y validar el formato antes de tocar la base.
- **Descartado**: UUID v4 (122 bits, sin prefijo identificable).

## D2. Almacenamiento: HMAC-SHA256 con pepper

- **Decisión**: `tokenHash = HMAC-SHA256(API_TOKEN_PEPPER, token)` en hex (64 caracteres) con
  índice único; búsqueda directa por hash.
- **Por qué**: principio transversal 2 del ecosistema; un volcado de la base no permite usar ni
  verificar tokens sin el pepper. Al ser tokens de alta entropía no hace falta un KDF lento
  (bcrypt/argon2), y el hash determinista permite la búsqueda indexada.
- **Descartado**: bcrypt (no indexable, obliga a buscar por prefijo y comparar lento); guardar el
  token cifrado (reversible, innecesario).

## D3. Prefijo visible (`tokenPrefix`)

- **Decisión**: los primeros 12 caracteres del token (`dfi_` + 8 caracteres), único en la base.
  Revela 48 de 256 bits; quedan ~208 bits secretos. Ante colisión (error P2002) se regenera
  (máx. 3 intentos).
- **Por qué**: permite al administrador reconocer qué token está configurado en el consumidor.

## D4. Pepper obligatorio en producción

- **Decisión**: `API_TOKEN_PEPPER` se lee al iniciar. En `NODE_ENV=production` sin pepper se
  registra un **error** y las operaciones de tokens (crear y validar) responden **503**; el resto
  de la API sigue funcionando. En desarrollo/pruebas se deriva
  `SHA-256("deportes-fi:api-token-pepper:" + JWT_SECRET)` y se registra una advertencia. Si el
  pepper tiene menos de 32 caracteres se advierte.
- **Por qué**: "obligatorio" sin tumbar el despliegue completo del sistema de inscripciones por
  una variable que solo usa este feature; el fallo es explícito (503 + log) y no silencioso.
- **Descartado**: abortar el arranque (una variable olvidada dejaría sin servicio a toda la
  plataforma); usar `JWT_SECRET` en producción (acopla la rotación de ambos secretos).
- **Consecuencia**: cambiar el pepper invalida todos los tokens existentes (hay que emitirlos de
  nuevo).

## D5. Guard independiente del JWT

- **Decisión**: `EventTokenGuard` propio (`src/common/guards/event-token.guard.ts`) aplicado con
  `@UseGuards` al controlador de integraciones. No existe un guard JWT global en el proyecto
  (solo `AppRateLimitGuard` como `APP_GUARD`), así que no hace falta marcar rutas como públicas.
- **401 exacto**: se lanza `new UnauthorizedException({ statusCode: 401, message })` para que
  Nest devuelva el objeto tal cual (con un string, Nest agregaría `"error": "Unauthorized"`).
- **Contexto**: el guard adjunta `request.eventToken = { tokenId, eventId }` y el decorador
  `@CurrentEventToken()` lo expone; si falta, el decorador falla cerrado con el mismo 401.
- **`lastUsedAt`**: actualización *fire-and-forget* (`void …catch(log)`), a lo sumo una vez por
  minuto por token para no generar una escritura por solicitud.

## D6. Agregación del resumen

- **Decisión**: dos consultas acotadas por `eventId` (disciplinas del evento y equipos del evento
  con `_count.participants` y su voucher) y agregación en memoria con `Prisma.Decimal`.
- **Por qué**: `groupBy` de Prisma no agrupa a través de relaciones (voucher → team →
  discipline); el volumen por evento es de cientos de filas; se evita SQL crudo y los problemas
  de `BigInt`/`Decimal` de `$queryRaw`. `Decimal` evita errores de coma flotante; el resultado se
  convierte con `Number(x.toFixed(2))`.
- **Descartado**: `$queryRaw` con `GROUP BY` (más rápido a gran escala, pero más frágil y
  difícil de probar sin base real).

## D7. Paginación y validación de filtros

- **Decisión**: DTOs de consulta con `class-validator`: `status` con `@IsEnum`, `page` entero
  ≥ 1 (por defecto 1), `pageSize` entero 1–100 (por defecto 50). Valores inválidos → 400 con el
  formato estándar de validación de Nest. Listado + conteo en `$transaction` para un `total`
  coherente.
- **Orden**: pagos por `uploadedAt desc, id desc`; inscripciones por `createdAt desc, id desc`
  (mismo criterio que los listados admin existentes).
- **Descartado**: recortar silenciosamente `pageSize` a 100 (oculta errores del consumidor).

## D8. Semántica de estados de pago

- **Decisión**: los pagos se clasifican por `Voucher.status` únicamente (contrato: "Recaudado =
  suma de `Voucher.amount` con `status = VALIDATED`").
- **Riesgo conocido**: rechazar un equipo con `PATCH /registrations/:id/reject` no cambia su
  voucher; un voucher PENDING de un equipo rechazado sigue sumando en `pending`. Se deja
  documentado como pregunta abierta para el congreso en lugar de inventar una regla distinta al
  contrato.

## D9. Sin datos sensibles

- **Decisión**: todos los endpoints de integración usan `select` explícitos y un mapeo a objetos
  nuevos (nunca `...spread` de entidades). No se leen `imageUrl`, `phone`, correos, DNI ni
  códigos. Las pruebas usan un *fake* que sí contiene esos campos para detectar fugas.
