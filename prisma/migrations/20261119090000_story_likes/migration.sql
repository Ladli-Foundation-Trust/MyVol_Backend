-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'STORY_LIKE';

-- AlterTable
ALTER TABLE "stories" ADD COLUMN     "likes_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "story_views" ADD COLUMN     "liked_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "story_id" UUID;

-- CreateIndex
CREATE INDEX "notifications_story_id_idx" ON "notifications"("story_id");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
