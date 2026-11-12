import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createLocalServer } from "../src/stdio.mjs";
import { readFacets } from "../src/core/facets.mjs";
import { queryWords, sizeFromQuery } from "../src/core/text.mjs";

const indexFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "site", "index", "v1");
const server = createLocalServer(indexFolder);
let nextId = 1;

async function rpc(method, params) {
  return server.handle({ jsonrpc: "2.0", id: nextId++, method, params });
}

async function tool(name, args) {
  const response = await rpc("tools/call", { name, arguments: args });
  return response.result.structuredContent;
}

test("words are cut the same way for the index and the query", () => {
  assert.deepEqual(queryWords("Wooden chairs for the kitchen"), ["wood", "chair", "kitchen"]);
  assert.deepEqual(queryWords("a couch"), ["sofa"]);
  assert.equal(sizeFromQuery("rock 45 cm"), 0.45);
  assert.equal(sizeFromQuery("crate 2m"), 2);
  assert.equal(sizeFromQuery("crate"), null);
});

test("initialize answers with the asked protocol version and tools capability", async () => {
  const response = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(response.result.protocolVersion, "2025-06-18");
  assert.ok(response.result.capabilities.tools);
  const listed = await rpc("tools/list", {});
  assert.deepEqual(listed.result.tools.map((entry) => entry.name), ["search_assets", "get_asset", "list_sources", "find_elsewhere"]);
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal((await rpc("no/such", {})).error.code, -32601);
});

test("search finds chairs with a real size and respects the size filter", async () => {
  const found = await tool("search_assets", { query: "chair 0.9 m", glb_only: true, limit: 10 });
  assert.ok(found.count > 0);
  for (const result of found.results) {
    assert.equal(result.glb_ready, true);
    const largest = Math.max(...result.size_m);
    assert.ok(largest >= 0.4 && largest <= 2, `size ${largest} out of range`);
  }
});

test("the asked-for thing ranks above things that only mention it", async () => {
  const found = await tool("search_assets", { query: "wooden chair", limit: 3 });
  for (const result of found.results) assert.match(result.category ?? "", /chair/, result.title);
});

test("search results carry a thumbnail for ABO and ambientCG", async () => {
  const abo = await tool("search_assets", { query: "armchair", sources: ["abo-glb"], limit: 1 });
  assert.match(abo.results[0].thumbnail, /abo-glb\/resolve\/main\/thumbs\/.+\.webp$/);
  const ambient = await tool("search_assets", { query: "wood", sources: ["ambientcg"], limit: 1 });
  assert.match(ambient.results[0].thumbnail, /^https:\/\/acg-media\..+\.png$/);
});

test("licence filters hold for every result", async () => {
  const cc0 = await tool("search_assets", { query: "rock", licence: "cc0", limit: 50 });
  assert.ok(cc0.count > 0);
  for (const result of cc0.results) assert.ok(["CC0-1.0", "public-domain"].includes(result.licence), result.licence);
  const shippable = await tool("search_assets", { query: "rock", licence: "shippable", no_share_alike: true, limit: 50 });
  for (const result of shippable.results) {
    assert.ok(!result.licence.startsWith("LicenseRef-"));
    assert.ok(!result.licence.startsWith("CC-BY-SA"));
  }
});

test("kind and source filters hold", async () => {
  const hdri = await tool("search_assets", { query: "sunset", kind: "hdri", limit: 20 });
  assert.ok(hdri.count > 0);
  for (const result of hdri.results) assert.equal(result.kind, "hdri");
  const kenney = await tool("search_assets", { query: "crate", sources: ["kenney"], limit: 20 });
  for (const result of kenney.results) assert.equal(result.source, "kenney");
});

test("an empty query with filters returns the best-ranked matching assets", async () => {
  const found = await tool("search_assets", { query: "", kind: "animation", limit: 5 });
  assert.equal(found.count, 5);
  for (const result of found.results) assert.equal(result.kind, "animation");
});

test("get_asset gives GLB tiers, a size and a credit for a pack asset", async () => {
  const found = await tool("search_assets", { query: "office chair", sources: ["abo-glb"], limit: 1 });
  const asset = await tool("get_asset", { id: found.results[0].id });
  // ABO's engine tier carries KTX2 textures, so the default is the web tier, which needs only MeshoptDecoder.
  assert.equal(asset.tier, "web");
  assert.deepEqual(asset.needs, ["MeshoptDecoder"]);
  assert.match(asset.glb_url, /^https:\/\/huggingface\.co\/datasets\/codepawl\/abo-glb\/resolve\/main\/objects\//);
  assert.deepEqual(asset.tiers.engine.needs, ["KTX2Loader"]);
  assert.match(asset.load_three, /setMeshoptDecoder/);
  assert.equal(asset.size_m.length, 3);
  assert.match(asset.credit, /CC BY 4\.0/);
  assert.equal(asset.credit_needed, true);
});

test("packs whose engine tier needs no decoder default to it", async () => {
  const found = await tool("search_assets", { query: "chair", sources: ["scanned-objects-glb", "google-poly-glb"], limit: 3 });
  assert.ok(found.count > 0);
  for (const result of found.results) {
    const asset = await tool("get_asset", { id: result.id });
    assert.equal(asset.tier, "engine", result.id);
    assert.deepEqual(asset.needs, []);
  }
});

test("Megascans comes back as a link only", async () => {
  const found = await tool("search_assets", { query: "rock", sources: ["megascans"], limit: 1 });
  const asset = await tool("get_asset", { id: found.results[0].id });
  assert.equal(asset.link_only, true);
  assert.match(asset.url, /^https:\/\/www\.fab\.com\/listings\//);
  assert.equal(asset.glb_url, undefined);
});

test("unknown ids and tools fail clearly", async () => {
  const missing = await rpc("tools/call", { name: "get_asset", arguments: { id: "nope:nothing" } });
  assert.equal(missing.result.isError, true);
  const unknown = await rpc("tools/call", { name: "delete_everything", arguments: {} });
  assert.equal(unknown.error.code, -32602);
  const badKind = await rpc("tools/call", { name: "search_assets", arguments: { query: "x", kind: "spaceship" } });
  assert.equal(badKind.result.isError, true);
});

test("list_sources and find_elsewhere answer", async () => {
  const sources = await tool("list_sources", {});
  assert.ok(sources.assets > 70000);
  assert.ok(sources.sources.some((source) => source.source === "abo-glb"));
  const elsewhere = await tool("find_elsewhere", { query: "red barn", kind: "model" });
  assert.ok(elsewhere.sources.length >= 5);
  assert.ok(elsewhere.sources.every((source) => source.url.includes("red%20barn")));
});

test("facets agree with the records they describe", async () => {
  const facets = await server.index.facets();
  const manifest = await server.index.manifest();
  for (const number of [0, 1000, 20000, 41000, 60000, facets.length - 1]) {
    const [record] = await server.index.documents([number]);
    const facts = readFacets(facets[number]);
    assert.equal(facts.kind, record.kind, record.id);
    assert.equal(manifest.sources[facts.sourceIndex], record.source, record.id);
    assert.equal(facts.glbReady, Boolean(record.tiers), record.id);
  }
});
