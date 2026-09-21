import { getDb, transaction, uid } from "./db";

// Shared by all serverless instances; no process-local counters.
export async function consumeMcpLimit(tokenId: string) {
  const key = `mcp:${tokenId}`;
  return transaction(async () => {
    const at = BigInt(Date.now());
    const row = await getDb().rateLimit.findUnique({ where: { key } });
    if (row && at - row.lastRequest < 60_000n && row.count >= 120) return false;
    await getDb().rateLimit.upsert({
      where: { key },
      create: { id: uid(), key, count: 1, lastRequest: at },
      update:
        !row || at - row.lastRequest >= 60_000n
          ? { count: 1, lastRequest: at }
          : { count: { increment: 1 } },
    });
    return true;
  }, `rate-limit:${key}`);
}
