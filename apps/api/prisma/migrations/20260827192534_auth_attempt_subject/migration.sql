-- FR-2.3's backoff needs something to count that exists for numbers nobody
-- owns.
--
-- Counting against `userId` alone means an unregistered number never backs off,
-- so the fourth attempt answers 429 for a customer and 401 for a stranger. That
-- is a membership oracle, and a louder one than the ~6ms timing difference the
-- previous migration removed for the same reason.
--
-- `subject` is an HMAC of the number under JWT_SECRET, not the number and not a
-- bare hash of it: this table records attempts against numbers belonging to
-- nobody, and a nine-digit national space does not survive an unkeyed digest.
--
-- Existing rows default to '' rather than being backfilled — the numbers they
-- named were never stored, so there is nothing to compute from.

-- AlterTable
ALTER TABLE "auth_attempts" ADD COLUMN     "subject" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "auth_attempts_subject_createdAt_idx" ON "auth_attempts"("subject", "createdAt");
