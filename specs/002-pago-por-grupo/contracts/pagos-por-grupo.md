# Contrato — Pago por salón o ciclo (API propia)

Base `/api/v1`, JSON plano, errores de negocio en español. Todo con `JwtAuthGuard`. "Staff" =
`OWNER_SYSTEM` o `ADMIN_SYSTEM`. Es **aditivo**: lo no listado aquí no cambia.

## Tarifas del evento

### `GET /events/:eventId/pricing` (cualquier usuario autenticado)

```json
{ "eventId": 3, "pricingMode": "PER_GROUP", "sectionBase": 100, "cycleBase": 150, "sectionExtra": 20, "cycleExtra": 30 }
```

Evento sin configurar: `pricingMode: "PER_DISCIPLINE"` y las cuatro tarifas en `0`. 404 si el evento
no existe.

### `PUT /events/:eventId/pricing` (staff)

Cuerpo: `{ "pricingMode": "PER_GROUP", "sectionBase": 100, "cycleBase": 150, "sectionExtra": 20, "cycleExtra": 30 }`.
Tarifas ≥ 0 con hasta 2 decimales. 400 si se vuelve a `PER_DISCIPLINE` con grupos creados. Cambiar
tarifas no modifica vouchers existentes. Devuelve el mismo objeto del `GET`.

## Grupos

Forma de un grupo (`GroupDetail`):

```json
{
  "id": 12, "eventId": 3, "scope": "SECTION", "label": "Ingeniería de Sistemas · V · A1",
  "school": { "id": 1, "name": "Ingeniería de Sistemas" }, "cycle": "V", "section": "A1",
  "delegate": { "id": 40, "fullName": "…" },
  "baseVoucher": { "id": 77, "kind": "BASE", "status": "PENDING", "amount": 100, "operationNumber": "123", "imageUrl": "/uploads/vouchers/…", "rejectionReason": null },
  "disciplines": [
    { "disciplineId": 7, "name": "Futsal", "teams": [
      { "id": 301, "name": "Los Bits", "slot": 1, "status": "PENDING", "voucherId": 77 },
      { "id": 305, "name": "Los Bits B", "slot": 2, "status": "PENDING", "voucherId": 81 } ] }
  ],
  "extraVouchers": [ { "id": 81, "kind": "EXTRA", "status": "PENDING", "amount": 20, "operationNumber": "124", "imageUrl": "…", "rejectionReason": null, "teamIds": [305] } ]
}
```

### `POST /groups` (STUDENT o staff; multipart)

Campos: `eventId`, `scope` (`SECTION|CYCLE`), `schoolId`, `cycle` (texto libre), `section`
(texto libre; obligatoria si `SECTION`, ignorada si `CYCLE`), `operationNumber`, `voucher` (imagen,
obligatoria; mismas reglas de Multer que hoy). Staff puede enviar `delegateId`.

Respuesta 201: `GroupDetail`. Errores: 400 (evento no `PER_GROUP`, evento cerrado, ciclo/sección
inválidos, exclusión ciclo/sección, falta voucher), 404 (evento o escuela), 409 (`"Este salón ya está
inscrito"` / `"Este ciclo ya está inscrito"`).

### `GET /groups/mine?eventId=` (autenticado)

Lista de `GroupDetail` donde el usuario es delegado.

### `GET /groups/:id` (delegado del grupo o staff) → `GroupDetail`; 403/404.

### `GET /groups` (staff)

Filtros: `eventId` (obligatorio), `schoolId`, `cycle`, `status` (estado del voucher base). Lista de
`GroupDetail` (sin paginar en esta versión: cientos de grupos como máximo).

## Inscripción de equipos (`POST /registrations`, multipart) — cambios

Campos nuevos opcionales: `groupId`, `extraVoucherId`; en cada integrante del JSON `participants`:
`isCaptain`. Campos existentes sin cambios.

| Situación | Resultado |
| --- | --- |
| Evento `PER_DISCIPLINE` | igual que hoy; `groupId` se ignora |
| Evento `PER_GROUP`, disciplina `STUDENT`, sin `groupId` | 400 "Este evento se inscribe por salón o ciclo" |
| `groupId` de otro evento / sin permiso | 404 / 403 |
| Cupo 1 | sin voucher; `team.voucherId` = base del grupo |
| Cupo ≥ 2 sin `voucher` ni `extraVoucherId` | 400 "El equipo adicional requiere su comprobante de pago (S/ 20.00)" |
| Cupo ≥ 2 con `voucher` | crea `EXTRA` `PENDING` (tarifa adicional) y lo enlaza |
| Cupo ≥ 2 con `extraVoucherId` | enlaza al `EXTRA` `PENDING` del grupo y recalcula su monto |
| Nómina sin DNI/código, o capitanes ≠ 1 | 400 con el detalle |

Respuesta: el equipo creado con `participants` y `voucher` (como hoy) más `groupId` y `slot`.

## Vouchers — cambios

- `GET /vouchers` (admin): cada fila conserva sus campos y agrega `kind`, `groupId`, `groupLabel`,
  `teams: [{ id, name, disciplineName, slot, status }]`. Las filas `TEAM` mantienen `teamId`,
  `teamName`, etc. Las `BASE`/`EXTRA` traen `teamId` y `teamName` del primer equipo (o `null`/`""`
  si no tiene).
- `PATCH /vouchers/:id/validate` (admin): para `BASE`/`EXTRA` devuelve el voucher y además
  `approvedTeamIds: number[]` y `skipped: [{ "teamId": 305, "reason": "…" }]`. Para `TEAM`, igual
  que hoy. `BASE` sin equipos → 400 "El salón aún no registra equipos".
- `PATCH /vouchers/:id/reject` (admin): igual; los equipos `APPROVED` que dependían del voucher
  vuelven a `PENDING`.
- **Nuevo** `PATCH /vouchers/:id/replace` (delegado del grupo/equipo o staff; multipart:
  `voucher`, `operationNumber`): solo si el voucher está `REJECTED`; pasa a `PENDING`, limpia
  `rejectionReason`. 400 si no está rechazado; 403 si no es el responsable.

## Aprobación de equipos — cambios

`PATCH /registrations/:id/approve`: en eventos `PER_GROUP` con disciplina `STUDENT` comprueba que
`team.voucher.status = VALIDATED` (en lugar de `discipline.isPaid`) y rechaza equipos
`REJECTED`/`CANCELLED`. `reject` libera el cupo (`slot = NULL`).

## Panel y dashboard

`GET /admin/dashboard`: `pendingVouchers` sigue contando vouchers `PENDING` (ahora incluye
`BASE`/`EXTRA`); sin campos nuevos obligatorios.
