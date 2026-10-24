-- AlterEnum
-- A new enum value can't be used in the transaction that adds it; nothing here uses it.
ALTER TYPE "NotificationType" ADD VALUE 'MEDAL_EARNED';
