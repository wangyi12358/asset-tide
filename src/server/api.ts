import { handleMcp } from "./mcp";
import {
  createToken,
  listTokens,
  revokeToken,
  tokenSchema,
} from "./mcp-tokens";
import {
  inviteShare,
  listShares,
  changeShare,
  sharedPortfolio,
  allSharedPortfolio,
  invitationSchema,
  sharedWalletSchema,
} from "./sharing";
import { resolveCoinIcon } from "./instrument-search";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { auth } from "./auth";
import { getDb, now, uid, transaction } from "./db";
import {
  D,
  history,
  holdings,
  instruments,
  profile,
  rebuildSnapshots,
  valuation,
  wallets,
} from "./valuation";
import {
  decimal,
  DomainError,
  eventSchema,
  finalize,
  positive,
  recordEvent,
  type EventInput,
  voidEvent,
} from "./ledger";
import { refreshMarket } from "./market";
import { longportStatus } from "./longport";
import { refreshOnDemand } from "./refresh";
import { schedulerEnabled } from "./runtime";
import { changeHolding, holdingChangeSchema } from "./holding-mutations";
import {
  searchSchema,
  searchInstruments,
  importInstrument,
} from "./instrument-search";
import type { LedgerEvent } from "@/lib/types";
type User = typeof auth.$Infer.Session.user;
export const app = new Hono<{ Variables: { user: User } }>().basePath("/api");
app.use("*", bodyLimit({ maxSize: 128 * 1024 }));
app.onError((error, c) => {
  if (error instanceof z.ZodError)
    return c.json(
      {
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("；"),
      },
      400,
    );
  if (error instanceof DomainError)
    return c.json({ error: error.message }, error.status as 400);
  if (error instanceof SyntaxError)
    return c.json({ error: "请求格式错误" }, 400);
  if ("code" in error && ["P2002", "P2003"].includes(String(error.code)))
    return c.json({ error: "记录冲突，请检查账户名称或关联数据" }, 409);
  console.error("API request failed", { path: c.req.path, type: error.name });
  return c.json({ error: "请求暂时无法完成，请稍后重试" }, 500);
});
app.all("/mcp", (c) => handleMcp(c.req.raw));
app.get("/health", async (c) => {
  try {
    await getDb().job.count();
    return c.json({
      status: "ok",
      service: "AssetAtlas",
      database: "postgresql",
      time: now(),
    });
  } catch {
    return c.json({ status: "unavailable", service: "AssetAtlas" }, 503);
  }
});
app.get("/config", (c) =>
  c.json({
    mailMode: process.env.RESEND_API_KEY
      ? "email"
      : process.env.NODE_ENV === "production"
        ? "unavailable"
        : "local",
  }),
);
// Legacy verification links lead back to login; registration no longer sends emails.
app.get("/auth/verify-email", (c) => c.redirect("/login"));
app.post("/auth/send-verification-email", (c) =>
  c.json({ error: "当前无需验证邮箱，可直接登录" }, 400),
);
app.on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw));
app.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "请先登录" }, 401);
  if (
    Date.now() - new Date(session.session.createdAt).getTime() >
    30 * 86400_000
  ) {
    await getDb().session.deleteMany({ where: { id: session.session.id } });
    return c.json({ error: "会话已到期，请重新登录" }, 401);
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const expected = new URL(
      process.env.BETTER_AUTH_URL || "http://localhost:3000",
    ).origin;
    if (c.req.header("Origin") !== expected)
      return c.json({ error: "请求来源不可信" }, 403);
    if (!c.req.header("Content-Type")?.includes("application/json"))
      return c.json({ error: "请使用 JSON 请求" }, 415);
  }
  c.set("user", session.user);
  await profile(session.user.id);
  await next();
});
// One-time secrets must never enter the generic idempotency response cache.
app.post("/mcp-tokens", async (c) =>
  c.json(
    await createToken(c.get("user").id, tokenSchema.parse(await c.req.json())),
    201,
  ),
);
const mutationsInFlight = new Map<string, Promise<void>>();
app.use("*", async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  // Refresh has its own database-backed cooldown and doesn't create financial records.
  if (c.req.path === "/api/refresh") return next();
  const key = z.string().min(8).max(100).parse(c.req.header("Idempotency-Key"));
  const userId = c.get("user").id;
  const slot = `${userId}:${key}`;
  const fingerprint = createHash("sha256")
    .update(c.req.method + c.req.path + (await c.req.raw.clone().text()))
    .digest("hex");
  if (mutationsInFlight.has(slot)) await mutationsInFlight.get(slot);
  const existing = (await getDb().mutation.findFirst({
    where: { userId: userId, key: key },
  })) as { result: string } | undefined;
  if (existing) {
    const result = JSON.parse(existing.result) as {
      fingerprint: string;
      body: string;
      status: number;
    };
    if (result.fingerprint !== fingerprint)
      throw new DomainError("同一幂等键不能用于不同请求", 409);
    c.header("Content-Type", "application/json");
    return c.body(result.body, result.status as 200);
  }
  let done!: () => void;
  mutationsInFlight.set(
    slot,
    new Promise<void>((resolve) => {
      done = resolve;
    }),
  );
  try {
    await next();
    if (c.res.status < 300)
      await getDb().mutation.createMany({
        data: [
          {
            userId: userId,
            key: key,
            result: JSON.stringify({
              fingerprint,
              body: await c.res.clone().text(),
              status: c.res.status,
            }),
          },
        ],
        skipDuplicates: true,
      });
  } finally {
    done();
    mutationsInFlight.delete(slot);
  }
});
app.get("/mcp-tokens", async (c) =>
  c.json({ items: await listTokens(c.get("user").id) }),
);
app.delete("/mcp-tokens/:id", async (c) =>
  c.json(await revokeToken(c.get("user").id, c.req.param("id"))),
);
app.get("/shares/portfolio", async (c) =>
  c.json(await allSharedPortfolio(c.get("user").id)),
);
app.get("/shares", async (c) =>
  c.json({ items: await listShares(c.get("user").id) }),
);
app.post("/shares", async (c) =>
  c.json(
    await inviteShare(
      c.get("user").id,
      invitationSchema.parse(await c.req.json()),
    ),
    201,
  ),
);
app.get("/shares/:id/portfolio", async (c) =>
  c.json(await sharedPortfolio(c.get("user").id, c.req.param("id"))),
);
app.post("/shares/:id/:action", async (c) => {
  const action = z
    .enum(["accept", "decline", "revoke", "wallets"])
    .parse(c.req.param("action"));
  const input =
    action === "accept" || action === "wallets"
      ? sharedWalletSchema.parse(await c.req.json())
      : { walletIds: [] };
  return c.json(
    await changeShare(
      c.get("user").id,
      c.req.param("id"),
      action,
      input.walletIds,
    ),
  );
});
app.get("/instruments/:id/icon", async (c) => {
  const instrument = (await instruments(c.get("user").id)).find(
    (i) => i.id === c.req.param("id"),
  );
  if (!instrument || instrument.type !== "crypto") return c.notFound();
  try {
    const url = await resolveCoinIcon(instrument);
    return url ? c.redirect(url) : c.notFound();
  } catch {
    return c.notFound();
  }
});
async function events(userId: string) {
  const rows = (await getDb().ledgerEvent.findMany({
    where: { userId: userId },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  })) as LedgerEvent[];
  const legs = (await getDb().leg.findMany({
    where: { event: { userId: userId } },
    orderBy: [
      { event: { occurredAt: "asc" } },
      { event: { createdAt: "asc" } },
      { event: { id: "asc" } },
      { position: "asc" },
    ],
  })) as (import("@/lib/types").Leg & { eventId: string })[];
  const grouped = new Map<string, typeof legs>();
  for (const l of legs)
    grouped.set(l.eventId, [...(grouped.get(l.eventId) || []), l]);
  return rows.map((e) => ({ ...e, legs: grouped.get(e.id) || [] }));
}
app.get("/portfolio", async (c) => {
  const user = c.get("user");
  const p = await profile(user.id);
  const v = await valuation(user.id);
  const snapshots = await history(user.id);
  const localDay = (at: string) =>
    new Date(Date.parse(at) + 8 * 3600_000).toISOString().slice(0, 10);
  const previous = snapshots
    .filter(
      (s) => s.complete && s.pnl !== null && localDay(s.asOf) < localDay(now()),
    )
    .at(-1);
  const valid =
    previous?.complete && v.complete && previous.pnl !== null && v.pnl !== null;
  return c.json({
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    holdings: await holdings(user.id),
    accounts: await wallets(user.id),
    transactions: (await events(user.id)).slice(0, 8),
    total: v.total,
    complete: v.complete,
    missingCount: v.items.filter((h) => h.value === null).length,
    staleCount: v.items.filter((h) => h.status === "stale").length,
    netFlow: v.netFlow,
    pnl: v.pnl,
    baseline: p.baseline,
    baselineAt: p.baselineAt,
    initialized: !!p.initialized,
    change: valid ? D(v.total).minus(previous.total).toFixed() : null,
    periodFlow: valid ? D(v.netFlow).minus(previous.netFlow).toFixed() : null,
    periodPnl: valid ? D(v.pnl!).minus(previous.pnl!).toFixed() : null,
    history: snapshots,
    asOf: now(),
  });
});
app.get("/instruments", async (c) =>
  c.json(await instruments(c.get("user").id)),
);
const searchLimits = new Map<string, { count: number; until: number }>();
app.use("/instruments/*", async (c, next) => {
  const userId = c.get("user").id;
  const time = Date.now();
  for (const [id, value] of searchLimits)
    if (value.until <= time) searchLimits.delete(id);
  const value = searchLimits.get(userId) || { count: 0, until: time + 60_000 };
  if (value.count >= 30)
    return c.json({ error: "搜索太频繁，请稍后再试" }, 429);
  value.count++;
  searchLimits.set(userId, value);
  await next();
});
app.get("/instruments/search", async (c) =>
  c.json(await searchInstruments(searchSchema.parse(c.req.query()))),
);
app.post("/instruments/import", async (c) => {
  const input = searchSchema
    .extend({ key: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(await c.req.json());
  return c.json(await importInstrument(input));
});
app.post("/instruments", async (c) => {
  const data = z
    .object({
      name: z.string().trim().min(1).max(100),
      symbol: z.string().trim().min(1).max(30),
      type: z.enum(["stock", "fund", "gold", "crypto"]),
      currency: z.enum(["CNY", "USD", "HKD"]),
      market: z.string().trim().min(1).max(50),
      unit: z.string().trim().min(1).max(10),
      purity: positive.default("1"),
      quoteBasis: z.enum(["unit", "oz"]).default("unit"),
    })
    .parse(await c.req.json());
  if (D(data.purity).gt(1)) throw new DomainError("纯度必须在 0 到 1 之间");
  if (
    data.type !== "gold" &&
    (data.purity !== "1" || data.quoteBasis !== "unit")
  )
    throw new DomainError("只有黄金可设置纯度与金衡盎司基准");
  const id = uid();
  await getDb().instrument.create({
    data: {
      id: id,
      ownerId: c.get("user").id,
      name: data.name,
      symbol: data.symbol,
      type: data.type,
      market: data.market,
      currency: data.currency,
      unit: data.unit,
      purity: data.purity,
      quoteBasis: data.quoteBasis,
    },
  });
  return c.json({ id }, 201);
});
app.get("/accounts", async (c) => c.json(await wallets(c.get("user").id)));
app.post("/accounts", async (c) => {
  const data = z
    .object({
      name: z.string().trim().min(1).max(60),
      type: z.string().max(30).default("综合账户"),
    })
    .parse(await c.req.json());
  const id = uid();
  await getDb().wallet.create({
    data: {
      id: id,
      userId: c.get("user").id,
      name: data.name,
      type: data.type,
    },
  });
  return c.json({ id }, 201);
});
app.patch("/accounts/:id", async (c) => {
  const data = z
    .object({
      name: z.string().trim().min(1).max(60).optional(),
      archived: z.boolean().optional(),
      type: z.string().trim().min(1).max(30).optional(),
    })
    .parse(await c.req.json());
  const result = await getDb().wallet.updateMany({
    where: { id: c.req.param("id"), userId: c.get("user").id },
    data: {
      name: data.name,
      archived: data.archived === undefined ? undefined : Number(data.archived),
      type: data.type,
    },
  });
  if (!result.count) throw new DomainError("账户不存在", 404);
  return c.json({ ok: true });
});
app.post("/initialize", async (c) => c.json(await finalize(c.get("user").id)));
app.get("/transactions", async (c) => {
  const list = await events(c.get("user").id);
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const type = c.req.query("type");
  const filtered = type ? list.filter((e) => e.type === type) : list;
  return c.json({
    items: filtered.slice((page - 1) * 25, page * 25),
    total: filtered.length,
    page,
  });
});
app.get("/transactions/:id", async (c) => {
  const e = (await events(c.get("user").id)).find(
    (e) => e.id === c.req.param("id"),
  );
  if (!e) throw new DomainError("流水不存在", 404);
  return c.json(e);
});
async function recordWithQuote(
  userId: string,
  input: EventInput,
  key: string,
  replacing?: string,
) {
  const event = await recordEvent(userId, input, key, replacing);
  try {
    // Commit the ledger first. Market failures must not turn a saved record into a failed submission.
    const market = await refreshMarket(userId, input.instrumentId);
    return { ...event, market };
  } catch {
    return {
      ...event,
      market: {
        warnings: ["行情更新暂时失败，请在资产总览刷新估值"],
        updatedAt: now(),
      },
    };
  }
}
app.post("/transactions", async (c) => {
  const key = z.string().min(8).max(100).parse(c.req.header("Idempotency-Key"));
  return c.json(
    await recordWithQuote(
      c.get("user").id,
      eventSchema.parse(await c.req.json()),
      key,
    ),
    201,
  );
});
app.put("/transactions/:id", async (c) => {
  const key = z.string().min(8).max(100).parse(c.req.header("Idempotency-Key"));
  return c.json(
    await recordWithQuote(
      c.get("user").id,
      eventSchema.parse(await c.req.json()),
      key,
      c.req.param("id"),
    ),
  );
});
app.post("/transactions/:id/void", async (c) => {
  const { reason } = z
    .object({ reason: z.string().trim().min(3).max(500) })
    .parse(await c.req.json());
  await voidEvent(c.get("user").id, c.req.param("id"), reason);
  return c.json({ ok: true });
});
app.patch("/assets/:id/quantity", async (c) => {
  const input = holdingChangeSchema.parse(await c.req.json());
  return c.json(
    await changeHolding(
      c.get("user").id,
      c.req.param("id"),
      input,
      c.req.header("Idempotency-Key")!,
    ),
  );
});
app.delete("/assets/:id", async (c) => {
  const input = holdingChangeSchema
    .omit({ quantity: true })
    .parse(await c.req.json());
  return c.json(
    await changeHolding(
      c.get("user").id,
      c.req.param("id"),
      { ...input, quantity: "0" },
      c.req.header("Idempotency-Key")!,
      "delete",
    ),
  );
});
app.get("/assets/:id", async (c) => {
  const userId = c.get("user").id;
  const item = (await holdings(userId)).find(
    (h) => h.holdingId === c.req.param("id"),
  );
  if (!item) throw new DomainError("持仓不存在", 404);
  const prices = await getDb().price.findMany({
    where: {
      instrumentId: item.id,
      OR: [{ userId: userId }, { userId: null }],
    },
    orderBy: { asOf: "asc" },
    select: { value: true, asOf: true, source: true, manual: true },
  });
  return c.json({
    holding: item,
    prices,
    history: (await history(userId)).map((s) => ({
      asOf: s.asOf,
      value: s.items.find((h) => h.holdingId === item.holdingId)?.value ?? null,
    })),
    transactions: (await events(userId)).filter((e) =>
      e.legs?.some(
        (l) => l.instrumentId === item.id && l.accountId === item.accountId,
      ),
    ),
  });
});
app.post("/quotes", async (c) => {
  const userId = c.get("user").id;
  const data = z
    .object({
      instrumentId: z.string(),
      value: decimal.optional(),
      fx: positive.optional(),
      asOf: z.iso.datetime(),
      source: z.string().trim().min(2).max(200),
      automatic: z.boolean().default(false),
    })
    .parse(await c.req.json());
  const asset = (await instruments(userId)).find(
    (i) => i.id === data.instrumentId,
  );
  if (!asset) throw new DomainError("标的不存在", 404);
  if (data.asOf > now()) throw new DomainError("报价时间不能晚于当前时间");
  if (!data.automatic && data.value === undefined && !data.fx)
    throw new DomainError("请填写价格或汇率");
  await transaction(async () => {
    if (data.automatic)
      await getDb().price.updateMany({
        where: { instrumentId: asset.id, userId: userId, endedAt: null },
        data: { active: 0, endedAt: now() },
      });
    else if (data.value !== undefined && asset.type !== "cash")
      await getDb().price.create({
        data: {
          id: uid(),
          instrumentId: asset.id,
          userId: userId,
          value: data.value,
          asOf: data.asOf,
          source: `手动 · ${data.source}`,
          manual: 1,
          createdAt: now(),
        },
      });
    if (data.fx && asset.currency !== "CNY")
      await getDb().fxRate.create({
        data: {
          id: uid(),
          currency: asset.currency,
          userId: userId,
          value: data.fx,
          asOf: data.asOf,
          source: `手动 · ${data.source}`,
        },
      });
    await getDb().audit.create({
      data: {
        id: uid(),
        userId: userId,
        action: "quote.update",
        targetId: asset.id,
        detail: JSON.stringify(data),
        createdAt: now(),
      },
    });
    await rebuildSnapshots(userId, data.asOf);
  }, userId);
  return c.json({ ok: true });
});
app.post("/refresh", async (c) => {
  const id = c.get("user").id;
  const { mode } = z
    .object({ mode: z.enum(["auto", "manual"]).default("manual") })
    .parse(await c.req.json());
  const result = await refreshOnDemand(id, mode);
  if (result.skipped && mode === "manual") {
    c.header("Retry-After", "60");
    return c.json({ error: "请等待 60 秒后再刷新" }, 429);
  }
  return c.json(result);
});
export function csv(rows: Record<string, unknown>[]) {
  const keys = [...new Set(rows.flatMap(Object.keys))];
  const cell = (value: unknown) => {
    let s =
      typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
    if (/^[=+@\-\t\r\n]/.test(s)) s = `'${s}`;
    return `"${s.replaceAll('"', '""')}"`;
  };
  return (
    "\uFEFF" +
    [keys, ...rows.map((row) => keys.map((k) => row[k]))]
      .map((row) => row.map(cell).join(","))
      .join("\r\n")
  );
}
app.get("/export", async (c) => {
  const id = c.get("user").id;
  const kind = c.req.query("kind") || "json";
  const data = {
    version: "1.0",
    exportedAt: now(),
    currency: "CNY",
    accounts: await wallets(id),
    instruments: await instruments(id),
    holdings: await holdings(id),
    transactions: await events(id),
    snapshots: await history(id),
    prices: await getDb().price.findMany({
      where: {
        OR: [
          { userId: id },
          {
            userId: null,
            instrument: { legs: { some: { event: { userId: id } } } },
          },
        ],
      },
    }),
    fxRates: await getDb().fxRate.findMany({
      where: { OR: [{ userId: id }, { userId: null }] },
    }),
    profile: await profile(id),
    audit: await getDb().audit.findMany({ where: { userId: id } }),
  };
  if (!["json", "holdings", "transactions", "snapshots"].includes(kind))
    throw new DomainError("导出类型无效");
  c.header(
    "Content-Disposition",
    `attachment; filename="asset-atlas-${kind}-${now().slice(0, 10)}.${kind === "json" ? "json" : "csv"}"`,
  );
  if (kind === "json") return c.json(data);
  c.header("Content-Type", "text/csv; charset=utf-8");
  return c.body(
    csv(
      data[
        kind as "holdings" | "transactions" | "snapshots"
      ] as unknown as Record<string, unknown>[],
    ),
  );
});
app.get("/system", async (c) =>
  c.json({
    scheduleMode: schedulerEnabled() ? "continuous" : "on-demand",
    backupMode: schedulerEnabled() ? "server" : "local",
    jobs: await getDb().job.findMany({}),
    providers: {
      fx: "Frankfurter",
      crypto: "CoinGecko",
      stocks: [
        longportStatus() === "ready"
          ? "港股：长桥已配置，权限以实际请求为准"
          : longportStatus() === "incomplete"
            ? "港股：长桥凭证不完整"
            : "港股：跟随 Twelve Data 配置",
        process.env.TWELVE_DATA_API_KEY
          ? "Twelve Data 已配置（标的搜索及其他股票报价）"
          : "Twelve Data 未配置 · 支持手动",
      ].join("；"),
      funds: process.env.TUSHARE_TOKEN
        ? "已配置，权限以实际请求为准"
        : "未配置 · 支持手动",
      gold: "Gold API · 免费国际现货金价",
    },
  }),
);
app.notFound((c) => c.json({ error: "接口不存在" }, 404));
