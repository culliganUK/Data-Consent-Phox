-- CreateTable
CREATE TABLE `Session` (
    `id` VARCHAR(191) NOT NULL,
    `shop` VARCHAR(191) NOT NULL,
    `state` VARCHAR(191) NOT NULL,
    `isOnline` BOOLEAN NOT NULL DEFAULT false,
    `scope` VARCHAR(191) NULL,
    `expires` DATETIME(3) NULL,
    `accessToken` VARCHAR(191) NOT NULL,
    `userId` BIGINT NULL,
    `firstName` VARCHAR(191) NULL,
    `lastName` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `accountOwner` BOOLEAN NOT NULL DEFAULT false,
    `locale` VARCHAR(191) NULL,
    `collaborator` BOOLEAN NULL DEFAULT false,
    `emailVerified` BOOLEAN NULL DEFAULT false,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AppSettings` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(191) NOT NULL,
    `optInText` VARCHAR(191) NOT NULL DEFAULT '',
    `optOutText` VARCHAR(191) NOT NULL DEFAULT '',
    `noCheckboxText` VARCHAR(191) NOT NULL DEFAULT '',
    `marketingInfo` VARCHAR(191) NOT NULL DEFAULT '',
    `privacyUrl` VARCHAR(191) NOT NULL DEFAULT '',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AppSettings_shop_key`(`shop`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Customer` (
    `id` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `shop` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `shopifyCustomerId` VARCHAR(191) NOT NULL,
    `firstName` VARCHAR(191) NULL,
    `lastName` VARCHAR(191) NULL,
    `lastState` ENUM('SUBSCRIBED', 'UNSUBSCRIBED', 'PENDING') NULL,
    `lastConsentAt` DATETIME(3) NULL,
    `lastMode` ENUM('OPT_OUT', 'OPT_IN', 'NO_CHECKBOX') NULL,
    `lastCountry` VARCHAR(191) NULL,

    UNIQUE INDEX `Customer_shop_shopifyCustomerId_key`(`shop`, `shopifyCustomerId`),
    UNIQUE INDEX `Customer_shop_email_key`(`shop`, `email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ConsentSession` (
    `id` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `shop` VARCHAR(191) NOT NULL,
    `mode` ENUM('OPT_OUT', 'OPT_IN', 'NO_CHECKBOX') NOT NULL,
    `country` VARCHAR(191) NULL,
    `variant` VARCHAR(191) NULL,
    `displayText` TEXT NULL,
    `privacyUrl` TEXT NULL,
    `marketingPreferences` TEXT NULL,
    `ipCountry` VARCHAR(191) NULL,
    `billingCountry` VARCHAR(191) NULL,
    `orderId` VARCHAR(191) NULL,
    `customerId` VARCHAR(191) NULL,
    `subscribed` BOOLEAN NULL,
    `consentAt` DATETIME(3) NULL,
    `checkoutToken` VARCHAR(191) NULL,

    UNIQUE INDEX `ConsentSession_orderId_key`(`orderId`),
    UNIQUE INDEX `ConsentSession_checkoutToken_key`(`checkoutToken`),
    INDEX `ConsentSession_shop_createdAt_idx`(`shop`, `createdAt`),
    INDEX `ConsentSession_customerId_fkey`(`customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ConsentEvent` (
    `id` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sessionId` VARCHAR(191) NULL,
    `customerId` VARCHAR(191) NULL,
    `type` VARCHAR(191) NOT NULL,
    `value` BOOLEAN NULL,
    `country` VARCHAR(191) NULL,
    `note` VARCHAR(191) NULL,

    INDEX `ConsentEvent_customerId_createdAt_idx`(`customerId`, `createdAt`),
    INDEX `ConsentEvent_sessionId_createdAt_idx`(`sessionId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ConsentSession` ADD CONSTRAINT `ConsentSession_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ConsentEvent` ADD CONSTRAINT `ConsentEvent_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ConsentEvent` ADD CONSTRAINT `ConsentEvent_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `ConsentSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
