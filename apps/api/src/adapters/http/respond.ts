import type { Response } from "express"
import type * as z from "zod"

/**
 * Every successful response leaves through here (runbook T-3.8).
 *
 * `auth.ts` in @wallet/shared claims that "parsing a Prisma record through this
 * schema strips them, so a leak requires deleting this schema, not merely
 * forgetting a field". That is only true if something actually does the
 * parsing. This is that something.
 *
 * Zod object schemas drop unknown keys, so handing a whole `User` row to
 * `publicUserSchema` returns exactly `{ id, phone, firstName, lastName }` — the
 * hash is gone by construction rather than by the route remembering to pick
 * fields. Forgetting a field is then a visible missing field, not an invisible
 * leak, which is the direction an error should fail in.
 */
export function respond<T>(
  res: Response,
  status: number,
  schema: z.ZodType<T>,
  value: unknown,
): void {
  // Deliberately `parse`, not `safeParse`: a response that does not match its
  // own contract is our defect, and it should become an INTERNAL 500 with a
  // logged cause rather than a half-correct body the client has to guess at.
  res.status(status).json(schema.parse(value))
}
