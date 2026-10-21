-- AlterTable
ALTER TABLE "posts" DROP COLUMN "updated_at",
ADD COLUMN     "edited_at" TIMESTAMP(3);

