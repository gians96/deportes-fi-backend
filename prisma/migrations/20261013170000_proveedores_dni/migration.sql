-- Spec 003: proveedores de DNI (Decolecta, API Perú) configurables desde la plataforma.
-- Migración ADITIVA: solo crea la tabla DniProviderConfig. El token se guarda cifrado (AES-256-GCM);
-- la URL y la prioridad también viven aquí, no en variables de entorno.
-- Generada con `prisma migrate diff` y revisada a mano.

-- CreateTable
CREATE TABLE `DniProviderConfig` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `provider` ENUM('DECOLECTA', 'APIPERU') NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `priority` INTEGER NOT NULL DEFAULT 0,
    `apiUrl` VARCHAR(300) NULL,
    `tokenCipher` TEXT NULL,
    `tokenIv` VARCHAR(191) NULL,
    `tokenTag` VARCHAR(191) NULL,
    `tokenLast4` VARCHAR(191) NULL,
    `state` ENUM('UNVERIFIED', 'VALID', 'INVALID') NOT NULL DEFAULT 'UNVERIFIED',
    `lastError` VARCHAR(191) NULL,
    `lastCheckedAt` DATETIME(3) NULL,
    `updatedById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DniProviderConfig_provider_key`(`provider`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

