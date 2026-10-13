# Runbook — Borradores de equipo, un salón por alumno y DNI automático (spec 006)

## Migraciones

Dos migraciones aditivas, en este orden (Prisma las aplica con `prisma migrate deploy`):

1. `20261014140000_borrador_de_equipos`: agrega `DRAFT` al final del `ENUM Team.status`. Ningún equipo cambia.
2. `20261014150000_config_api_undc`: crea `UndcApiConfig` (vacía: no hay conexión hasta que un administrador la guarde).

Despliegue: respaldo de la base → migraciones → backend → frontend. Reversa: restaurar el respaldo (no hay migración
inversa; si hubiera equipos en `DRAFT`, un `ENUM` sin ese valor los rechazaría).

> Probadas en MySQL 8.0.30. **MariaDB 11 sin probar** (igual que las migraciones anteriores): ensáyalas antes de producción.

## Qué cambia para los usuarios

- El delegado guarda cada equipo como **borrador**, lo edita y lo **envía**. El tesorero solo ve equipos enviados.
- El administrador (Owner/Administrador) edita nómina, nombre y celular de cualquier equipo, también aprobado.
- Un estudiante inscribe **un** salón o ciclo por evento; el administrador crea más a nombre de otros. Los equipos
  adicionales por disciplina siguen igual (S/ 20 por salón, S/ 30 por ciclo, con comprobante propio).
- Un equipo **rechazado** sigue siendo definitivo: el delegado registra uno nuevo (su cupo ya quedó libre).

## Activar el DNI automático

1. **API_UNDC (JP)** con el cambio `API_UNDC/specs/004-consulta-estudiante` desplegado.
2. **SIGENET → Configuraciones → Integraciones**: cargar una **sesión SIVIRENO vigente** (cookie `PHPSESSID`). Sin ella
   API_UNDC no puede leer el DNI de alumnos que aún no tiene guardado.
3. **SIGENET → Clientes API → Nuevo cliente** («Deportes FI») con el permiso `estudiantes:consultar`; copiar el token
   `undc_…` (se muestra una sola vez).
4. **Deportes FI → Admin → Integraciones → Padrón de estudiantes**: URL `https://api-jp.episundc.pe`, la API key y
   **Probar** (usa un código inexistente: no gasta datos personales).
5. Buscar un alumno por código en el formulario de equipo: el DNI debe aparecer solo.

### Operación

- Sin conexión, desactivada, con la key rechazada o con JP caído: la búsqueda cae a la pública de SIVIRENO (sin DNI) y el
  delegado lo escribe. La pantalla de Integraciones muestra el último error de la conexión.
- La cookie SIVIRENO vence: el DNI solo faltará en alumnos nuevos; los ya consultados quedan guardados en el espejo de JP.
- Cambiar `INTEGRATION_SECRET_KEY` (o `JWT_SECRET` si no hay clave dedicada) invalida la API key guardada: volver a
  pegarla (el panel lo avisa: «no se pudo descifrar la API key guardada»).
- El DNI nunca se registra en logs; la API key tampoco.
- Rotar la key: crear una nueva en SIGENET, pegarla en Deportes FI y revocar la anterior.
