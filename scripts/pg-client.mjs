#!/usr/bin/env node
// Optional local fallback when native PostgreSQL clients cannot run.
// Uses an official client container; does not start another database server.
import { spawn } from "node:child_process";
import { dirname, basename, resolve } from "node:path";
import { realpathSync } from "node:fs";
const command = process.argv[2];
if (!["pg_dump", "pg_restore"].includes(command))
  throw Error("Expected pg_dump or pg_restore");
const args = process.argv.slice(3),
  mounts = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dbname") {
    const url = new URL(args[++i]);
    if (["localhost", "127.0.0.1"].includes(url.hostname))
      url.hostname = "host.docker.internal";
    args[i] = url.toString();
  } else if (args[i] === "--file") {
    const path = resolve(args[++i]);
    mounts.push(
      "--mount",
      `type=bind,src=${realpathSync(dirname(path))},dst=/backup`,
    );
    args[i] = `/backup/${basename(path)}`;
  } else if (
    command === "pg_restore" &&
    !args[i].startsWith("-") &&
    i === args.length - 1
  ) {
    const path = resolve(args[i]);
    mounts.push(
      "--mount",
      `type=bind,src=${realpathSync(dirname(path))},dst=/backup,readonly`,
    );
    args[i] = `/backup/${basename(path)}`;
  }
}
const child = spawn(
  "docker",
  [
    "run",
    "--rm",
    "--add-host=host.docker.internal:host-gateway",
    "--env",
    "PGPASSWORD",
    ...mounts,
    "postgres:15-bookworm",
    command,
    ...args,
  ],
  { stdio: "inherit", env: process.env },
);
child.on("error", () => {
  console.error("Docker PostgreSQL client unavailable");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
