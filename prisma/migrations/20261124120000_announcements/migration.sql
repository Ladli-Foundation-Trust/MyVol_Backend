-- CreateEnum
CREATE TYPE "AnnouncementStatus" AS ENUM ('SCHEDULED', 'SENDING', 'SENT', 'CANCELLED', 'WITHDRAWN');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'ANNOUNCEMENT';

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "announcement_id" UUID;

-- CreateTable
CREATE TABLE "announcements" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link_url" TEXT,
    "audience" JSONB NOT NULL DEFAULT '{}',
    "status" "AnnouncementStatus" NOT NULL DEFAULT 'SCHEDULED',
    "is_test" BOOLEAN NOT NULL DEFAULT false,
    "scheduled_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "withdrawn_at" TIMESTAMP(3),
    "recipients_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "announcements_status_scheduled_at_idx" ON "announcements"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "announcements_created_at_idx" ON "announcements"("created_at");

-- CreateIndex
CREATE INDEX "notifications_announcement_id_read_at_idx" ON "notifications"("announcement_id", "read_at");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

