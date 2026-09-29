# Overview — Backend

## 1. Qué hace

Expone la API que da soporte al sistema de gestión deportiva de la Facultad de
Ingeniería de la UNDC. Sus responsabilidades principales son:

- **Autenticación con Google** y emisión de JWT. Los correos `@undc.edu.pe`
  numéricos son `STUDENT`; los demás correos verificados por Google son `OTHER`.
- **Catálogo académico**: facultades y escuelas profesionales (CRUD).
- **Eventos deportivos** y **disciplinas** configurables (modalidad por equipos o
  individual, política de género, formato de competencia, **tipo de participante**
  estudiante/externo, mín/máx de jugadores, límite de equipos, costo/gratuidad,
  fecha límite de inscripción, bases).
- **Inscripciones de equipos**: un delegado (o un admin/owner manualmente) crea un
  equipo, agrega integrantes validados según el tipo de disciplina —contra el
  padrón SIVIRENO (estudiantes) o RENIEC vía Decolecta por DNI (`OTHER`)— y, si
  la disciplina es pagada, adjunta el comprobante (voucher). Cada integrante se
  vincula automáticamente a su usuario real (`Participant.userId`) por código o
  DNI.
- **Validación de vouchers** por administradores dentro del flujo único de
  inscripciones.
- **Gestión de usuarios y roles** (`OWNER_SYSTEM`, `ADMIN_SYSTEM`, `STUDENT`,
  `OTHER`),
  incluyendo pre-registro por correo e inhabilitación lógica (`isActive`).
- **Resultados, posiciones y partidos** (modelo listo en BD; ver roadmap).
- **Dashboard** con métricas agregadas para el panel admin.
- **Rate limit global por IP** para proteger toda la API ante uso abusivo.

## 2. Qué se quiere lograr

Un backend desplegable de forma **independiente** (servicio propio en Dokploy,
sin docker-compose) que consuma una **MariaDB externa** por `DATABASE_URL` y sirva
tanto al frontend Nuxt como a integraciones futuras, manteniendo reglas de negocio
y seguridad en el servidor (no confiar en el cliente).

## 3. Lo planteado (roadmap)

### Implementado
- Auth Google + JWT, guard de roles y `@CurrentUser`.
- Módulos: `auth`, `users`, `faculties`, `events`, `disciplines`,
  `registrations`, `vouchers`, `standings`, `admin`, `academic`.
- Reglas de inscripción: fecha límite, mín/máx jugadores, política de género,
  **duplicados de integrantes** por código/DNI, límite de equipos, voucher
  obligatorio si la disciplina es pagada.
- Validación de integrantes según `participantType`: SIVIRENO (`STUDENT`) o
  RENIEC/Decolecta (`OTHER`), y vínculo automático `User ↔ Participant`.
- Perfil diferenciado: `STUDENT` completa facultad/escuela; `OTHER` completa
  solo DNI validado con Decolecta.
- Creación **manual** de equipos por owner/admin (`delegateId` opcional).
- Gestión de usuarios: crear (pre-registro), editar, cambiar rol, habilitar /
  inhabilitar (`isActive`, validado en `JwtStrategy`).
- Filtros de disciplinas por `eventId` / `facultyId` / `schoolId`.
- Rate limit global por IP configurable desde variables de entorno.
- **Tokens de integración por evento** (hash HMAC con pepper, revocables y con
  expiración) y endpoints de solo lectura `/integrations/event/*` para el backend
  del congreso (Contrato 2 del ecosistema CIISIC).

### Pendiente / futuro
- Módulo de **partidos** (`Match`) y avance de brackets para formato
  `ELIMINATION` (modelo en BD, faltan endpoints de generación/avance).
- Registro de **resultados** que alimente `Standing` en formato `POINTS`.
- Reportes/exportaciones (PDF/Excel).
- Migrar el JWT a **cookie httpOnly** emitida por el backend (hoy el token viaja
  como Bearer y el frontend lo guarda en cookie de Nuxt).
- Almacenamiento de vouchers en S3 compatible (hoy disco local `uploads/`).

## 4. Convenciones

- Prefijo global `/api/v1`.
- DTOs validados con `class-validator`; `ValidationPipe` global con whitelist.
- Errores de negocio → `BadRequestException` / `ForbiddenException` /
  `NotFoundException` con mensaje en español.
- Reglas de autorización finas dentro del *service* recibiendo el `actor`
  (`@CurrentUser()`), no solo en el guard.
