-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'PLEDGE';
ALTER TYPE "NotificationType" ADD VALUE 'RIPPLE';
ALTER TYPE "NotificationType" ADD VALUE 'BADGE_EARNED';

-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "inspired_by_post_id" UUID;

-- CreateTable
CREATE TABLE "pledges" (
    "user_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "fulfilled_post_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pledges_pkey" PRIMARY KEY ("user_id","post_id")
);

-- CreateTable
CREATE TABLE "user_badges" (
    "user_id" UUID NOT NULL,
    "badge_id" TEXT NOT NULL,
    "earned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_badges_pkey" PRIMARY KEY ("user_id","badge_id")
);

-- CreateIndex
CREATE INDEX "pledges_user_id_created_at_idx" ON "pledges"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "pledges_post_id_idx" ON "pledges"("post_id");

-- CreateIndex
CREATE INDEX "pledges_fulfilled_post_id_idx" ON "pledges"("fulfilled_post_id");

-- CreateIndex
CREATE INDEX "posts_inspired_by_post_id_idx" ON "posts"("inspired_by_post_id");

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_inspired_by_post_id_fkey" FOREIGN KEY ("inspired_by_post_id") REFERENCES "posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pledges" ADD CONSTRAINT "pledges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pledges" ADD CONSTRAINT "pledges_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pledges" ADD CONSTRAINT "pledges_fulfilled_post_id_fkey" FOREIGN KEY ("fulfilled_post_id") REFERENCES "posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

