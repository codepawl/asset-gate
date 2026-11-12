// generate_asset and get_generation: a fallback for when no free asset fits.
// The Worker never calls a paid model. It queues the request in KV and reads the result that
// scripts/gen-processor.mjs (on the owner's PC) publishes to a public Hugging Face dataset.

export const GENERATED_REPO = "codepawl/generated-glb";
export const PACK_BASE = "https://huggingface.co/datasets/codepawl";
export const GENERATED_BASE = `${PACK_BASE}/generated-glb/resolve/main`;

const QUEUE_KEY = "queue";
const QUEUE_TTL_SECONDS = 2 * 24 * 3600;
const LIVE_WINDOW_MS = 30 * 60 * 1000;
const NEW_JOBS_PER_IP_PER_DAY = 5;
const LIVE_JOBS_IN_ALL = 50;
const ETA_SECONDS = 180;
const MAX_PROMPT_LENGTH = 200;
const MAX_SIZE_M = 1000;
// How long a Hugging Face answer is reused: a missing file is rechecked fast, a finished job rarely changes.
const CACHE_SECONDS = { missing: 20, working: 15, finished: 120, record: 3600 };

export const GENERATION_DEFINITIONS = [
  {
    name: "generate_asset",
    title: "Generate a 3D model when nothing fits",
    description:
      "Last resort after search_assets and find_elsewhere found nothing. Searches first and returns existing assets when they match every word. Otherwise queues a TRELLIS.2 generation (MIT licence, marked ai_generated) and returns a job_id; poll get_generation until it is done, which takes a few minutes. The same request is never generated twice. Limited to 5 new jobs per IP per day.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "One object in plain words, e.g. 'pepper grinder'." },
        image_url: { type: "string", description: "Optional https URL of a reference image of that object; used instead of a generated one." },
        size_m: { type: "number", description: "Real longest side in metres; the answer gives the scale to apply to the file." },
      },
      required: ["prompt"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: "get_generation",
    title: "Check a generation job",
    description: "State of a generate_asset job: queued, running, done (same answer as get_asset) or failed (a soft fail with a reason and no results; use find_elsewhere instead).",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string", description: "The job_id generate_asset returned." } },
      required: ["job_id"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

export function normalisePrompt(prompt) {
  return String(prompt ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export async function jobIdFor(prompt, imageUrl) {
  const bytes = new TextEncoder().encode(`${normalisePrompt(prompt)}\n${imageUrl ?? ""}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.subarray(0, 6)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// deps: kv (KV namespace), cache (Cache API), searchAssets (the search_assets handler),
// describeGenerated (record.json to a get_asset-shaped answer), clientIp, fetchImpl, now.
export function createGenerationTools({ kv, cache, searchAssets, describeGenerated, clientIp = "unknown", fetchImpl = fetch, now = Date.now }) {
  async function readHuggingFace(path, secondsFor) {
    const url = `${GENERATED_BASE}/${path}`;
    const cacheKey = new Request(url);
    const hit = await cache.match(cacheKey);
    if (hit) return hit.json();
    const response = await fetchImpl(url);
    // Hugging Face answers 401 for a dataset that does not exist yet.
    let value = null;
    if (response.ok) value = await response.json();
    else if (![401, 404].includes(response.status)) throw new Error(`Hugging Face answered ${response.status} for ${path}`);
    const seconds = value === null ? CACHE_SECONDS.missing : secondsFor(value);
    await cache.put(cacheKey, new Response(JSON.stringify(value), { headers: { "Cache-Control": `max-age=${seconds}` } }));
    return value;
  }

  const readRecord = (jobId) => readHuggingFace(`generated/${jobId}/record.json`, () => CACHE_SECONDS.record);
  const readStatus = (jobId) => readHuggingFace(`generated/${jobId}/status.json`, (status) => (["queued", "running"].includes(status.status) ? CACHE_SECONDS.working : CACHE_SECONDS.finished));

  async function readQueue() {
    const stored = await kv.get(QUEUE_KEY, "json");
    const oldest = now() - QUEUE_TTL_SECONDS * 1000;
    return (stored ?? []).filter((job) => Date.parse(job.created) > oldest);
  }

  const isLive = (job) => now() - Date.parse(job.created) < LIVE_WINDOW_MS;

  function finishedAnswer(jobId, record) {
    return { status: "done", job_id: jobId, ...describeGenerated(record) };
  }

  function noResult(message) {
    return { status: "no_result", message: `${message} Try find_elsewhere for links to other free libraries.`, results: [] };
  }

  async function takeIpSlot() {
    const day = new Date(now()).toISOString().slice(0, 10);
    const key = `ip:${clientIp}:${day}`;
    const used = Number(await kv.get(key)) || 0;
    if (used >= NEW_JOBS_PER_IP_PER_DAY) return false;
    await kv.put(key, String(used + 1), { expirationTtl: 90000 });
    return true;
  }

  async function generateAsset(input) {
    const prompt = normalisePrompt(input.prompt);
    if (!prompt || prompt.length > MAX_PROMPT_LENGTH) return { error: `prompt must be 1 to ${MAX_PROMPT_LENGTH} characters` };
    const imageUrl = input.image_url ? String(input.image_url).trim() : null;
    if (imageUrl && !/^https:\/\/[^\s]+$/.test(imageUrl)) return { error: "image_url must be an https URL" };
    const sizeM = input.size_m === undefined || input.size_m === null ? null : Number(input.size_m);
    if (sizeM !== null && !(sizeM > 0 && sizeM <= MAX_SIZE_M)) return { error: `size_m must be between 0 and ${MAX_SIZE_M} metres` };

    const found = await searchAssets({ query: prompt, glb_only: true, limit: 5 });
    const fullMatches = found.results.filter((result) => !result.partial_match);
    if (fullMatches.length > 0) {
      return { status: "skipped", note: "generation skipped: found existing assets", count: fullMatches.length, results: fullMatches, next: "Call get_asset with an id for the file URL, size and credit line." };
    }

    const jobId = await jobIdFor(prompt, imageUrl);
    const record = await readRecord(jobId);
    if (record) return finishedAnswer(jobId, record);

    const queue = await readQueue();
    const queued = queue.find((job) => job.job_id === jobId);
    if (queued && isLive(queued)) return { status: "queued", job_id: jobId, eta_s: ETA_SECONDS, next: "Call get_generation with this job_id every 30 seconds or so." };

    if (queue.filter(isLive).length >= LIVE_JOBS_IN_ALL) return noResult("The generation queue is full.");
    if (!(await takeIpSlot())) return noResult(`Limit reached: ${NEW_JOBS_PER_IP_PER_DAY} new generations per IP per day.`);

    const job = { job_id: jobId, prompt, image_url: imageUrl, size_m: sizeM, created: new Date(now()).toISOString() };
    await kv.put(QUEUE_KEY, JSON.stringify([...queue.filter((other) => other.job_id !== jobId), job]), { expirationTtl: QUEUE_TTL_SECONDS });
    return { status: "queued", job_id: jobId, eta_s: ETA_SECONDS, next: "Call get_generation with this job_id every 30 seconds or so." };
  }

  async function getGeneration(input) {
    const jobId = String(input.job_id ?? "");
    if (!/^[0-9a-f]{12}$/.test(jobId)) return { error: "job_id is the 12-character id generate_asset returned." };
    const [status, queue] = await Promise.all([readStatus(jobId), readQueue()]);
    const queued = queue.find((job) => job.job_id === jobId);
    // A status older than the queue entry belongs to an earlier try of the same request.
    const current = status && !(queued && Date.parse(status.updated) < Date.parse(queued.created));
    if (current) {
      if (status.status === "done") {
        const record = await readRecord(jobId);
        if (record) return finishedAnswer(jobId, record);
        return { status: "running", job_id: jobId, eta_s: 30 };
      }
      if (status.status === "failed") return { status: "failed", job_id: jobId, reason: status.reason ?? "generation failed", results: [] };
      return { status: status.status, job_id: jobId, eta_s: ETA_SECONDS };
    }
    if (!queued) return { error: `No generation job "${jobId}". It may have expired; call generate_asset again.` };
    if (!isLive(queued)) return { status: "failed", job_id: jobId, reason: "timed out", results: [] };
    return { status: "queued", job_id: jobId, eta_s: ETA_SECONDS };
  }

  return {
    definitions: GENERATION_DEFINITIONS,
    handlers: { generate_asset: generateAsset, get_generation: getGeneration },
    queue: readQueue,
  };
}
