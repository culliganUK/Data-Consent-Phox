#!/usr/bin/env node
/**
 * Prune consent sessions older than N days that never completed checkout,
 * and delete ALL consentEvent rows for those sessions.
 *
 * Rule:
 *   - Consider consentSession where createdAt < (now - DAYS).
 *   - If there is NO consentEvent with type = 'shopify_checkout' for that sessionId,
 *     delete the session AND all consentEvent rows for that sessionId.
 *
 * Flags:
 *   --days=45      Number of days; delete sessions older than this (default 45)
 *   --batch=500    Batch size for scanning (default 500)
 *   --dry-run      Preview only (no deletions)
 *   --log-ids      Print IDs of sessions/events to delete (on by default in dry-run)
 *   --max-log=200  Max IDs to print per batch (default 200)
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ---- CLI args ---------------------------------------------------------------
const args = process.argv.slice(2);
const getFlag = (name) => args.some((a) => a === `--${name}`);
const getArg = (name, def = null) => {
  const p = args.find((a) => a.startsWith(`--${name}=`));
  return p ? p.split("=")[1] : def;
};

const DAYS = parseInt(getArg("days", "45"), 10);
const DRY_RUN = getFlag("dry-run");
const BATCH = parseInt(getArg("batch", "500"), 10);
const LOG_IDS = getFlag("log-ids") || DRY_RUN; // default on for dry-run
const MAX_LOG = parseInt(getArg("max-log", "200"), 10);

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const now = new Date();
const cutoff = new Date(now.getTime() - DAYS * MS_PER_DAY);

// ---- helpers ----------------------------------------------------------------
function header() {
  console.log(
    `🧹 Pruning sessions older than ${DAYS}d (createdAt < ${cutoff.toISOString()}) — BATCH=${BATCH} ${DRY_RUN ? "[DRY RUN]" : ""}`
  );
  console.log("• Rule: delete consentSession with NO matching 'shopify_checkout' event,");
  console.log("        and delete ALL consentEvent rows for those sessions.");
}

function logIds(label, ids) {
  if (!LOG_IDS || !ids?.length) return;
  const shown = ids.slice(0, MAX_LOG);
  console.log(`🔎 ${label} (${ids.length}) → ${shown.join(", ")}`);
  if (ids.length > shown.length) {
    console.log(`…and ${ids.length - shown.length} more (increase --max-log to see more)`);
  }
}

async function pruneSessionsOlderThan() {
  let totalSessionsDeleted = 0;
  let totalEventsDeleted = 0;
  let scanned = 0;
  let lastId = null;

  while (true) {
    // Deterministic window: older than cutoff, ascending id, resume with id>lastId
    const sessions = await prisma.consentSession.findMany({
      where: {
        createdAt: { lt: cutoff },
        ...(lastId ? { id: { gt: lastId } } : {}),
      },
      orderBy: { id: "asc" },
      select: { id: true, createdAt: true },
      take: BATCH,
    });

    if (sessions.length === 0) break;

    scanned += sessions.length;
    lastId = sessions[sessions.length - 1].id;
    const sessionIds = sessions.map((s) => s.id);

    // Which of these have a checkout?
    const checkoutRows = await prisma.consentEvent.findMany({
      where: {
        sessionId: { in: sessionIds },
        type: "shopify_checkout",
      },
      select: { sessionId: true },
    });
    const hasCheckout = new Set(checkoutRows.map((r) => r.sessionId));

    const deletableSessionIds = sessions
      .filter((s) => !hasCheckout.has(s.id))
      .map((s) => s.id);

    const keptCount = sessions.length - deletableSessionIds.length;
    if (keptCount > 0) {
      console.log(`🔒 Kept ${keptCount} sessions (they have a checkout).`);
    }

    if (deletableSessionIds.length) {
      // Preview sessions
      logIds("Session IDs to delete", deletableSessionIds);

      // Count and preview related events
      const evCount = await prisma.consentEvent.count({
        where: { sessionId: { in: deletableSessionIds } },
      });
      if (evCount > 0) {
        const evPreview = await prisma.consentEvent.findMany({
          where: { sessionId: { in: deletableSessionIds } },
          select: { id: true },
          orderBy: { id: "asc" },
          take: MAX_LOG,
        });
        logIds("(preview) Event IDs to delete", evPreview.map((e) => e.id));
        if (evCount > evPreview.length) {
          console.log(`…total events to delete: ${evCount}`);
        }
      }

      console.log(`🗑️  Deleting ${deletableSessionIds.length} sessions and ${evCount} events`);

      if (!DRY_RUN) {
        await prisma.$transaction([
          prisma.consentEvent.deleteMany({ where: { sessionId: { in: deletableSessionIds } } }),
          prisma.consentSession.deleteMany({ where: { id: { in: deletableSessionIds } } }),
        ]);
        totalSessionsDeleted += deletableSessionIds.length;
        totalEventsDeleted += evCount;
      }
    }
  }

  console.log(
    `${DRY_RUN ? "[DRY RUN] " : ""}✅ Done. Scanned=${scanned}, SessionsDeleted=${totalSessionsDeleted}, EventsDeleted=${totalEventsDeleted}`
  );
}

// ---- main -------------------------------------------------------------------
async function main() {
  header();
  await pruneSessionsOlderThan();
}

main()
  .catch((e) => {
    console.error("❌ Prune failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
