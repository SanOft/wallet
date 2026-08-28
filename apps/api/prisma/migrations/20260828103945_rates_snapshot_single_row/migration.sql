-- Exactly one row, stated to the database rather than hoped for in the
-- application code.
--
-- The primary key gives uniqueness per value, which would happily hold a
-- second cache under a second id — and then two instances disagree about the
-- last known rate and neither of them is wrong. The same reasoning as the
-- CHECKs in the initial migration: an invariant the application believes in is
-- an invariant until someone writes a second code path.
ALTER TABLE "rates_snapshots" ADD CONSTRAINT "rates_snapshots_single_row"
  CHECK ("id" = 'ROW_ID');
