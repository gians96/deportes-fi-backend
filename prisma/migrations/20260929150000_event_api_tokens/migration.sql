-- Tokens de integración por evento (spec 001-tokens-api-por-evento).
-- Solo crea la tabla nueva, sus índices y la FK con SportEvent; no toca tablas existentes.
-- Runbook de aplicación en producción: docs/runbook-tokens-evento.md

-- CreateTable
CREATE TABLE `EventApiToken` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `eventId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `tokenPrefix` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `createdById` INTEGER NULL,
    `lastUsedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `EventApiToken_tokenPrefix_key`(`tokenPrefix`),
    UNIQUE INDEX `EventApiToken_tokenHash_key`(`tokenHash`),
    INDEX `EventApiToken_eventId_idx`(`eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `EventApiToken` ADD CONSTRAINT `EventApiToken_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `SportEvent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
