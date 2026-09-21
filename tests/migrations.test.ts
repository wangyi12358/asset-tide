import { testConnection, testSchema } from "./database";
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDb, transaction, uid } from "../src/server/db";
import { backup, pgBinary } from "../src/server/backup";
import { ensureProfile, wallets, holdings } from "../src/server/valuation";
import { recordEvent, eventSchema } from "../src/server/ledger";
const execute = promisify(execFile);
test("PostgreSQL serializes concurrent ledger mutations and preserves exact decimals", async () => {
  const id = uid();
  await getDb().user.create({
    data: { id, name: "Concurrency", email: `${id}@example.test` },
  });
  await Promise.all(Array.from({ length: 8 }, () => ensureProfile(id)));
  const account = (await wallets(id))[0].id;
  const input = eventSchema.parse({
    type: "opening",
    accountId: account,
    instrumentId: "cash-cny",
    quantity: "123.45678901",
    occurredAt: "2026-01-01T00:00:00Z",
  });
  const key = uid();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => recordEvent(id, input, key)),
  );
  assert.equal(new Set(results.map((x) => x.id)).size, 1);
  assert.equal(await getDb().ledgerEvent.count({ where: { userId: id } }), 1);
  assert.equal((await holdings(id))[0].quantity, "123.45678901");
  await assert.rejects(
    () =>
      transaction(async () => {
        await getDb().wallet.create({
          data: { id: uid(), userId: id, name: "Rollback", type: "test" },
        });
        throw new Error("rollback");
      }, id),
    /rollback/,
  );
  assert.equal(
    await getDb().wallet.count({ where: { userId: id, name: "Rollback" } }),
    0,
  );
});
test("PostgreSQL backup restores ledger and snapshots into an isolated database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-pg-backup-"));
  const prior = process.env.BACKUP_PATH;
  process.env.BACKUP_PATH = dir;
  const restoreDb = `atlas_restore_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: testConnection });
  await admin.connect();
  try {
    const path = await backup();
    assert.ok(statSync(path).size > 0);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    await admin.query(`CREATE DATABASE "${restoreDb}"`);
    const target = new URL(testConnection);
    target.pathname = `/${restoreDb}`;
    const password = decodeURIComponent(target.password);
    target.password = "";
    await execute(
      pgBinary("pg_restore"),
      [
        "--dbname",
        target.toString(),
        "--no-owner",
        "--no-acl",
        "--exit-on-error",
        path,
      ],
      { env: { ...process.env, PGPASSWORD: password } },
    );
    target.password = password;
    const restored = new Client({ connectionString: target.toString() });
    await restored.connect();
    try {
      for (const [table, count] of [
        ["ledger", await getDb().ledgerEvent.count()],
        ["snapshots", await getDb().snapshot.count()],
      ] as const) {
        assert.equal(
          Number(
            (
              await restored.query(
                `SELECT count(*) FROM "${testSchema}"."${table}"`,
              )
            ).rows[0].count,
          ),
          count,
        );
      }
    } finally {
      await restored.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${restoreDb}"`);
    await admin.end();
    if (prior === undefined) delete process.env.BACKUP_PATH;
    else process.env.BACKUP_PATH = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
