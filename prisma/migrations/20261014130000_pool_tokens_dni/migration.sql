-- Pool de tokens de consulta de DNI con caché y bitácora (spec 005). Reemplaza DniProviderConfig (spec 003,
-- nunca desplegada): se crean las tablas nuevas, se copian los tokens ya guardados (mismo cifrado, mismo
-- valor, así que siguen siendo válidos con la misma clave) y se elimina la tabla antigua.

-- CreateTable
CREATE TABLE `DniToken` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `provider` ENUM('DECOLECTA', 'APIPERU') NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `tokenCipher` TEXT NOT NULL,
    `tokenIv` VARCHAR(191) NOT NULL,
    `tokenTag` VARCHAR(191) NOT NULL,
    `tokenLast4` VARCHAR(8) NOT NULL,
    `apiUrl` VARCHAR(300) NULL,
    `priority` INTEGER NOT NULL DEFAULT 100,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `state` ENUM('ACTIVE', 'EXHAUSTED', 'INVALID') NOT NULL DEFAULT 'ACTIVE',
    `queryLimit` INTEGER NULL,
    `queriesUsed` INTEGER NOT NULL DEFAULT 0,
    `renewalPeriod` ENUM('DAILY', 'MONTHLY', 'YEARLY', 'NONE') NOT NULL DEFAULT 'MONTHLY',
    `renewsAt` DATETIME(3) NULL,
    `lastError` VARCHAR(500) NULL,
    `lastUsedAt` DATETIME(3) NULL,
    `exhaustedAt` DATETIME(3) NULL,
    `createdById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `DniToken_enabled_state_priority_idx`(`enabled`, `state`, `priority`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DniLookupLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tokenId` INTEGER NULL,
    `provider` ENUM('DECOLECTA', 'APIPERU') NULL,
    `dniMask` VARCHAR(8) NOT NULL,
    `result` ENUM('SUCCESS', 'CACHE', 'NOT_FOUND', 'EXHAUSTED', 'INVALID_TOKEN', 'ERROR', 'NO_TOKENS') NOT NULL,
    `httpStatus` INTEGER NULL,
    `durationMs` INTEGER NULL,
    `origin` ENUM('PROFILE', 'ROSTER', 'PANEL') NOT NULL,
    `detail` VARCHAR(300) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DniLookupLog_createdAt_idx`(`createdAt`),
    INDEX `DniLookupLog_tokenId_createdAt_idx`(`tokenId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DniPersonCache` (
    `dni` VARCHAR(8) NOT NULL,
    `fullName` VARCHAR(250) NOT NULL,
    `provider` ENUM('DECOLECTA', 'APIPERU') NOT NULL,
    `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`dni`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DniLookupLog` ADD CONSTRAINT `DniLookupLog_tokenId_fkey` FOREIGN KEY (`tokenId`) REFERENCES `DniToken`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Copia los tokens de la spec 003 (solo los que tienen token guardado). Un token rechazado queda INVALID;
-- el resto, ACTIVE. Las prioridades 0 y 1 se conservan (Decolecta antes que API Perú).
INSERT INTO `DniToken`
    (`provider`, `name`, `tokenCipher`, `tokenIv`, `tokenTag`, `tokenLast4`, `apiUrl`, `priority`, `enabled`,
     `state`, `queryLimit`, `queriesUsed`, `renewalPeriod`, `lastError`, `lastUsedAt`, `createdAt`, `updatedAt`)
SELECT
    `provider`,
    CASE `provider` WHEN 'DECOLECTA' THEN 'Decolecta' ELSE 'API Perú' END,
    `tokenCipher`,
    `tokenIv`,
    `tokenTag`,
    COALESCE(`tokenLast4`, ''),
    `apiUrl`,
    `priority`,
    `enabled`,
    CASE `state` WHEN 'INVALID' THEN 'INVALID' ELSE 'ACTIVE' END,
    NULL,
    0,
    'NONE',
    `lastError`,
    `lastCheckedAt`,
    `createdAt`,
    CURRENT_TIMESTAMP(3)
FROM `DniProviderConfig`
WHERE `tokenCipher` IS NOT NULL AND `tokenIv` IS NOT NULL AND `tokenTag` IS NOT NULL;

-- DropTable
DROP TABLE `DniProviderConfig`;
