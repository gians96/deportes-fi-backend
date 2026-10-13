# Contrato 2 — Delta por pago compartido

**Las formas JSON de `/integrations/event/*` no cambian.** La constitución (principio I) prohíbe
agregar campos sin actualizar antes `backend-ciisic/docs/arquitectura-ecosistema.md`; este feature
no necesita campos nuevos, solo reinterpreta valores de texto y corrige agregaciones. Se avisa al
mantenedor del congreso (otro repositorio, no se toca).

## `GET /integrations/event/summary`

| Campo | Antes | Ahora |
| --- | --- | --- |
| `payments.<estado>.count` | un voucher por equipo | **vouchers distintos** del evento por `status` |
| `payments.<estado>.amount` | suma de `amount` por equipo | suma de `amount` de vouchers distintos |
| `byDiscipline[].validatedAmount` / `pendingAmount` | `amount` del voucher del equipo | parte del equipo en el voucher (`allocateCents`; vouchers `TEAM` = monto completo) |
| `byParticipantType[].validatedAmount` / `pendingAmount` | ídem | ídem, sumado por tipo |
| `teams`, `participants` | sin cambios | sin cambios |

Vouchers del evento = los de sus equipos (`Team.voucherId`) **o** los de sus grupos
(`ClassGroup.eventId`). Un `BASE` `PENDING` sin equipos cuenta en `payments.pending` pero no en el
desglose; los `VALIDATED` siempre tienen equipos (invariante 5), así que
`Σ byDiscipline.validatedAmount = payments.validated.amount` se mantiene **exacto**.

## `GET /integrations/event/payments`

Una fila por voucher distinto, misma forma. Valores para `BASE`/`EXTRA`:

| Campo | `BASE` | `EXTRA` |
| --- | --- | --- |
| `teamName` | etiqueta del grupo: `"<Escuela> · <Ciclo> · <Sección>"` (o `"<Escuela> · <Ciclo> · Ciclo completo"`) | etiqueta del grupo |
| `disciplineName` | `"Pago base (salón)"` / `"Pago base (ciclo)"` | `"Adicional · <disciplina del primer equipo>"` |
| `participantType` | `"STUDENT"` | `"STUDENT"` |

El filtro del evento pasa de `team.discipline.eventId` a "voucher cuyos equipos o cuyo grupo
pertenecen al evento". `meta.total` cuenta vouchers distintos. Sin `imageUrl` ni datos personales
(la etiqueta del grupo no identifica personas).

## `GET /integrations/event/registrations`

Sin cambios (una fila por equipo).

## Pruebas de regresión obligatorias

1. Evento `PER_DISCIPLINE` con vouchers `TEAM`: respuestas idénticas a las de la spec 001.
2. Evento mixto (`TEAM` + `BASE` + `EXTRA`): invariantes del contrato y conteos por voucher distinto.
3. Aislamiento: un token del evento A nunca ve vouchers ni grupos del evento B.
4. `allocateCents`: suma exacta para n = 1..7 y montos con centavos.
