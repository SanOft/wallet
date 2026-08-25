import type { PrismaClient } from "@prisma/client"
import { Router } from "express"
import { checkDatabase } from "../../../infra/prisma.js"

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
      res.status(503).json({ status: "degraded", db: "down", migration: null })
      return
    }

    res.status(200).json({ status: "ok", db: "up", migration: db.migration })
  })

  return router
}
