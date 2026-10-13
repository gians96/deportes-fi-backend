---
description: "Lista de tareas de implementación — Proveedores de DNI configurables"
---

# Tasks: Proveedores de DNI configurables desde la plataforma

**Input**: `specs/003-proveedores-dni/spec.md`

**Tests**: obligatorios (cifrado, clientes de los proveedores, cadena con respaldo, estados, permisos);
sin base de datos real salvo la prueba de humo.

## Phase 1: Base

- [x] T001 Spec `spec.md`
- [x] T002 Modelo `DniProviderConfig` (+ enums `DniProvider`, `CredentialState`) y migración aditiva `20261013170000_proveedores_dni`
- [x] T003 `secret-box.ts`: AES-256-GCM, clave dedicada o derivada de `JWT_SECRET` (HKDF)

## Phase 2: Servicio y API (US1–US3)

- [x] T004 `dni-lookup.ts`: clientes de Decolecta y API Perú con clasificación de respuestas
- [x] T005 `DniProvidersService`: listar, actualizar (token cifrado, URL, prioridad, activación), cadena ordenada, estado y prueba
- [x] T006 `DniProvidersController` (`GET/PUT /settings/dni-providers`, `POST …/:provider/test`), solo OWNER/ADMIN
- [x] T007 `AcademicService.findByDni` recorre la cadena con respaldo; sin tokens del entorno

## Phase 3: Cierre

- [x] T008 Pruebas: 87 en cuatro suites hermeticas (config falsa, sin `process.env`)
- [x] T009 Docs: `api-contract.md`, `data-model.md`, `deployment.md`, `.env.example`, `AGENTS.md`
- [x] T010 Prueba de humo con HTTP real y proveedores simulados (ver evidencia en `spec.md`)
- [ ] T011 Cargar los tokens reales en el panel tras desplegar (acción humana; ya no se leen de `DECOLECTA_TOKEN`)
