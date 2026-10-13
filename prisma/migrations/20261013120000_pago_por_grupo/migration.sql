-- Spec 002: pago por salón o ciclo con voucher compartido.
-- Migración ADITIVA (expandir): no elimina nada; el código anterior sigue funcionando porque
-- Voucher.teamId se conserva (ahora opcional) y Team.voucherId se rellena al final.
-- Generada con `prisma migrate diff` (datamodel -> datamodel) y revisada a mano.
-- Runbook: docs/runbook-pago-por-grupo.md

-- AlterTable
ALTER TABLE `SportEvent` ADD COLUMN `pricingMode` ENUM('PER_DISCIPLINE', 'PER_GROUP') NOT NULL DEFAULT 'PER_DISCIPLINE';

-- AlterTable
ALTER TABLE `Team` ADD COLUMN `groupId` INTEGER NULL,
    ADD COLUMN `slot` INTEGER NULL,
    ADD COLUMN `voucherId` INTEGER NULL;

-- AlterTable
ALTER TABLE `Participant` ADD COLUMN `isCaptain` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `Voucher` ADD COLUMN `groupId` INTEGER NULL,
    ADD COLUMN `kind` ENUM('TEAM', 'BASE', 'EXTRA') NOT NULL DEFAULT 'TEAM',
    MODIFY `teamId` INTEGER NULL;

-- CreateTable
CREATE TABLE `EventPricing` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `eventId` INTEGER NOT NULL,
    `sectionBase` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    `cycleBase` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    `sectionExtra` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    `cycleExtra` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `EventPricing_eventId_key`(`eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ClassGroup` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `eventId` INTEGER NOT NULL,
    `schoolId` INTEGER NOT NULL,
    `scope` ENUM('SECTION', 'CYCLE') NOT NULL,
    `cycle` VARCHAR(191) NOT NULL,
    `section` VARCHAR(191) NOT NULL DEFAULT '',
    `delegateId` INTEGER NOT NULL,
    `baseVoucherId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ClassGroup_baseVoucherId_key`(`baseVoucherId`),
    INDEX `ClassGroup_eventId_schoolId_cycle_idx`(`eventId`, `schoolId`, `cycle`),
    UNIQUE INDEX `ClassGroup_eventId_schoolId_scope_cycle_section_key`(`eventId`, `schoolId`, `scope`, `cycle`, `section`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Team_voucherId_idx` ON `Team`(`voucherId`);

-- CreateIndex
CREATE UNIQUE INDEX `Team_groupId_disciplineId_slot_key` ON `Team`(`groupId`, `disciplineId`, `slot`);

-- CreateIndex
CREATE INDEX `Voucher_groupId_kind_idx` ON `Voucher`(`groupId`, `kind`);

-- AddForeignKey
ALTER TABLE `Team` ADD CONSTRAINT `Team_groupId_fkey` FOREIGN KEY (`groupId`) REFERENCES `ClassGroup`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Team` ADD CONSTRAINT `Team_voucherId_fkey` FOREIGN KEY (`voucherId`) REFERENCES `Voucher`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Voucher` ADD CONSTRAINT `Voucher_groupId_fkey` FOREIGN KEY (`groupId`) REFERENCES `ClassGroup`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EventPricing` ADD CONSTRAINT `EventPricing_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `SportEvent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ClassGroup` ADD CONSTRAINT `ClassGroup_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `SportEvent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ClassGroup` ADD CONSTRAINT `ClassGroup_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `ProfessionalSchool`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ClassGroup` ADD CONSTRAINT `ClassGroup_delegateId_fkey` FOREIGN KEY (`delegateId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ClassGroup` ADD CONSTRAINT `ClassGroup_baseVoucherId_fkey` FOREIGN KEY (`baseVoucherId`) REFERENCES `Voucher`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: cada voucher existente (kind = 'TEAM') pasa a cubrir al equipo que ya tenía.
-- Idempotente: volver a ejecutarlo no cambia el resultado.
UPDATE `Team` t
JOIN `Voucher` v ON v.`teamId` = t.`id`
SET t.`voucherId` = v.`id`;
