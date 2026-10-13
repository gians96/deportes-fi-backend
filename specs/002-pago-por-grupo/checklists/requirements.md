# Checklist de calidad de la spec — Pago por grupo

- [x] Historias priorizadas, cada una con prueba independiente y escenarios Given/When/Then
- [x] Requisitos `FR-001…FR-018` verificables y sin ambigüedad de dinero (tarifas, cupos, reparto)
- [x] Criterios de éxito medibles (`SC-001…SC-005`)
- [x] Casos límite: normalización, exclusión ciclo/sección, rechazos, cupos liberados, disciplinas `OTHER`
- [x] Contrato 2 sin campos nuevos; delta de valores documentado
- [x] Compatibilidad: eventos `PER_DISCIPLINE` sin cambios; migración aditiva con reversión
- [x] Supuestos y fuera de alcance explícitos (género, cajas de agua, exportación, RENIEC)
- [ ] Preguntas abiertas respondidas por la organización (ver `spec.md`, 2 pendientes)
- [ ] Fechas del evento confirmadas (cierre y fixtures: ¿2026?)
