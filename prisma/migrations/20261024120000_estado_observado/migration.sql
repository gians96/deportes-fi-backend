-- Estado OBSERVED y observación del equipo (spec 007). Aditiva: agrega el estado al final del ENUM y una columna
-- opcional; ningún equipo existente cambia.
ALTER TABLE `Team` MODIFY `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'DRAFT', 'OBSERVED') NOT NULL DEFAULT 'PENDING';
ALTER TABLE `Team` ADD COLUMN `observation` TEXT NULL;
