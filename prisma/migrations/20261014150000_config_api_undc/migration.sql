-- Conexión con API_UNDC (JP) para traer el DNI al buscar estudiantes por código (spec 006). Aditiva: tabla nueva.
CREATE TABLE `UndcApiConfig` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `baseUrl` VARCHAR(300) NOT NULL,
    `keyCipher` TEXT NOT NULL,
    `keyIv` VARCHAR(191) NOT NULL,
    `keyTag` VARCHAR(191) NOT NULL,
    `keyLast4` VARCHAR(8) NOT NULL,
    `timeoutMs` INTEGER NOT NULL DEFAULT 8000,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `lastStatus` ENUM('OK', 'FAILED') NULL,
    `lastError` VARCHAR(300) NULL,
    `lastCheckedAt` DATETIME(3) NULL,
    `updatedById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
