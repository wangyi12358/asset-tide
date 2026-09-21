import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
const content = readFileSync(
  new URL("../.env.docker.example", import.meta.url),
  "utf8",
)
  .replace(
    "BETTER_AUTH_SECRET=",
    `BETTER_AUTH_SECRET=${randomBytes(48).toString("base64url")}`,
  )
  .replace(
    "POSTGRES_PASSWORD=",
    `POSTGRES_PASSWORD=${randomBytes(32).toString("hex")}`,
  );
try {
  writeFileSync(new URL("../.env.docker", import.meta.url), content, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    "Created .env.docker with a random secret. Set your URL and optional provider keys, then run: docker compose --env-file .env.docker up --build -d",
  );
} catch (error) {
  if (error.code === "EEXIST")
    console.log(".env.docker already exists; it was not modified.");
  else throw error;
}
