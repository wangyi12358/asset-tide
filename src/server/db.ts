import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "@/generated/prisma/client";
const globalDb = globalThis as unknown as {
  atlasPrisma?: PrismaClient;
  atlasTransaction?: AsyncLocalStorage<Prisma.TransactionClient>;
};
const context = (globalDb.atlasTransaction ||=
  new AsyncLocalStorage<Prisma.TransactionClient>());
export function prisma() {
  if (!globalDb.atlasPrisma) {
    const connectionString =
      process.env.DATABASE_URL ||
      "postgresql://postgres:postgres@127.0.0.1:5432/asset_atlas";
    globalDb.atlasPrisma = new PrismaClient({
      adapter: new PrismaPg(
        {
          connectionString,
          max: process.env.VERCEL === "1" ? 3 : 10,
          connectionTimeoutMillis: 15000,
          idleTimeoutMillis: 10000,
          allowExitOnIdle: true,
        },
        {
          schema:
            new URL(connectionString).searchParams.get("schema") || "public",
        },
      ),
    });
  }
  return globalDb.atlasPrisma;
}
export function getDb(): Prisma.TransactionClient {
  return context.getStore() || prisma();
}
export async function transaction<T>(
  fn: () => Promise<T>,
  lockKey?: string,
): Promise<T> {
  if (context.getStore()) return fn();
  return prisma().$transaction(
    async (tx) => {
      // Serialize each user's ledger across processes, without locking unrelated users.
      if (lockKey)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      return context.run(tx, fn);
    },
    { maxWait: 15000, timeout: 60000 },
  );
}
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
