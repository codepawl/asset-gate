// Turns queued generate_asset jobs into GLB files on Hugging Face. Runs on the owner's PC, never on Cloudflare:
// the fal key (~/.config/fal/.env) and the Hugging Face login (the `hf` CLI) stay on this machine.
//
//   node scripts/gen-processor.mjs --once    one pass over the queue
//   node scripts/gen-processor.mjs --watch   a pass every 60 seconds
//
// Per job: FLUX schnell makes a reference picture (text prompts only), TRELLIS.2 makes the model, the GLB is checked,
// cut into engine / lod1 / web tiers and uploaded with a record.json and, last, a status.json.
// Tooling (gltf-transform, meshoptimizer, sharp) installs under ~/.cache/asset-gate-tools, not into this package.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const QUEUE_URL = process.env.GEN_QUEUE_URL ?? "https://assets.codepawl.com/gen/queue";
const REPO = "codepawl/generated-glb";
const REPO_URL = `https://huggingface.co/datasets/${REPO}/resolve/main`;
const FLUX_ENDPOINT = "fal-ai/flux/schnell";
const TRELLIS_ENDPOINT = "fal-ai/trellis-2";
const PRICE_USD = { [FLUX_ENDPOINT]: 0.003, [TRELLIS_ENDPOINT]: 0.3 };
const MONTHLY_CAP_USD = 20;
const LOD1_TRIANGLES = 25000;
const MIN_TRIANGLES = 500;
const POLL_SECONDS = 60;
const STALE_RUNNING_MS = 20 * 60 * 1000;
const FAL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const CONFIG_FOLDER = join(homedir(), ".config", "asset-gate");
const LEDGER_PATH = join(CONFIG_FOLDER, "gen-ledger.json");
const TOOLS_FOLDER = join(homedir(), ".cache", "asset-gate-tools");
const TOOL_PACKAGES = ["@gltf-transform/core", "@gltf-transform/extensions", "@gltf-transform/functions", "meshoptimizer", "sharp"];
const TIER_REQUIREMENTS = { web: ["EXT_meshopt_compression"], lod1: [], engine: [] };
const CARD = `---
license: mit
pretty_name: Generated 3D models (TRELLIS.2)
tags: [3d, glb, ai-generated]
---

# Generated 3D models

GLB models generated on request through the free 3D assets MCP server (https://assets.codepawl.com) when nothing in
its libraries fit. Made with TRELLIS.2 (MIT) by CodePawl and marked AI-generated. One folder per job under
\`generated/<job_id>/\`: \`engine.glb\` (about 190k triangles), \`lod1.glb\` (about 25k), \`web.glb\` (25k with meshopt and
WebP textures, needs MeshoptDecoder), \`thumbnail.webp\`, the input image, \`record.json\` and \`status.json\`.
\`metadata.jsonl\` lists every model. Licence: MIT.
`;

class Unavailable extends Error {}

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

// ---------- fal ----------

function readFalKey() {
  const text = readFileSync(join(homedir(), ".config", "fal", ".env"), "utf8");
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith("FAL_KEY="));
  if (!line) throw new Error("FAL_KEY missing in ~/.config/fal/.env");
  return line.slice("FAL_KEY=".length).trim().replace(/^["']|["']$/g, "");
}

function readLedger() {
  const month = new Date().toISOString().slice(0, 7);
  const stored = existsSync(LEDGER_PATH) ? JSON.parse(readFileSync(LEDGER_PATH, "utf8")) : null;
  return stored?.month === month ? stored : { month, total_usd: 0, calls: [] };
}

function writeLedger(ledger) {
  mkdirSync(CONFIG_FOLDER, { recursive: true });
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 1));
}

// Books the price before the call and hands back a function that takes it back if fal refuses the call.
function reserve(label, usd) {
  const ledger = readLedger();
  if (ledger.total_usd + usd > MONTHLY_CAP_USD) throw new Unavailable(`monthly cap $${MONTHLY_CAP_USD} reached`);
  ledger.total_usd = Math.round((ledger.total_usd + usd) * 1000) / 1000;
  ledger.calls.push({ when: new Date().toISOString(), label, usd });
  writeLedger(ledger);
  return function release() {
    const current = readLedger();
    current.total_usd = Math.max(0, Math.round((current.total_usd - usd) * 1000) / 1000);
    current.calls.push({ when: new Date().toISOString(), label: `${label} refused, not billed`, usd: -usd });
    writeLedger(current);
  };
}

async function falRequest(url, key, options = {}) {
  const response = await fetch(url, { ...options, headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" } });
  if (response.ok) return response.json();
  const body = (await response.text()).slice(0, 300);
  if ([401, 402, 403].includes(response.status) || /balance|locked|exhausted/i.test(body)) throw new Unavailable(`fal refused: HTTP ${response.status}`);
  throw new Error(`fal HTTP ${response.status}: ${body}`);
}

async function runFal(endpoint, input, key) {
  const release = reserve(endpoint, PRICE_USD[endpoint]);
  try {
    const job = await falRequest(`https://queue.fal.run/${endpoint}`, key, { method: "POST", body: JSON.stringify(input) });
    const deadline = Date.now() + FAL_TIMEOUT_MS;
    for (;;) {
      const status = await falRequest(job.status_url, key);
      if (status.status === "COMPLETED") return await falRequest(job.response_url, key);
      if (Date.now() > deadline) throw new Error(`fal timed out on ${endpoint}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  } catch (error) {
    if (error instanceof Unavailable) release();
    throw error;
  }
}

function findFileUrl(node, suffix) {
  if (Array.isArray(node)) return node.map((item) => findFileUrl(item, suffix)).find(Boolean);
  if (node && typeof node === "object") {
    if (typeof node.url === "string" && node.url.split("?")[0].endsWith(suffix)) return node.url;
    return Object.values(node).map((item) => findFileUrl(item, suffix)).find(Boolean);
  }
  return undefined;
}

// ---------- images ----------

function isPublicHost(hostname) {
  if (!hostname.includes(".") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return false;
  return !/^\d+\.\d+\.\d+\.\d+$/.test(hostname) && !hostname.includes(":");
}

async function downloadBytes(url, limit) {
  let current = url;
  for (let hop = 0; hop < 4; hop += 1) {
    const parsed = new URL(current);
    if (parsed.protocol !== "https:" || !isPublicHost(parsed.hostname)) throw new Error("image URL is not a public https address");
    const response = await fetch(current, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      current = new URL(response.headers.get("location"), current).href;
      continue;
    }
    if (!response.ok) throw new Error(`download HTTP ${response.status}`);
    if (Number(response.headers.get("content-length")) > limit) throw new Error("download too large");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error("download too large");
    return bytes;
  }
  throw new Error("too many redirects");
}

// ---------- model tooling ----------

export function loadTooling() {
  const requireFromTools = createRequire(join(TOOLS_FOLDER, "package.json"));
  try {
    for (const name of TOOL_PACKAGES) requireFromTools.resolve(name);
  } catch {
    log("installing gltf-transform, meshoptimizer and sharp under ~/.cache/asset-gate-tools");
    mkdirSync(TOOLS_FOLDER, { recursive: true });
    writeFileSync(join(TOOLS_FOLDER, "package.json"), JSON.stringify({ name: "asset-gate-tools", private: true, type: "commonjs" }));
    const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", ...TOOL_PACKAGES], { cwd: TOOLS_FOLDER, shell: true, stdio: "inherit" });
    if (install.status !== 0) throw new Error("could not install the model tooling");
  }
  return {
    core: requireFromTools("@gltf-transform/core"),
    extensions: requireFromTools("@gltf-transform/extensions"),
    functions: requireFromTools("@gltf-transform/functions"),
    meshopt: requireFromTools("meshoptimizer"),
    sharp: requireFromTools("sharp"),
  };
}

function countTriangles(document) {
  let triangles = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if ((primitive.getMode() ?? 4) !== 4) continue;
      const indices = primitive.getIndices();
      triangles += Math.floor((indices ? indices.getCount() : primitive.getAttribute("POSITION")?.getCount() ?? 0) / 3);
    }
  }
  return triangles;
}

function allPositionsFinite(document) {
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const array = primitive.getAttribute("POSITION")?.getArray();
      if (!array) return false;
      for (let index = 0; index < array.length; index += 1) if (!Number.isFinite(array[index])) return false;
    }
  }
  return true;
}

// Returns { triangles, extents } or throws with the reason the model is unusable.
function checkModel(document, tooling) {
  if (document.getRoot().listMeshes().length < 1) throw new Error("no mesh");
  const triangles = countTriangles(document);
  if (triangles <= MIN_TRIANGLES) throw new Error(`only ${triangles} triangles`);
  if (!allPositionsFinite(document)) throw new Error("non-finite positions");
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  const bounds = tooling.functions.getBounds(scene);
  const extents = bounds.max.map((value, axis) => value - bounds.min[axis]);
  const longest = Math.max(...extents);
  if (!(longest > 0) || extents.some((extent) => extent < longest * 0.005)) throw new Error(`flat bounding box ${extents.map((value) => value.toFixed(3)).join(" x ")}`);
  return { triangles, extents };
}

export async function buildTiers(engineBytes, tooling) {
  const { core, extensions, functions, meshopt, sharp } = tooling;
  await Promise.all([meshopt.MeshoptDecoder.ready, meshopt.MeshoptEncoder.ready, meshopt.MeshoptSimplifier.ready]);
  const io = new core.NodeIO()
    .registerExtensions(extensions.ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": meshopt.MeshoptDecoder, "meshopt.encoder": meshopt.MeshoptEncoder });
  io.setLogger(new core.Logger(core.Logger.Verbosity.WARN));
  const document = await io.readBinary(engineBytes);
  document.setLogger(new core.Logger(core.Logger.Verbosity.WARN));
  const { triangles, extents } = checkModel(document, tooling);

  // One pass can stop short on UV seams, so simplify again toward the target a few times.
  await document.transform(functions.weld());
  let lod1Triangles = triangles;
  for (let pass = 0; pass < 4 && lod1Triangles > LOD1_TRIANGLES * 1.1; pass += 1) {
    await document.transform(functions.simplify({ simplifier: meshopt.MeshoptSimplifier, ratio: LOD1_TRIANGLES / lod1Triangles, error: 0.1 }));
    lod1Triangles = countTriangles(document);
  }
  await document.transform(functions.prune());
  const lod1 = Buffer.from(await io.writeBinary(document));

  await document.transform(
    functions.textureCompress({ encoder: sharp, targetFormat: "webp", resize: [1024, 1024] }),
    functions.meshopt({ encoder: meshopt.MeshoptEncoder, level: "medium" }),
  );
  const web = Buffer.from(await io.writeBinary(document));
  return { extents, triangles: { engine: triangles, lod1: lod1Triangles, web: lod1Triangles }, buffers: { engine: engineBytes, lod1, web } };
}

// ---------- Hugging Face ----------

function hf(args) {
  const run = spawnSync("hf", args, { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`hf ${args[0]} failed: ${(run.stderr || run.stdout || "").slice(0, 300)}`);
}

function upload(localPath, repoPath, message) {
  hf(["upload", REPO, localPath, repoPath, "--repo-type", "dataset", "--commit-message", message]);
}

async function readRemoteJson(path) {
  const response = await fetch(`${REPO_URL}/${path}?t=${Date.now()}`);
  if ([401, 404].includes(response.status)) return null; // 401: the dataset does not exist yet
  if (!response.ok) throw new Error(`Hugging Face HTTP ${response.status} for ${path}`);
  return response.json();
}

async function ensureRepository(workFolder) {
  if ((await fetch(`${REPO_URL}/README.md`)).ok) return;
  hf(["repos", "create", REPO, "--repo-type", "dataset", "--exist-ok"]);
  const cardPath = join(workFolder, "README.md");
  writeFileSync(cardPath, CARD);
  upload(cardPath, "README.md", "Add dataset card");
}

function publishStatus(workFolder, jobId, status, reason) {
  const path = join(workFolder, `status-${jobId}.json`);
  writeFileSync(path, JSON.stringify({ job_id: jobId, status, ...(reason ? { reason } : {}), updated: new Date().toISOString() }));
  upload(path, `generated/${jobId}/status.json`, `${status}: ${jobId}`);
}

async function appendMetadata(workFolder, record) {
  const response = await fetch(`${REPO_URL}/metadata.jsonl?t=${Date.now()}`);
  const existing = response.ok ? (await response.text()).split("\n").filter(Boolean).filter((line) => JSON.parse(line).id !== record.id) : [];
  const path = join(workFolder, "metadata.jsonl");
  writeFileSync(path, `${[...existing, JSON.stringify(record)].join("\n")}\n`);
  upload(path, "metadata.jsonl", `Add ${record.id}`);
}

// ---------- one job ----------

async function referenceImage(job, key) {
  if (job.image_url) return { bytes: await downloadBytes(job.image_url, MAX_IMAGE_BYTES), falUrl: job.image_url, generated: false };
  const result = await runFal(FLUX_ENDPOINT, {
    prompt: `${job.prompt}, single object, centered, three-quarter view, plain white background, studio product photo`,
    image_size: "square_hd", num_inference_steps: 4, output_format: "png", enable_safety_checker: true,
  }, key);
  const falUrl = result.images?.[0]?.url;
  if (!falUrl) throw new Error("FLUX returned no image");
  return { bytes: await downloadBytes(falUrl, MAX_IMAGE_BYTES), falUrl, generated: true };
}

async function processJob(job, key, tooling, workFolder) {
  const jobFolder = join(workFolder, job.job_id);
  rmSync(jobFolder, { recursive: true, force: true });
  mkdirSync(jobFolder, { recursive: true });
  const spentBefore = readLedger().total_usd;
  publishStatus(workFolder, job.job_id, "running");

  const image = await referenceImage(job, key);
  const format = (await tooling.sharp(image.bytes).metadata()).format;
  if (!["png", "jpeg", "webp"].includes(format)) throw new Error(`unsupported image format ${format}`);
  const inputName = `input.${format === "jpeg" ? "jpg" : format}`;

  const result = await runFal(TRELLIS_ENDPOINT, { image_url: image.falUrl, resolution: 1024, texture_size: 2048, decimation_target: 200000 }, key);
  const glbUrl = findFileUrl(result, ".glb");
  if (!glbUrl) throw new Error("TRELLIS.2 returned no GLB");
  const engineBytes = Buffer.from(await (await fetch(glbUrl)).arrayBuffer());
  const tiers = await buildTiers(engineBytes, tooling);

  const longest = Math.max(...tiers.extents);
  const scale = job.size_m ? Math.round((job.size_m / longest) * 1e6) / 1e6 : null;
  const folder = `generated/${job.job_id}`;
  const files = { web: `${folder}/web.glb`, lod1: `${folder}/lod1.glb`, engine: `${folder}/engine.glb` };
  const record = {
    id: job.job_id,
    title: job.prompt,
    prompt: job.prompt,
    input_image_url: job.image_url ?? null,
    input_image_licence: job.image_url ? "unknown (supplied by the requester)" : "generated by FLUX.1 schnell (Apache-2.0)",
    model: "TRELLIS.2 via fal",
    endpoints: { image: job.image_url ? null : FLUX_ENDPOINT, mesh: TRELLIS_ENDPOINT },
    created: new Date().toISOString(),
    cost_usd: Math.round((readLedger().total_usd - spentBefore) * 1000) / 1000,
    triangles: tiers.triangles,
    licence: "MIT",
    ai_generated: true,
    credit: `Generated by CodePawl with TRELLIS.2 (MIT) from: ${job.image_url ?? job.prompt}`,
    files,
    tier_requirements: TIER_REQUIREMENTS,
    thumbnail: `${folder}/thumbnail.webp`,
    bounds_units: tiers.extents.map((value) => Math.round(value * 1000) / 1000),
    file_units: scale ? `file units; multiply by scale (${scale}) to get metres` : "longest side about 1 unit; scale to your scene",
    ...(scale ? { scale, size_m: tiers.extents.map((value) => Math.round(value * scale * 1000) / 1000) } : {}),
  };

  for (const [tier, buffer] of Object.entries(tiers.buffers)) writeFileSync(join(jobFolder, `${tier}.glb`), buffer);
  writeFileSync(join(jobFolder, "thumbnail.webp"), await tooling.sharp(image.bytes).resize(512, 512, { fit: "inside" }).webp({ quality: 80 }).toBuffer());
  writeFileSync(join(jobFolder, inputName), image.bytes);
  writeFileSync(join(jobFolder, "record.json"), JSON.stringify(record, null, 1));

  hf(["upload", REPO, jobFolder, folder, "--repo-type", "dataset", "--commit-message", `Add ${job.job_id}: ${job.prompt}`.slice(0, 120)]);
  await appendMetadata(workFolder, { ...record, files, size_m: undefined });
  publishStatus(workFolder, job.job_id, "done");
  log(`done ${job.job_id} "${job.prompt}" ${JSON.stringify(tiers.triangles)} $${record.cost_usd}`);
}

function failureReason(error) {
  return error instanceof Unavailable ? "generation unavailable" : `generation failed: ${String(error.message).slice(0, 120)}`;
}

async function needsWork(job) {
  const status = await readRemoteJson(`generated/${job.job_id}/status.json`);
  if (!status) return true;
  const updated = Date.parse(status.updated);
  if (updated < Date.parse(job.created)) return true;
  return status.status === "running" && Date.now() - updated > STALE_RUNNING_MS;
}

async function runPass() {
  const response = await fetch(QUEUE_URL, { headers: { "User-Agent": "asset-gate-gen-processor" } });
  if (!response.ok) throw new Error(`queue HTTP ${response.status}`);
  const { jobs } = await response.json();
  const workFolder = join(tmpdir(), "asset-gate-gen");
  mkdirSync(workFolder, { recursive: true });
  let prepared = false;
  let key = null;
  let tooling = null;
  for (const job of jobs) {
    if (!(await needsWork(job))) continue;
    log(`job ${job.job_id} "${job.prompt}"`);
    try {
      if (!prepared) {
        await ensureRepository(workFolder);
        prepared = true;
      }
      key ??= readFalKey();
      tooling ??= loadTooling();
      await processJob(job, key, tooling, workFolder);
    } catch (error) {
      log(`failed ${job.job_id}: ${error.message}`);
      try {
        publishStatus(workFolder, job.job_id, "failed", failureReason(error));
      } catch (publishError) {
        log(`could not publish the failed status: ${publishError.message}`);
      }
    }
  }
  log(`pass finished, ${jobs.length} in queue, fal spend this month $${readLedger().total_usd}`);
}

async function main() {
  const watch = process.argv.includes("--watch");
  if (!watch && !process.argv.includes("--once")) {
    console.error("usage: node scripts/gen-processor.mjs --once | --watch");
    process.exit(2);
  }
  do {
    try {
      await runPass();
    } catch (error) {
      log(`pass failed: ${error.message}`);
      if (!watch) process.exitCode = 1;
    }
    if (watch) await new Promise((resolve) => setTimeout(resolve, POLL_SECONDS * 1000));
  } while (watch);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
