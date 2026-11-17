-- Push keys (D77): each registered phone gets a read-only key for fetching its
-- notifications after an FCM wake-up. Rows registered before this have no key;
-- apps register again on every launch, so they are simply dropped.
DELETE FROM "push_tokens";

-- AlterTable
ALTER TABLE "push_tokens" ADD COLUMN "key_hash" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "push_tokens_key_hash_key" ON "push_tokens"("key_hash");
