import { z } from "zod";
import { getDb, now, uid, transaction } from "./db";
import { DomainError } from "./ledger";
import { D, holdings, wallets } from "./valuation";

export const sharedWalletSchema = z.object({
  walletIds: z.array(z.string().min(1)).max(100),
});
export const invitationSchema = sharedWalletSchema.extend({
  email: z.string().trim().toLowerCase().pipe(z.email()),
});
type Share = {
  id: string;
  inviterId: string;
  inviteeId: string;
  pairKey: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
};
async function member(userId: string, id: string) {
  const row = (await getDb().assetShare.findFirst({
    where: { id: id, OR: [{ inviterId: userId }, { inviteeId: userId }] },
  })) as Share | undefined;
  if (!row) throw new DomainError("共享关系不存在", 404);
  return row;
}
async function setWallets(userId: string, id: string, walletIds: string[]) {
  const owned = new Set((await wallets(userId)).map((w) => w.id));
  if (walletIds.some((w) => !owned.has(w)))
    throw new DomainError("只能共享自己的资产账户", 403);
  await getDb().shareWallet.deleteMany({
    where: { shareId: id, userId: userId },
  });
  for (const walletId of new Set(walletIds))
    await getDb().shareWallet.create({
      data: { shareId: id, userId: userId, walletId: walletId },
    });
}
async function audit(userId: string, id: string, action: string) {
  await getDb().audit.create({
    data: {
      id: uid(),
      userId: userId,
      action: `share.${action}`,
      targetId: id,
      detail: "{}",
      createdAt: now(),
    },
  });
}
export async function listShares(userId: string) {
  const rows = (await getDb().assetShare.findMany({
    where: { OR: [{ inviterId: userId }, { inviteeId: userId }] },
    orderBy: { createdAt: "desc" },
  })) as Share[];
  return await Promise.all(
    rows.map(async (row) => {
      const peerId = row.inviterId === userId ? row.inviteeId : row.inviterId;
      const peer = (await getDb().user.findFirst({
        where: { id: peerId },
        select: { name: true, email: true },
      })) as { name: string; email: string };
      const ownWalletIds = (
        (await getDb().shareWallet.findMany({
          where: { shareId: row.id, userId: userId },
          select: { walletId: true },
        })) as { walletId: string }[]
      ).map((w) => w.walletId);
      return {
        id: row.id,
        peer,
        direction: row.inviterId === userId ? "outgoing" : "incoming",
        status:
          row.status === "pending" && row.expiresAt <= now()
            ? "expired"
            : row.status,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        ownWalletIds,
      };
    }),
  );
}
export async function inviteShare(
  userId: string,
  input: z.infer<typeof invitationSchema>,
) {
  const { email, walletIds } = invitationSchema.parse(input);
  return await transaction(async () => {
    const peer = (await getDb().user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    })) as { id: string } | undefined;
    if (!peer)
      throw new DomainError("未找到该账户，请对方先注册并核对邮箱", 404);
    if (peer.id === userId) throw new DomainError("不能邀请自己");
    const pairKey = [userId, peer.id].sort().join(":");
    if (
      await getDb().assetShare.findFirst({
        where: {
          pairKey: pairKey,
          OR: [
            { status: "accepted" },
            { status: "pending", expiresAt: { gt: now() } },
          ],
        },
      })
    )
      throw new DomainError("已存在邀请或共享关系", 409);
    const count = {
      n: await getDb().assetShare.count({
        where: {
          inviterId: userId,
          createdAt: { gt: new Date(Date.now() - 86400000).toISOString() },
        },
      }),
    } as {
      n: number;
    };
    if (count.n >= 20)
      throw new DomainError("今日邀请已达上限，请明天再试", 429);
    const id = uid(),
      at = now();
    await getDb().assetShare.create({
      data: {
        id: id,
        inviterId: userId,
        inviteeId: peer.id,
        pairKey: pairKey,
        status: "pending",
        createdAt: at,
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        updatedAt: at,
      },
    });
    await setWallets(userId, id, walletIds);
    await audit(userId, id, "invite");
    return { id };
  }, "share-invites");
}
export async function changeShare(
  userId: string,
  id: string,
  action: "accept" | "decline" | "revoke" | "wallets",
  walletIds: string[] = [],
) {
  return await transaction(async () => {
    const row = await member(userId, id);
    if (action === "accept" || action === "decline") {
      if (row.inviteeId !== userId)
        throw new DomainError("只有受邀人可以回应", 403);
      if (row.status !== "pending" || row.expiresAt <= now())
        throw new DomainError("邀请已失效", 409);
    } else if (action === "wallets" && row.status !== "accepted")
      throw new DomainError("尚未建立共享关系", 409);
    if (action === "accept" || action === "wallets")
      await setWallets(
        userId,
        id,
        sharedWalletSchema.parse({ walletIds }).walletIds,
      );
    if (action !== "wallets")
      await getDb().assetShare.update({
        where: { id: id },
        data: {
          status: {
            accept: "accepted",
            decline: "declined",
            revoke: "revoked",
          }[action],
          updatedAt: now(),
        },
      });
    await audit(userId, id, action);
    return { ok: true };
  }, "share-invites");
}
async function aggregateShared(userId: string, shares: Share[]) {
  const grants = new Map<string, Set<string>>();
  for (const share of shares) {
    for (const ownerId of [share.inviterId, share.inviteeId]) {
      const ids = grants.get(ownerId) || new Set<string>();
      for (const w of (await getDb().shareWallet.findMany({
        where: { shareId: share.id, userId: ownerId },
        select: { walletId: true },
      })) as { walletId: string }[])
        ids.add(w.walletId);
      grants.set(ownerId, ids);
    }
  }
  const members = await Promise.all(
    [...grants].map(async ([ownerId, ids]) => {
      const person = (await getDb().user.findFirst({
        where: { id: ownerId },
        select: { name: true },
      })) as { name: string };
      const items = (await holdings(ownerId)).filter(
        (h) => ids.has(h.accountId) && !D(h.quantity).isZero(),
      );
      return {
        name: person.name,
        isSelf: ownerId === userId,
        holdings: items,
        accountCount: ids.size,
        total: items.reduce((sum, h) => sum.plus(h.value || 0), D(0)).toFixed(),
      };
    }),
  );
  const items = members.flatMap((m) => m.holdings);
  return {
    members,
    total: members.reduce((sum, m) => sum.plus(m.total), D(0)).toFixed(),
    complete: items.every((h) => h.value !== null),
    missingCount: items.filter((h) => h.value === null).length,
    staleCount: items.filter((h) => h.status === "stale").length,
    asOf: now(),
  };
}
export async function sharedPortfolio(userId: string, id: string) {
  return await transaction(async () => {
    const row = await member(userId, id);
    if (row.status !== "accepted")
      throw new DomainError("双方同意后才能查看共同资产", 403);
    return await aggregateShared(userId, [row]);
  }, "share-invites");
}
export async function allSharedPortfolio(userId: string) {
  return await transaction(async () => {
    const rows = (await getDb().assetShare.findMany({
      where: {
        status: "accepted",
        OR: [{ inviterId: userId }, { inviteeId: userId }],
      },
    })) as Share[];
    // Direct mutual grants only. A's invitation to B never grants B access to A's other peers.
    // Set-based wallet union also prevents counting one's wallet twice across invitations.
    return await aggregateShared(userId, rows);
  }, "share-invites");
}
