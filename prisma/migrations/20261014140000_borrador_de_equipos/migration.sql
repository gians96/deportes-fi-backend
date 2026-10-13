-- Equipos en borrador (spec 006). Aditiva: agrega el estado DRAFT al final del ENUM; ningún equipo existente cambia.
ALTER TABLE `Team` MODIFY `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'DRAFT') NOT NULL DEFAULT 'PENDING';
