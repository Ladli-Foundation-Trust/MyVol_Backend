-- Trigram matching for search (ILIKE '%word%' and similarity()). pg_trgm is a trusted extension,
-- so the database owner (the app role) may create it; no superuser needed.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('POST', 'COMMENT', 'USER', 'PROBLEM');

-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('SPAM', 'NUDITY', 'HATE_SPEECH', 'HARASSMENT', 'VIOLENCE', 'SELF_HARM', 'FALSE_INFORMATION', 'SCAM', 'INTELLECTUAL_PROPERTY', 'FAKE_ACCOUNT', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "blocks" (
    "blocker_id" UUID NOT NULL,
    "blocked_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("blocker_id","blocked_id")
);

-- CreateTable
CREATE TABLE "mutes" (
    "muter_id" UUID NOT NULL,
    "muted_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mutes_pkey" PRIMARY KEY ("muter_id","muted_id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "type" "ReportType" NOT NULL,
    "reason" "ReportReason",
    "category" TEXT,
    "details" TEXT,
    "device_info" TEXT,
    "post_id" UUID,
    "comment_id" UUID,
    "user_id" UUID,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMP(3),
    "resolution" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_actions" (
    "id" UUID NOT NULL,
    "moderator_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hashtags" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "posts_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hashtags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_hashtags" (
    "post_id" UUID NOT NULL,
    "hashtag_id" UUID NOT NULL,

    CONSTRAINT "post_hashtags_pkey" PRIMARY KEY ("post_id","hashtag_id")
);

-- CreateIndex
CREATE INDEX "blocks_blocked_id_idx" ON "blocks"("blocked_id");

-- CreateIndex
CREATE INDEX "blocks_blocker_id_created_at_idx" ON "blocks"("blocker_id", "created_at");

-- CreateIndex
CREATE INDEX "mutes_muted_id_idx" ON "mutes"("muted_id");

-- CreateIndex
CREATE INDEX "mutes_muter_id_created_at_idx" ON "mutes"("muter_id", "created_at");

-- CreateIndex
CREATE INDEX "reports_status_type_created_at_idx" ON "reports"("status", "type", "created_at");

-- CreateIndex
CREATE INDEX "reports_post_id_status_idx" ON "reports"("post_id", "status");

-- CreateIndex
CREATE INDEX "reports_comment_id_status_idx" ON "reports"("comment_id", "status");

-- CreateIndex
CREATE INDEX "reports_user_id_status_idx" ON "reports"("user_id", "status");

-- CreateIndex
CREATE INDEX "reports_reporter_id_created_at_idx" ON "reports"("reporter_id", "created_at");

-- CreateIndex
CREATE INDEX "moderation_actions_target_type_target_id_created_at_idx" ON "moderation_actions"("target_type", "target_id", "created_at");

-- CreateIndex
CREATE INDEX "moderation_actions_moderator_id_created_at_idx" ON "moderation_actions"("moderator_id", "created_at");

-- CreateIndex
CREATE INDEX "moderation_actions_created_at_idx" ON "moderation_actions"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "hashtags_name_key" ON "hashtags"("name");

-- CreateIndex
CREATE INDEX "hashtags_name_trgm_idx" ON "hashtags" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "post_hashtags_hashtag_id_post_id_idx" ON "post_hashtags"("hashtag_id", "post_id");

-- CreateIndex
CREATE INDEX "posts_title_trgm_idx" ON "posts" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "posts_description_trgm_idx" ON "posts" USING GIN ("description" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "users_username_trgm_idx" ON "users" USING GIN ("username" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "users_name_trgm_idx" ON "users" USING GIN ("name" gin_trgm_ops);

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mutes" ADD CONSTRAINT "mutes_muter_id_fkey" FOREIGN KEY ("muter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mutes" ADD CONSTRAINT "mutes_muted_id_fkey" FOREIGN KEY ("muted_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_moderator_id_fkey" FOREIGN KEY ("moderator_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_hashtags" ADD CONSTRAINT "post_hashtags_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_hashtags" ADD CONSTRAINT "post_hashtags_hashtag_id_fkey" FOREIGN KEY ("hashtag_id") REFERENCES "hashtags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
