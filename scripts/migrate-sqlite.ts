/** One-time, offline importer. Refuses to merge into a populated PostgreSQL database. */
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { prisma } from "../src/server/db";
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
if (existsSync(".env")) process.loadEnvFile(".env");
const tables = {
  user: "user",
  session: "session",
  account: "account",
  verification: "verification",
  wallets: "wallet",
  instruments: "instrument",
  ledger: "ledgerEvent",
  legs: "leg",
  prices: "price",
  fx_rates: "fxRate",
  profiles: "profile",
  snapshots: "snapshot",
  audit: "audit",
  used_verification_tokens: "usedVerificationToken",
  jobs: "job",
  asset_shares: "assetShare",
  share_wallets: "shareWallet",
  mcp_tokens: "mcpToken",
  mutations: "mutation",
} as const;
async function main() {
  const sourcePath = resolve(process.argv[2] || "data/asset-atlas.db");
  if (!existsSync(sourcePath)) throw new Error("SQLite source does not exist");
  const db = prisma();
  if ((await db.user.count()) || (await db.ledgerEvent.count()))
    throw new Error(
      "Target database contains users or ledger records; import cancelled",
    );
  mkdirSync("backups", { recursive: true, mode: 0o700 });
  const copy = resolve(`backups/sqlite-before-postgresql-${Date.now()}.db`);
  const source = new Database(sourcePath, { readonly: true });
  await source.backup(copy);
  source.close();
  const snapshot = new Database(copy, { readonly: true });
  const report: Record<string, number> = {};
  try {
    if (snapshot.pragma("integrity_check", { simple: true }) !== "ok")
      throw new Error("SQLite integrity check failed");
    await db.$transaction(
      async (tx) => {
        // Seed-only instruments are safe to replace before importing their historical IDs.
        await tx.instrument.deleteMany();
        for (const [table, model] of Object.entries(tables)) {
          const rows = snapshot
            .prepare(
              `SELECT rowid AS __rowid, * FROM "${table}" ORDER BY rowid`,
            )
            .all() as Record<string, any>[];
          const positions = new Map<string, number>();
          const data = rows.map(({ __rowid, ...row }) => {
            if (
              ["user", "session", "account", "verification"].includes(table)
            ) {
              for (const key of [
                "createdAt",
                "updatedAt",
                "expiresAt",
                "accessTokenExpiresAt",
                "refreshTokenExpiresAt",
              ]) {
                if (row[key] != null) row[key] = new Date(row[key]);
              }
              if (table === "verification") {
                row.createdAt ||= new Date(0);
                row.updatedAt ||= row.createdAt;
              }
            }
            if (table === "user") row.emailVerified = !!row.emailVerified;
            if (table === "legs") {
              row.position = positions.get(row.eventId) || 0;
              positions.set(row.eventId, row.position + 1);
            }
            if (table === "fx_rates") row.sequence = __rowid;
            return row;
          });
          // Fixed internal model names; financial decimals are copied as strings without rounding.
          const delegate = (tx as unknown as Record<string, unknown>)[
            model
          ] as unknown as {
            createMany(input: {
              data: Record<string, any>[];
            }): Promise<unknown>;
            count(): Promise<number>;
          };
          for (let offset = 0; offset < data.length; offset += 500)
            await delegate.createMany({
              data: data.slice(offset, offset + 500),
            });
          if ((await delegate.count()) !== rows.length)
            throw new Error(`Row count mismatch: ${table}`);
          report[table] = rows.length;
        }
        await tx.$executeRaw`SELECT setval(pg_get_serial_sequence('fx_rates', 'sequence'), COALESCE((SELECT MAX(sequence) FROM fx_rates), 1), EXISTS(SELECT 1 FROM fx_rates))`;
      },
      { timeout: 120000 },
    );
    console.log(
      "Import completed; verified all table row counts.",
      JSON.stringify(report),
    );
    console.log("SQLite backup retained at", copy);
  } finally {
    snapshot.close();
  }
}
main()
  .catch(() => {
    console.error(
      "Import failed. PostgreSQL import was rolled back; original SQLite file is unchanged. Check schema/source and retry against an empty database.",
    );
    process.exitCode = 1;
  })
  .finally(() => prisma().$disconnect());
