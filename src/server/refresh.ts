import { getDb, now } from "./db";
import { refreshMarket } from "./market";

export async function refreshOnDemand(userId: string, mode: "auto" | "manual") {
  const interval = mode === "auto" ? 15 * 60_000 : 60_000;
  const attemptedAt = now();
  // Atomic compare-and-set works across tabs and separate serverless instances.
  // Failed attempts also keep the cooldown, so unavailable providers aren't hammered.
  const claimed = await getDb().profile.updateMany({
    where: {
      userId,
      OR: [
        { lastRefresh: null },
        { lastRefresh: { lte: new Date(Date.now() - interval).toISOString() } },
      ],
    },
    data: { lastRefresh: attemptedAt },
  });
  if (!claimed.count) return { skipped: true, warnings: [] as string[] };
  return { skipped: false, ...(await refreshMarket(userId)) };
}
