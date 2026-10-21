-- AlterTable
ALTER TABLE "users" ADD COLUMN     "avatar_key" TEXT,
ADD COLUMN     "bio" TEXT,
ADD COLUMN     "followers_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "following_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "is_private" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "username_changed_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "profiles" (
    "user_id" UUID NOT NULL,
    "gender" TEXT,
    "country" TEXT,
    "state" TEXT,
    "city" TEXT,
    "qualification" TEXT,
    "field_of_study" TEXT,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preferred_areas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "availability" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "volunteering_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "show_personal_details" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "follows" (
    "follower_id" UUID NOT NULL,
    "following_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follows_pkey" PRIMARY KEY ("follower_id","following_id")
);

-- CreateTable
CREATE TABLE "follow_requests" (
    "requester_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follow_requests_pkey" PRIMARY KEY ("requester_id","target_id")
);

-- CreateIndex
CREATE INDEX "follows_following_id_created_at_idx" ON "follows"("following_id", "created_at");

-- CreateIndex
CREATE INDEX "follows_follower_id_created_at_idx" ON "follows"("follower_id", "created_at");

-- CreateIndex
CREATE INDEX "follow_requests_target_id_created_at_idx" ON "follow_requests"("target_id", "created_at");

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_following_id_fkey" FOREIGN KEY ("following_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_requests" ADD CONSTRAINT "follow_requests_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_requests" ADD CONSTRAINT "follow_requests_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Guards the denormalised counters and the follow graph (not modelled by Prisma).
ALTER TABLE "users" ADD CONSTRAINT "users_follow_counts_check" CHECK ("followers_count" >= 0 AND "following_count" >= 0);
ALTER TABLE "follows" ADD CONSTRAINT "follows_not_self_check" CHECK ("follower_id" <> "following_id");
ALTER TABLE "follow_requests" ADD CONSTRAINT "follow_requests_not_self_check" CHECK ("requester_id" <> "target_id");
