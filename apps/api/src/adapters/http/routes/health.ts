import type { PrismaClient } from "@prisma/client"
import { Router } from "express"
import * as z from "zod"
import { checkDatabase, type DatabaseHealth } from "../../../infra/prisma.js"
import { respond } from "../respond.js"

/**
 * `/health` is outside the §12.3 error envelope by design — it reports
 * liveness, not a domain outcome — so it declares its own shape here rather
 * than borrowing one from the contract package.
 */
const healthSchema = z.strictObject({
  status: z.enum(["ok", "degraded"]),
  db: z.enum(["up", "down"]),
  version: z.string(),
  /**
   * How many `X-Forwarded-For` entries this request arrived with (P-11).
   *
   * The count, never the addresses. It is here because the correct
   * `TRUST_PROXY_HOPS` is a fact about the deployment that cannot be learned
   * from the code, and the alternative was to wait for a bespoke production
   * measurement. The deploy smoke already calls `/health`, so this number lands
   * in the deploy log on its own.
   *
   * **Only meaningful on a request that sent no `X-Forwarded-For` of its own.**
   * The header grows by one per proxy and a caller may seed it, so a forged
   * entry makes the chain read one longer than it is — and setting the trusted
   * count to that inflated number is the failure where a forged address is
   * believed, which is worse than the one this is here to find. The deploy
   * smoke sends no such header, which is why it is the thing that reads this.
   *
   * Zero means no proxy set the header, which is what a direct request looks
   * like — locally, or anywhere reachable without passing the load balancer.
   * That is the case where `req.ip` is client-controlled regardless of the
   * setting, which the comment on `trust proxy` already warns about.
   */
  proxyChain: z.number().int().min(0),
  /** What the process is configured to believe, so the two can be compared. */
  trustedHops: z.number().int().min(0),
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
 * that cannot serve it. This one reports 503 when the database is unreachable.
 *
 * Unauthenticated by design (§12.1), so it deliberately exposes nothing beyond
 * reachability — no connection string, no driver message, no row counts, and
 * not the migration the database is on. That name is a version number for the
 * schema: it says which published migration this deployment is running and so
 * which of its known gaps are still open, to a caller who had to prove nothing
 * to ask. The deploy window it was there for (§19.1) is read by an operator,
 * who has the boot log — `index.ts` writes it there instead.
 */
/**
 * The number of hops the header claims. Split on commas rather than trusting
 * `req.ips`, whose length already depends on the very setting being diagnosed.
 */
function observedChainDepth(header: string | undefined): number {
  if (!header) return 0
  return header.split(",").filter((part) => part.trim().length > 0).length
}

/**
 * How long one probe answers for.
 *
 * Short next to the interval anything real polls this at — the deploy smoke
 * waits ten seconds between attempts (`scripts/smoke.ts`) — so a database that
 * went away is still reported within one check, while the query cost of a burst
 * stops scaling with the burst. A failed probe is held for the same window,
 * deliberately: a database that is refusing connections is exactly when a query
 * per call is most expensive, and the price is that a recovery is announced up
 * to five seconds late.
 */
const PROBE_TTL_MS = 5_000

export function healthRouter(prisma: PrismaClient, trustedHops: number): Router {
  const router = Router()

  /*
   * The last probe, kept for `PROBE_TTL_MS`. This route takes no credential
   * (§12.1), so the work one call does is work anyone may ask for: without
   * this, a burst of `/health` calls is a burst of queries against the pool the
   * paying traffic needs, and an unauthenticated caller picks how much database
   * load the API takes.
   *
   * The *promise* is memoised, not the settled value, so calls that arrive
   * while a probe is in flight join it rather than each starting one; a burst
   * is concurrent, which is the case a value-only memo misses entirely.
   * `checkDatabase` catches its own errors and never rejects, so there is no
   * rejected promise to be shared here.
   *
   * Per router, not per module: one process builds one app, and a test that
   * stands up a second app against another client must not be answered from
   * the first one's result.
   */
  let probe: { readonly at: number; readonly health: Promise<DatabaseHealth> } | null = null

  function probeDatabase(): Promise<DatabaseHealth> {
    const now = Date.now()
    if (probe && now - probe.at < PROBE_TTL_MS) return probe.health

    probe = { at: now, health: checkDatabase(prisma) }
    return probe.health
  }

  router.get("/health", async (req, res) => {
    const db = await probeDatabase()
    const proxyChain = observedChainDepth(req.get("x-forwarded-for"))

    if (!db.ok) {
      respond(res, 503, healthSchema, {
        status: "degraded",
        db: "down",
        version: VERSION,
        proxyChain,
        trustedHops,
      })
      return
    }

    respond(res, 200, healthSchema, {
      status: "ok",
      db: "up",
      version: VERSION,
      proxyChain,
      trustedHops,
    })
  })

  return router
}
