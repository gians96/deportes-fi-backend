# Runbook — Edición manual de inscripciones y estado «Observado» (spec 007)

## Migración

Una migración aditiva (Prisma la aplica con `prisma migrate deploy`):

- `20261024120000_estado_observado`: agrega `OBSERVED` al final del `ENUM Team.status` y la columna `Team.observation`
  (`TEXT` nula). Ningún equipo existente cambia.

```sql
ALTER TABLE `Team` MODIFY `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'DRAFT', 'OBSERVED') NOT NULL DEFAULT 'PENDING';
ALTER TABLE `Team` ADD COLUMN `observation` TEXT NULL;
```

**Orden de despliegue**: respaldo de la base → migración → backend → frontend. La migración va **antes** del backend nuevo:
el código lee `Team.observation` y escribe `OBSERVED`; sin la migración, `GET /registrations` y los grupos fallarían.
El frontend viejo contra el backend nuevo sigue funcionando (solo vería el estado `OBSERVED` como «Pendiente»).

**Reversa**: restaurar el respaldo. No hay migración inversa: si hubiera equipos en `OBSERVED`, un `ENUM` sin ese valor los
rechazaría; antes de volver atrás hay que pasarlos a otro estado (`UPDATE Team SET status = 'PENDING' WHERE status =
'OBSERVED'`) y recién entonces quitar el valor y la columna.

> **Nunca** ejecutar la migración, `db push` ni seeds contra producción desde un entorno local. En producción se aplica
> desde el servidor/Dokploy con la `DATABASE_URL` de producción. En local se ensaya contra MariaDB en Docker
> (`deportes-mariadb`, `localhost:3311`, base `deportes_fi`). Probada en MariaDB local; ensáyala con un respaldo antes de
> producción (igual que las migraciones anteriores).

## Qué cambia para los usuarios

- **Owner/Administrador** (Admin → Inscripciones → abrir un equipo, en cualquier estado):
  - **Cambiar estado** a Pendiente, Aprobado, Rechazado, Observado o Cancelado (Rechazado y Observado piden un motivo).
    Sirve para deshacer un «Aprobar» o un «Rechazar» equivocado.
  - **Editar equipo**: nombre, celular, delegado, ciclo y sección (equipos fuera de un salón), y cada jugador (nombre,
    código, DNI, género, capitán).
  - **Comprobante**: «Volver a pendiente» (deshace validar/rechazar; los equipos aprobados con él vuelven a pendiente) y
    corregir N.º de operación y monto.
  - **Eliminar inscripción** (definitivo, con confirmación). Se bloquea si el equipo ya figura en el fixture.
- **Delegado**: un equipo **Observado** muestra la observación; lo corrige (nombre, celular, jugadores) y lo **reenvía** (pasa
  a Pendiente), aunque el plazo o el evento ya estén cerrados. Conserva su cupo y su comprobante.
- **Tesorero**: ve los equipos observados (solo lectura). No gana ninguna acción nueva.
- **Congreso (Contrato 2)**: un equipo observado se cuenta y se lista como `PENDING`; las respuestas no cambian de forma.

## Operación

- Restaurar un equipo **rechazado** o **cancelado** de un salón o ciclo le devuelve el menor cupo libre de la disciplina. Si
  ese cupo es el adicional (≥ 2) y el equipo lo cubría el pago base, la API responde `400`: hay que liberar el cupo base
  (eliminar o rechazar el otro equipo) o registrar uno adicional con su comprobante.
- Pasar a pendiente un equipo que ya tiene partidos **no** toca el fixture ni la tabla de posiciones ya generados; los
  nuevos cálculos solo consideran equipos `APPROVED`.
- Corregir el monto de un comprobante a mano es la única excepción a «los montos los calcula el servidor»; el cambio no se
  refleja en `EventPricing` ni recalcula otros comprobantes.
- Al eliminar un equipo se conservan los comprobantes ya revisados (el dinero recibido sigue registrado en el Contrato 2);
  solo se borra un comprobante adicional que seguía `PENDING` y se quedó sin equipos.
