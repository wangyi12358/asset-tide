#!/usr/bin/env node
// AssetAtlas stdio -> Streamable HTTP bridge. Node.js >= 22; no dependencies.
import { createInterface } from "node:readline";
const rawUrl = process.env.ASSET_ATLAS_URL;
const token = process.env.ASSET_ATLAS_TOKEN;
let endpoint;
try {
  endpoint = new URL("/api/mcp", rawUrl);
  if (
    endpoint.username ||
    endpoint.password ||
    (endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
      ))
  )
    throw new Error();
  if (!token?.startsWith("aat_")) throw new Error();
} catch {
  console.error(
    "Set ASSET_ATLAS_URL (HTTPS, or HTTP localhost) and ASSET_ATLAS_TOKEN. Node.js 22+ required.",
  );
  process.exit(1);
}
let version = "2025-11-25";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
async function forward(line) {
  let message;
  try {
    if (Buffer.byteLength(line) > 128 * 1024) throw new Error();
    message = JSON.parse(line);
  } catch {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Invalid or oversized JSON" },
    });
    return;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid request" },
    });
    return;
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": version,
      },
      body: JSON.stringify(message),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (response.status === 202 || response.status === 204) return;
    const body = await response.json();
    if (message.method === "initialize" && body.result?.protocolVersion)
      version = body.result.protocolVersion;
    send(body);
  } catch (error) {
    if (Object.hasOwn(message, "id"))
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: `AssetAtlas connection failed (${error instanceof Error && /^HTTP \d+$/.test(error.message) ? error.message : "network or configuration error"})`,
        },
      });
    else console.error("AssetAtlas notification could not be delivered.");
  }
}
// Serialize initialization and notifications; keep stdout reserved for MCP messages.
let pending = Promise.resolve();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (line.trim()) pending = pending.then(() => forward(line));
});
lines.on("close", () => {
  void pending;
});
