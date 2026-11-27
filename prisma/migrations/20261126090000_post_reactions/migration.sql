-- Likes become reactions: Good / Excellent / Fabulous. Existing likes count as Good.
-- CreateEnum
CREATE TYPE "Reaction" AS ENUM ('GOOD', 'EXCELLENT', 'FABULOUS');

-- AlterTable
ALTER TABLE "post_likes" ADD COLUMN     "reaction" "Reaction" NOT NULL DEFAULT 'GOOD';
