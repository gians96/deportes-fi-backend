-- Rol Tesorero y acceso por contraseña (spec 004). Aditiva: ninguna cuenta existente recibe contraseña.
ALTER TABLE `User`
  MODIFY `role` ENUM('OWNER_SYSTEM', 'ADMIN_SYSTEM', 'TREASURER', 'REFEREE', 'STUDENT', 'OTHER') NOT NULL DEFAULT 'STUDENT',
  ADD COLUMN `passwordHash` VARCHAR(255) NULL,
  ADD COLUMN `tokenVersion` INTEGER NOT NULL DEFAULT 0;
