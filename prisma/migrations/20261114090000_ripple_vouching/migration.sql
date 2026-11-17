-- CreateEnum
CREATE TYPE "RippleStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "VouchStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DECLINED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'VOUCH_REQUEST';
ALTER TYPE "NotificationType" ADD VALUE 'VOUCHED';
ALTER TYPE "NotificationType" ADD VALUE 'RIPPLE_REVIEWED';

-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "ripple_rejection_reason" TEXT,
ADD COLUMN     "ripple_review_requested_at" TIMESTAMP(3),
ADD COLUMN     "ripple_status" "RippleStatus",
ADD COLUMN     "ripple_verified_at" TIMESTAMP(3),
ADD COLUMN     "ripple_verified_by_id" UUID;

-- CreateTable
CREATE TABLE "post_companions" (
    "post_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "VouchStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMP(3),

    CONSTRAINT "post_companions_pkey" PRIMARY KEY ("post_id","user_id")
);

-- CreateIndex
CREATE INDEX "post_companions_user_id_status_created_at_idx" ON "post_companions"("user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "posts_ripple_status_ripple_review_requested_at_idx" ON "posts"("ripple_status", "ripple_review_requested_at");

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_ripple_verified_by_id_fkey" FOREIGN KEY ("ripple_verified_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_companions" ADD CONSTRAINT "post_companions_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_companions" ADD CONSTRAINT "post_companions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: posts linked before vouching existed start PENDING like new ones.
UPDATE "posts" SET "ripple_status" = 'PENDING' WHERE "inspired_by_post_id" IS NOT NULL;
