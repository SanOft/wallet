import type { PrismaClient } from "@prisma/client"
import { Router } from "express"
import * as z from "zod"
import { checkDatabase } from "../../../infra/prisma.js"
import { respond } from "../respond.js"

/**
 * `/health` is outside the §12.3 error envelope by design — it reports
 * liveness, not a domain outcome — so it declares its own shape here rather
 * than borrowing one from the contract package.
 */
const healthSchema = z.strictObject({
  status: z.enum(["ok", "degraded"]),
  db: z.enum(["up", "down"]),
  migration: z.string().nullable(),
  version: z.string(),
})

/**
 * The commit this process was built from.
 *
 * Render sets `RENDER_GIT_COMMIT` on every deploy. Reporting it is what lets
 * the release workflow tell "the old instance is still answering" from "the new
 * one is up" without an API key or a service id — it polls until this matches
 * the commit it just pushed. Without it the only options are to sleep and hope,
 * or to hand CI a Render API token it does not otherwise need.
 *
 * `unknown` locally and anywhere the variable is absent; the workflow treats
 * that as "not this deploy" and keeps waiting, which is the safe direction.
 */
const VERSION = process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? "unknown"

/**
 * `GET /health` — service and database status (runbook T-2.5, NFR-5.3).
 *
 * A health endpoint that returns 200 whenever the process is running is worse
 * than none: it tells the load balancer to keep sending traffic to an instance
 * that cannot serve it. This one reports 503 when the database is unreachable,
 * and says which migration the database is actually on, because during a deploy
 * window the API and the schema are briefly out of step (§19.1).
 *
 * Unauthenticated by design (§12.1), so it deliberately exposes nothing beyond
 * reachability — no connection string, no driver message, no row counts.
 */
export function healthRouter(prisma: PrismaClient): Router {
  const router = Router()

  router.get("/health", async (_req, res) => {
    const db = await checkDatabase(prisma)

    if (!db.ok) {
      respond(res, 503, healthSchema, {
        status: "degraded",
        db: "down",
        migration: null,
        version: VERSION,
      })
      return
    }

    respond(res, 200, healthSchema, {
      status: "ok",
      db: "up",
      migration: db.migration,
      version: VERSION,
    })
  })

  return router
}
