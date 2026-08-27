-- The revocation list FR-2.6 does without, kept to one nullable column.
--
-- Revoking a refresh family reaches the refresh token at once and leaves the
-- attacker's access token working until it expires: a JWT carries its own
-- authority and nothing consults the database to use it. FR-2.6 states that
-- bound rather than hiding it, and P-16 is the part that closes it for the
-- routes where fifteen minutes is too long — the ones that move money.
--
-- Nullable on purpose. Null is the ordinary case for every account that has
-- never had a token stolen, so the check costs a comparison against a column
-- that is almost always empty.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "tokensValidAfter" TIMESTAMPTZ(3);
