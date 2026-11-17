-- FCM now sends display messages that Android shows by itself (D77), so phones no
-- longer fetch notifications with a push key. Undoes 20261116090000_push_token_keys.
DROP INDEX "push_tokens_key_hash_key";

-- AlterTable
ALTER TABLE "push_tokens" DROP COLUMN "key_hash";
