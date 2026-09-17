/**
 * Core smoke test: build a server with the ping tool over an in-memory client<->server pair.
 * Proves the shared package builds, wires the MCP SDK, and serves a tool call end-to-end.
 * Run: npm run smoke (exits non-zero on failure)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, pingTool } from "../src/index.js";

const server = buildServer([pingTool], { name: "core-smoke" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "smoke", version: "0.0.0" });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

const names = (await client.listTools()).tools.map((t) => t.name);
const pong = await client.callTool({ name: "ping", arguments: {} });
const body = pong.structuredContent as { pong: boolean; time: string };

await client.close();
await server.close();

const ok = names.length === 1 && names.includes("ping") && body.pong === true && typeof body.time === "string";
if (!ok) {
  console.error("CORE SMOKE FAIL");
  process.exit(1);
}
console.log("CORE SMOKE OK");
process.exit(0);