---
description: "Lista de tareas de implementación — Pool de tokens DNI con caché (backend)"
---

# Tasks: Pool de tokens DNI con caché (backend)

**Input**: `specs/005-pool-tokens-dni/spec.md`

**Tests**: Jest sin base de datos (fakes), `bun run test`.

## Phase 1: Base

- [x] T001 `spec.md` y `tasks.md`
- [x] T002 `prisma/schema.prisma` (`DniToken`, `DniLookupLog`, `DniPersonCache`; se quita `DniProviderConfig`) y migración `20261014130000_pool_tokens_dni` con copia de datos
- [x] T003 `dni-lookup.ts`: estado HTTP, 402 → límite (`lookupDniDetailed`) + prueba
- [x] T004 `renewal.ts` + prueba

## Phase 2: Pool y caché (US1, US2)

- [x] T005 `dni-tokens.service.ts` (alta, edición, borrado, reinicio, vista pública, selección y renovación)
- [x] T006 `dni-lookup.service.ts` (caché, recorrido por prioridad, clasificación, contador, bitácora)
- [x] T007 `test/fakes/dni-prisma.ts` y pruebas de ambos servicios

## Phase 3: API y empalme (US3)

- [x] T008 DTOs y `DniTokensController` (`/settings/dni-tokens`), `DniProvidersModule`
- [x] T009 `AcademicService.findByDni(dni, origin)`, `AcademicController`, `AuthService.updateProfile` + pruebas
- [x] T010 Se retiran `dni-providers.service.ts`, su spec, el controlador y los DTOs de la spec 003; matriz de roles

## Phase 4: Cierre

- [x] T011 `docs/api-contract.md`, `data-model.md`, `deployment.md`, `AGENTS.md`, runbook y spec 003 «reemplazada»
- [x] T012 `bun run build`, `bun run test`, eslint de los archivos tocados, `migrate diff`
- [x] T013 Humo con la API real y proveedores simulados (dos tokens del mismo proveedor, agotado, caché, 404 cruzado)
