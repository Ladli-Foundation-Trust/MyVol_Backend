-- AlterTable
ALTER TABLE "post_media" ADD COLUMN     "duration_ms" INTEGER,
ADD COLUMN     "thumbnail_key" TEXT;

-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "is_reel" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "views_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "post_views" (
    "user_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "plays" INTEGER NOT NULL DEFAULT 1,
    "watch_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_viewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_views_pkey" PRIMARY KEY ("user_id","post_id")
);

-- CreateIndex
CREATE INDEX "post_views_post_id_idx" ON "post_views"("post_id");

-- CreateIndex
CREATE INDEX "posts_is_reel_status_created_at_idx" ON "posts"("is_reel", "status", "created_at");

-- AddForeignKey
ALTER TABLE "post_views" ADD CONSTRAINT "post_views_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_views" ADD CONSTRAINT "post_views_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "posts" ADD CONSTRAINT "posts_views_count_check" CHECK ("views_count" >= 0);
