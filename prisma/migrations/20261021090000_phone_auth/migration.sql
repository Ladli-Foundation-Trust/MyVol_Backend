-- AlterTable
ALTER TABLE "users" ADD COLUMN     "phone" TEXT,
ALTER COLUMN "email" DROP NOT NULL;

-- CreateTable
CREATE TABLE "phone_codes" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "phone_codes_phone_created_at_idx" ON "phone_codes"("phone", "created_at");

-- CreateIndex
CREATE INDEX "phone_codes_created_at_idx" ON "phone_codes"("created_at");

-- CreateIndex
CREATE INDEX "users_phone_idx" ON "users"("phone");


-- Every account must be reachable for login and recovery (not modelled by Prisma).
ALTER TABLE "users" ADD CONSTRAINT "users_email_or_phone_check" CHECK ("email" IS NOT NULL OR "phone" IS NOT NULL);
