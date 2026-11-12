import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createLocalServer } from "../src/stdio.mjs";
import { createTools } from "../src/core/tools.mjs";
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

test("everyday names find the library's word, and robots carry a measured size", async () => {
  assert.deepEqual(queryWords("robot dog"), ["quadruped", "robot"]);
  const found = await tool("search_assets", { query: "robot dog", limit: 3 });
  for (const result of found.results) {
    assert.equal(result.source, "menagerie-glb", result.title);
    assert.equal(result.size_m.length, 3);
  }
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
  // "kenney" still works as a source name and now gives the repacked GLBs.
  const kenney = await tool("search_assets", { query: "crate", sources: ["kenney"], limit: 20 });
  assert.ok(kenney.count > 0);
  for (const result of kenney.results) {
    assert.equal(result.source, "kenney-glb");
    assert.equal(result.glb_ready, true);
  }
  const asset = await tool("get_asset", { id: kenney.results[0].id });
  assert.equal(asset.tier, "engine");
  assert.match(asset.credit, /Kenney \(kenney\.nl\), CC0/);
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

test("Objaverse links out to Sketchfab and serves no copy", async () => {
  const found = await tool("search_assets", { query: "skull", sources: ["objaverse-clean-glb"], limit: 1 });
  assert.equal(found.results[0].glb_ready, false);
  assert.match(found.results[0].link_only, /sketchfab/);
  const asset = await tool("get_asset", { id: found.results[0].id });
  assert.equal(asset.link_only, true);
  assert.match(asset.url, /^https:\/\/sketchfab\.com\//);
  assert.equal(asset.glb_url, undefined);
  const glbOnly = await tool("search_assets", { query: "skull", glb_only: true, limit: 50 });
  assert.ok(glbOnly.results.every((result) => result.source !== "objaverse-clean-glb"));
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

// ---------- generate_asset and get_generation, with a stub KV and a stub Hugging Face ----------

const GENERATED_BASE = "https://huggingface.co/datasets/codepawl/generated-glb/resolve/main";

function stubKv() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function stubCache() {
  const stored = new Map();
  return {
    async match(request) {
      return stored.get(request.url)?.clone();
    },
    async put(request, response) {
      stored.set(request.url, response);
    },
  };
}

// files: path under the dataset to JSON; anything else answers 404.
function stubHuggingFace(files) {
  return async (url) => {
    const path = String(url).replace(`${GENERATED_BASE}/`, "");
    return path in files ? new Response(JSON.stringify(files[path]), { status: 200 }) : new Response("missing", { status: 404 });
  };
}

function generationTools({ files = {}, kv = stubKv(), clock = { now: Date.parse("2026-11-12T12:00:00Z") }, clientIp = "203.0.113.5" } = {}) {
  const tools = createTools({
    index: server.index,
    fetchImpl: stubHuggingFace(files),
    generation: { kv, cache: stubCache(), clientIp, now: () => clock.now },
  });
  return { tools, kv, clock };
}

const MISSING_PROMPT = "zzqxv pepper grinder";

function finishedRecord(jobId) {
  return {
    id: jobId,
    title: MISSING_PROMPT,
    model: "TRELLIS.2 via fal",
    licence: "MIT",
    credit: `Generated by CodePawl with TRELLIS.2 (MIT) from: ${MISSING_PROMPT}`,
    files: { web: `generated/${jobId}/web.glb`, lod1: `generated/${jobId}/lod1.glb`, engine: `generated/${jobId}/engine.glb` },
    tier_requirements: { web: ["EXT_meshopt_compression"], lod1: [], engine: [] },
    triangles: { engine: 189117, lod1: 25000, web: 25000 },
    thumbnail: `generated/${jobId}/thumbnail.webp`,
    file_units: "longest side about 1 unit; scale to your scene",
    scale: 0.25,
    size_m: [0.1, 0.25, 0.1],
  };
}

async function queuedJobId() {
  const { tools } = generationTools();
  return (await tools.call("generate_asset", { prompt: MISSING_PROMPT })).job_id;
}

test("the hosted gate lists six tools and the local one four", () => {
  const names = (tools) => tools.definitions.map((definition) => definition.name);
  assert.deepEqual(names(generationTools().tools), ["search_assets", "get_asset", "list_sources", "find_elsewhere", "generate_asset", "get_generation"]);
  assert.equal(names(createTools({ index: server.index })).length, 4);
});

test("generate_asset skips generation when a search matches every word", async () => {
  const { tools, kv } = generationTools();
  const answer = await tools.call("generate_asset", { prompt: "wooden chair" });
  assert.equal(answer.status, "skipped");
  assert.equal(answer.note, "generation skipped: found existing assets");
  assert.ok(answer.results.length > 0);
  assert.equal(kv.store.size, 0);
});

test("generate_asset queues a miss once and the same request does not queue twice", async () => {
  const { tools, kv } = generationTools();
  const first = await tools.call("generate_asset", { prompt: MISSING_PROMPT, size_m: 0.25 });
  assert.equal(first.status, "queued");
  assert.match(first.job_id, /^[0-9a-f]{12}$/);
  const again = await tools.call("generate_asset", { prompt: `  ${MISSING_PROMPT.toUpperCase()} `, size_m: 0.25 });
  assert.equal(again.job_id, first.job_id);
  const queue = JSON.parse(kv.store.get("queue"));
  assert.equal(queue.length, 1);
  assert.deepEqual({ prompt: queue[0].prompt, size_m: queue[0].size_m, image_url: queue[0].image_url }, { prompt: MISSING_PROMPT, size_m: 0.25, image_url: null });
  assert.equal(kv.store.get("ip:203.0.113.5:2026-11-12"), "1");
  const other = await tools.call("generate_asset", { prompt: MISSING_PROMPT, image_url: "https://example.com/grinder.png" });
  assert.notEqual(other.job_id, first.job_id);
});

test("generate_asset returns a finished job from Hugging Face without queueing", async () => {
  const jobId = await queuedJobId();
  const { tools, kv } = generationTools({ files: { [`generated/${jobId}/record.json`]: finishedRecord(jobId) } });
  const answer = await tools.call("generate_asset", { prompt: MISSING_PROMPT });
  assert.equal(answer.status, "done");
  assert.equal(answer.ai_generated, true);
  assert.equal(answer.licence, "MIT");
  assert.equal(answer.scale_to_apply, 0.25);
  assert.equal(answer.glb_url, `${GENERATED_BASE}/generated/${jobId}/lod1.glb`);
  assert.deepEqual(answer.tiers.web.needs, ["MeshoptDecoder"]);
  assert.equal(kv.store.size, 0);
});

test("generate_asset allows 5 new jobs per IP per day, then answers no result", async () => {
  const { tools, clock } = generationTools();
  for (let number = 1; number <= 5; number += 1) {
    assert.equal((await tools.call("generate_asset", { prompt: `${MISSING_PROMPT} ${number}` })).status, "queued");
  }
  const sixth = await tools.call("generate_asset", { prompt: `${MISSING_PROMPT} 6` });
  assert.equal(sixth.status, "no_result");
  assert.deepEqual(sixth.results, []);
  assert.match(sixth.message, /per IP per day/);
  clock.now += 25 * 3600 * 1000;
  assert.equal((await tools.call("generate_asset", { prompt: `${MISSING_PROMPT} 6` })).status, "queued");
});

test("generate_asset stops at 50 live jobs in all", async () => {
  const kv = stubKv();
  for (let number = 0; number < 50; number += 1) {
    const { tools } = generationTools({ kv, clientIp: `198.51.100.${number}` });
    assert.equal((await tools.call("generate_asset", { prompt: `${MISSING_PROMPT} ${number}` })).status, "queued");
  }
  const { tools } = generationTools({ kv, clientIp: "192.0.2.1" });
  const answer = await tools.call("generate_asset", { prompt: `${MISSING_PROMPT} extra` });
  assert.equal(answer.status, "no_result");
  assert.match(answer.message, /queue is full/);
});

test("generate_asset rejects bad input", async () => {
  const { tools } = generationTools();
  assert.ok((await tools.call("generate_asset", { prompt: "" })).error);
  assert.ok((await tools.call("generate_asset", { prompt: MISSING_PROMPT, image_url: "http://example.com/a.png" })).error);
  assert.ok((await tools.call("generate_asset", { prompt: MISSING_PROMPT, size_m: -1 })).error);
});

test("get_generation reports queued, running, done, failed and timed out", async () => {
  const queuedSetup = generationTools();
  const jobId = (await queuedSetup.tools.call("generate_asset", { prompt: MISSING_PROMPT })).job_id;
  const status = (state, extra = {}) => ({ [`generated/${jobId}/status.json`]: { job_id: jobId, status: state, updated: "2026-11-12T12:01:00Z", ...extra } });
  assert.equal((await queuedSetup.tools.call("get_generation", { job_id: jobId })).status, "queued");

  const running = generationTools({ kv: queuedSetup.kv, files: status("running") });
  assert.equal((await running.tools.call("get_generation", { job_id: jobId })).status, "running");

  const done = generationTools({ kv: queuedSetup.kv, files: { ...status("done"), [`generated/${jobId}/record.json`]: finishedRecord(jobId) } });
  const doneAnswer = await done.tools.call("get_generation", { job_id: jobId });
  assert.equal(doneAnswer.status, "done");
  assert.equal(doneAnswer.ai_generated, true);
  assert.match(doneAnswer.glb_url, /generated-glb\/resolve\/main\/generated\//);

  const failed = generationTools({ kv: queuedSetup.kv, files: status("failed", { reason: "generation unavailable" }) });
  assert.deepEqual(await failed.tools.call("get_generation", { job_id: jobId }), { status: "failed", job_id: jobId, reason: "generation unavailable", results: [] });

  const late = generationTools({ kv: queuedSetup.kv, clock: { now: Date.parse("2026-11-12T12:31:00Z") } });
  assert.deepEqual(await late.tools.call("get_generation", { job_id: jobId }), { status: "failed", job_id: jobId, reason: "timed out", results: [] });

  assert.ok((await late.tools.call("get_generation", { job_id: "0123456789ab" })).error);
  assert.ok((await late.tools.call("get_generation", { job_id: "nope" })).error);
});

test("a status from before a retry does not hide the new queued job", async () => {
  const jobId = await queuedJobId();
  const oldFailure = { [`generated/${jobId}/status.json`]: { status: "failed", reason: "generation unavailable", updated: "2026-11-12T10:00:00Z" } };
  const { tools } = generationTools({ files: oldFailure });
  await tools.call("generate_asset", { prompt: MISSING_PROMPT });
  assert.equal((await tools.call("get_generation", { job_id: jobId })).status, "queued");
});

test("a dataset that does not exist yet (HTTP 401) reads as no result, not an error", async () => {
  const tools = createTools({
    index: server.index,
    fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    generation: { kv: stubKv(), cache: stubCache() },
  });
  assert.equal((await tools.call("generate_asset", { prompt: MISSING_PROMPT })).status, "queued");
});
