-- AlterEnum
ALTER TYPE "ReportType" ADD VALUE 'STORY';

-- AlterTable
ALTER TABLE "comments" ADD COLUMN     "is_offensive" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "featured_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "story_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "activity_visibility" TEXT NOT NULL DEFAULT 'everyone',
ADD COLUMN     "show_location" BOOLEAN NOT NULL DEFAULT true;

-- Only the app's three options (whoCanViewActivities); Prisma doesn't model CHECKs.
ALTER TABLE "users" ADD CONSTRAINT "users_activity_visibility_check" CHECK ("activity_visibility" IN ('everyone', 'followers', 'onlyMe'));

-- CreateTable
CREATE TABLE "stories" (
    "id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "type" "MediaType" NOT NULL,
    "key" TEXT NOT NULL,
    "thumbnail_key" TEXT,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "duration_ms" INTEGER,
    "caption" TEXT,
    "views_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_views" (
    "story_id" UUID NOT NULL,
    "viewer_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_views_pkey" PRIMARY KEY ("story_id","viewer_id")
);

-- CreateTable
CREATE TABLE "suggestion_dismissals" (
    "user_id" UUID NOT NULL,
    "dismissed_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suggestion_dismissals_pkey" PRIMARY KEY ("user_id","dismissed_id")
);

-- CreateIndex
CREATE INDEX "stories_author_id_expires_at_idx" ON "stories"("author_id", "expires_at");

-- CreateIndex
CREATE INDEX "stories_expires_at_idx" ON "stories"("expires_at");

-- CreateIndex
CREATE INDEX "story_views_story_id_created_at_idx" ON "story_views"("story_id", "created_at");

-- CreateIndex
CREATE INDEX "story_views_viewer_id_idx" ON "story_views"("viewer_id");

-- CreateIndex
CREATE INDEX "suggestion_dismissals_dismissed_id_idx" ON "suggestion_dismissals"("dismissed_id");

-- CreateIndex
CREATE INDEX "posts_featured_at_idx" ON "posts"("featured_at");

-- CreateIndex
CREATE INDEX "reports_story_id_status_idx" ON "reports"("story_id", "status");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "stories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stories" ADD CONSTRAINT "stories_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_views" ADD CONSTRAINT "story_views_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_views" ADD CONSTRAINT "story_views_viewer_id_fkey" FOREIGN KEY ("viewer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suggestion_dismissals" ADD CONSTRAINT "suggestion_dismissals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suggestion_dismissals" ADD CONSTRAINT "suggestion_dismissals_dismissed_id_fkey" FOREIGN KEY ("dismissed_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
