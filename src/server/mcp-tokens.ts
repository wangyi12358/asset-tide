import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getDb, now, uid, transaction } from "./db";
import { DomainError } from "./ledger";
export const tokenSchema = z.object({
  name: z.string().trim().min(1).max(60),
  expiresInDays: z.number().int().min(1).max(365).default(90),
  transactions: z.boolean().default(false),
});
export type McpToken = {
  id: string;
  userId: string;
  name: string;
  scopes: string;
  expiresAt: string;
  revokedAt: string | null;
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export async function listTokens(userId: string) {
  return await getDb().mcpToken.findMany({
    where: { userId: userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      prefix: true,
      scopes: true,
      createdAt: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
    },
  });
}
export async function createToken(
  userId: string,
  input: z.infer<typeof tokenSchema>,
) {
  return transaction(async () => {
    const { name, expiresInDays, transactions } = tokenSchema.parse(input);
    const count = {
      n: await getDb().mcpToken.count({
        where: { userId: userId, revokedAt: null, expiresAt: { gt: now() } },
      }),
    } as { n: number };
    if (count.n >= 20)
      throw new DomainError("最多保留 20 个有效令牌，请先撤销旧令牌", 409);
    const token = `aat_${randomBytes(32).toString("base64url")}`,
      id = uid(),
      createdAt = now(),
      expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString();
    const scopes = transactions
      ? "portfolio:read transactions:read"
      : "portfolio:read";
    await getDb().mcpToken.create({
      data: {
        id: id,
        userId: userId,
        name: name,
        tokenHash: hash(token),
        prefix: token.slice(0, 12),
        scopes: scopes,
        createdAt: createdAt,
        expiresAt: expiresAt,
      },
    });
    await getDb().audit.create({
      data: {
        id: uid(),
        userId: userId,
        action: "mcp.create",
        targetId: id,
        detail: JSON.stringify({ name, scopes, expiresAt }),
        createdAt: createdAt,
      },
    });
    return { id, token, expiresAt, scopes };
  }, `tokens:${userId}`);
}
export async function revokeToken(userId: string, id: string) {
  return transaction(async () => {
    if (
      !(
        await getDb().mcpToken.updateMany({
          where: { id: id, userId: userId },
          data: { revokedAt: now() },
        })
      ).count
    )
      throw new DomainError("令牌不存在", 404);
    await getDb().audit.create({
      data: {
        id: uid(),
        userId: userId,
        action: "mcp.revoke",
        targetId: id,
        detail: "{}",
        createdAt: now(),
      },
    });
    return { ok: true };
  }, `tokens:${userId}`);
}
export async function authenticateToken(header: string | null) {
  if (!header?.startsWith("Bearer aat_") || header.length > 150) return null;
  const token = (await getDb().mcpToken.findFirst({
    where: {
      tokenHash: hash(header.slice(7)),
      revokedAt: null,
      expiresAt: { gt: now() },
    },
    select: {
      id: true,
      userId: true,
      name: true,
      scopes: true,
      expiresAt: true,
      revokedAt: true,
    },
  })) as McpToken | undefined;
  return token || null;
}
