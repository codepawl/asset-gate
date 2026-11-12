// The four tools. Each handler returns plain JSON; mcp.mjs wraps it for the protocol.

import { KINDS } from "./facets.mjs";
import { outsideSources } from "./elsewhere.mjs";
import { createGenerationTools, PACK_BASE } from "./generation.mjs";

export const VERSION = "0.3.0";
export const USER_AGENT = `codepawl-asset-gate/${VERSION} (+https://github.com/codepawl/asset-gate)`;
const TIER_ORDER = ["web", "ktx2", "mobile", "lod1", "lod2", "lod3", "engine", "collision"];
const TIER_NOTES = {
  web: "smallest full-quality file, for the web",
  ktx2: "GPU-compressed textures, least video memory",
  mobile: "small textures and fewer triangles",
  lod1: "level of detail 1 (about half the triangles)",
  lod2: "level of detail 2",
  lod3: "level of detail 3 (fewest triangles)",
  engine: "least compressed; for Blender, Godot, Unity and offline renders",
  collision: "convex hulls for physics, not for display",
};
const LICENCE_URL_MIT = "https://opensource.org/license/mit";
const THREE_VERSION = "0.170.0";

// glTF extensions a stock three.js GLTFLoader cannot open on its own, and the decoder each one needs.
const DECODERS = {
  EXT_meshopt_compression: "MeshoptDecoder",
  KHR_texture_basisu: "KTX2Loader",
  KHR_draco_mesh_compression: "DRACOLoader",
};

function decodersFor(requiredExtensions) {
  return [...new Set((requiredExtensions ?? []).map((extension) => DECODERS[extension]).filter(Boolean))];
}

// Prefer a display tier that needs no decoder, then one that needs only the small meshopt decoder.
function defaultTier(available, requirements) {
  const display = TIER_ORDER.filter((tier) => tier !== "collision" && available.includes(tier));
  const cost = (tier) => {
    const decoders = decodersFor(requirements?.[tier]);
    if (decoders.length === 0) return tier === "engine" ? 1 : 0;
    if (decoders.length === 1 && decoders[0] === "MeshoptDecoder") return 2;
    return 3 + decoders.length;
  };
  return display.sort((left, right) => cost(left) - cost(right) || display.indexOf(left) - display.indexOf(right))[0];
}

function threeLoadSnippet(url, decoders) {
  const lines = [];
  const imports = ['import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";'];
  lines.push("const loader = new GLTFLoader();");
  if (decoders.includes("MeshoptDecoder")) {
    imports.push('import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";');
    lines.push("loader.setMeshoptDecoder(MeshoptDecoder);");
  }
  if (decoders.includes("KTX2Loader")) {
    imports.push('import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";');
    lines.push(`loader.setKTX2Loader(new KTX2Loader().setTranscoderPath("https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/libs/basis/").detectSupport(renderer));`);
  }
  if (decoders.includes("DRACOLoader")) {
    imports.push('import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";');
    lines.push(`loader.setDRACOLoader(new DRACOLoader().setDecoderPath("https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/libs/draco/"));`);
  }
  lines.push(`loader.load("${url}", (gltf) => scene.add(gltf.scene));`);
  return [...imports, ...lines].join("\n");
}

export const TOOL_DEFINITIONS = [
  {
    name: "search_assets",
    title: "Search free 3D assets",
    description:
      "Search about 75,000 free 3D assets (GLB models, PBR materials, HDRIs, terrain, robots, motion clips) from CodePawl's Hugging Face packs and from Poly Haven, ambientCG, Kenney, Quaternius and Megascans listings. Write what you need in plain words; a size in the text such as '2 m' or '45 cm' keeps assets near that real size. Returns ids for get_asset. Prefer results with glb_ready true when you need a file to load right away.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you need, e.g. 'wooden chair', 'mossy rock 1 m', 'sunset hdri', 'tileable brick material'." },
        kind: { type: "string", enum: KINDS, description: "Only this kind of asset." },
        licence: { type: "string", enum: ["any", "cc0", "shippable"], description: "cc0: no credit needed. shippable: files you may ship with the credit line (leaves out link-only Megascans). Default any." },
        no_share_alike: { type: "boolean", description: "Leave out CC BY-SA assets." },
        glb_only: { type: "boolean", description: "Only assets with a ready GLB URL." },
        size_m: { type: "number", description: "Target largest dimension in metres; keeps assets from half to double this size. Drops assets of unknown size." },
        min_size_m: { type: "number", description: "Smallest largest-dimension in metres." },
        max_size_m: { type: "number", description: "Largest largest-dimension in metres." },
        real_size_only: { type: "boolean", description: "Only assets whose size in metres is known." },
        style: { type: "string", enum: ["photoreal", "stylized", "lowpoly"] },
        rigged: { type: "boolean", description: "Only rigged assets." },
        animated: { type: "boolean", description: "Only assets with animation clips." },
        no_ai_generated: { type: "boolean", description: "Leave out assets made with generative AI." },
        sources: { type: "array", items: { type: "string" }, description: "Only these sources (the source names list_sources gives)." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "How many results, default 10." },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_asset",
    title: "Get one asset's file, size and credit",
    description:
      "Everything needed to use one asset: the GLB URL (or the download URLs for materials and HDRIs), every file tier, the real size in metres or the file's units, the licence and a ready credit line to paste into your project. Megascans assets come back as a Fab link only.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "An id from search_assets, e.g. 'abo-glb:B07B4MTFP3' or 'polyhaven:rock_moss_set_01'." },
        tier: { type: "string", enum: TIER_ORDER, description: "GLB tier. By default the gate picks the one that needs the fewest decoders; each tier lists what it needs (MeshoptDecoder, KTX2Loader)." },
        resolution: { type: "string", enum: ["1k", "2k", "4k"], description: "Texture or HDRI resolution for Poly Haven assets. Default 1k." },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "list_sources",
    title: "List sources and packs",
    description: "The libraries and GLB packs the gate searches, with asset counts, licences, file tiers and whether sizes are real metres.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "find_elsewhere",
    title: "Free sources outside the gate",
    description:
      "When search_assets has no good match: links to search the same words at other free 3D libraries (Poly Haven, ambientCG, Poly Pizza, Sketchfab downloadable, Smithsonian, NASA, Kenney, OpenGameArt, Fab free), with each one's licence and how to credit it. These are links for you or the user to open; the gate does not fetch or host them.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you were looking for." },
        kind: { type: "string", enum: KINDS },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

// "abo-glb:B07124WCZY" → "abo-glb/B07124WCZY", each part URL-encoded.
export function gatePath(id) {
  const split = id.indexOf(":");
  return [id.slice(0, split), id.slice(split + 1)].map(encodeURIComponent).join("/");
}

function packFileUrl(packBase, pack, path) {
  return `${packBase}/${pack}/resolve/main/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function summarise(record, packBase) {
  const summary = {
    id: record.id,
    title: record.title,
    source: record.source,
    kind: record.kind,
    licence: record.licence,
    credit_needed: !["CC0-1.0", "public-domain"].includes(record.licence),
    glb_ready: Boolean(record.glb ?? record.tiers),
  };
  if (record.category) summary.category = record.category;
  if (record.size_m) summary.size_m = record.size_m;
  if (record.surface_m) summary.surface_m = record.surface_m;
  if (!record.size_m && record.file_units) summary.file_units = record.file_units;
  if (record.triangles) summary.triangles = record.triangles;
  if (record.rigged) summary.rigged = true;
  if (record.animated) summary.animated = true;
  if (record.licence?.startsWith("LicenseRef-Fab")) summary.link_only = "claim on Fab; no file here";
  if (record.link_out) summary.link_only = `download from ${record.link_out.site}; no file here`;
  if (record.thumbnail) summary.thumbnail = record.pack ? packFileUrl(packBase, record.pack, record.thumbnail) : record.thumbnail;
  return summary;
}

// Fields every asset answer carries.
function describeRecord(record) {
  const answer = {
    id: record.id,
    title: record.title,
    source: record.source,
    kind: record.kind,
    licence: record.licence,
    licence_url: record.licence_url ?? null,
    credit: record.credit ?? null,
    credit_needed: !["CC0-1.0", "public-domain"].includes(record.licence),
    authors: record.authors ?? null,
    page: record.page ?? null,
    size_m: record.size_m ?? null,
    size_note: record.size_m
      ? "bounding box x, y, z in metres (y up)"
      : record.surface_m
        ? `one texture repeat covers ${record.surface_m.join(" x ")} m`
        : record.kind === "hdri"
          ? null
          : record.file_units ?? "size unknown: measure the bounding box after loading",
    triangles: record.triangles ?? null,
    notes: record.notes ?? null,
  };
  if (record.ai_generated) answer.ai_generated = true;
  return answer;
}

// Adds the GLB tiers of a pack asset: each tier with the decoders it needs, the default pick and a load snippet.
function addTiers(answer, record, { requirements, packBase, tierInput, gateBase }) {
  const tiers = {};
  const extraFiles = {};
  for (const [name, path] of Object.entries(record.tiers)) {
    const direct = packFileUrl(packBase, record.pack, path);
    if (!path.endsWith(".glb")) {
      extraFiles[name] = direct;
      continue;
    }
    if (!TIER_ORDER.includes(name)) continue;
    tiers[name] = {
      url: gateBase ? `${gateBase}/f/${gatePath(record.id)}/${name}.glb` : direct,
      needs: decodersFor(requirements[name]),
      note: TIER_NOTES[name],
    };
  }
  const available = Object.keys(tiers);
  const preferred = tierInput && tiers[tierInput] ? tierInput : defaultTier(available, requirements);
  answer.glb_url = tiers[preferred].url;
  answer.tier = preferred;
  answer.needs = tiers[preferred].needs;
  answer.load_three = threeLoadSnippet(answer.glb_url, answer.needs);
  answer.tiers = Object.fromEntries(TIER_ORDER.filter((name) => tiers[name]).map((name) => [name, tiers[name]]));
  if (Object.keys(extraFiles).length) answer.extra_files = extraFiles;
  if (record.thumbnail) answer.thumbnail = packFileUrl(packBase, record.pack, record.thumbnail);
  return answer;
}

// A finished generation job (record.json on Hugging Face) as the answer get_asset gives for a pack asset.
function describeGenerated(record, packBase) {
  const asset = {
    id: `generated-glb:${record.id}`,
    title: record.title,
    source: "generated-glb",
    kind: "model",
    licence: record.licence,
    licence_url: LICENCE_URL_MIT,
    credit: record.credit,
    page: `${packBase}/generated-glb/tree/main/generated/${record.id}`,
    size_m: record.size_m ?? null,
    file_units: record.file_units,
    triangles: record.triangles?.engine ?? null,
    notes: `AI-generated with ${record.model}. ${record.scale ? `Multiply the file by ${record.scale} to reach the size asked for.` : ""}`.trim(),
    ai_generated: true,
    pack: "generated-glb",
    tiers: record.files,
    thumbnail: record.thumbnail,
  };
  const answer = addTiers(describeRecord(asset), asset, { requirements: record.tier_requirements ?? {}, packBase, tierInput: null, gateBase: null });
  if (record.scale) answer.scale_to_apply = record.scale;
  answer.triangles_per_tier = record.triangles;
  return answer;
}

export function createTools({ index, gateBase = null, fetchImpl = fetch, generation = null }) {
  async function searchAssets(input) {
    const query = String(input.query ?? "");
    const limit = Math.min(50, Math.max(1, Number(input.limit) || 10));
    const manifest = await index.manifest();
    const found = await index.search(query, input, limit);
    const response = {
      query,
      matched_words: found.matched_words,
      count: found.results.length,
      results: found.results.map(({ record, matched, query_words }) => ({
        ...summarise(record, manifest.pack_base),
        ...(query_words > 1 && matched < query_words ? { partial_match: `${matched} of ${query_words} words` } : {}),
      })),
    };
    if (response.count === 0) response.next = "No match. Try fewer or simpler words, drop filters, or call find_elsewhere.";
    else response.next = "Call get_asset with an id for the file URL, size and credit line.";
    return response;
  }

  async function getAsset(input) {
    const record = await index.documentById(String(input.id ?? ""));
    if (!record) return { error: `No asset with id "${input.id}". Ids come from search_assets.` };
    const manifest = await index.manifest();
    const answer = describeRecord(record);
    if (record.tiers) {
      return addTiers(answer, record, { requirements: manifest.tier_requirements?.[record.pack] ?? {}, packBase: manifest.pack_base, tierInput: input.tier, gateBase });
    }

    if (record.link_out) {
      answer.link_only = true;
      answer.url = record.link_out.url;
      answer.how = `Open the page and download it from ${record.link_out.site} (a free account may be needed), then use it under the licence above.`;
      answer.why = "The gate links to the original page for this library instead of serving a copy.";
      return answer;
    }

    if (record.source === "polyhaven") {
      Object.assign(answer, await polyHavenFiles(record, input.resolution ?? "1k", fetchImpl, gateBase));
      answer.credit = `${record.title} from Poly Haven (polyhaven.com), CC0. Powered by Poly Haven.`;
      return answer;
    }

    const get = record.get ?? {};
    if (record.licence?.startsWith("LicenseRef-")) {
      answer.link_only = true;
      answer.how = get.how ?? "open the page";
      answer.url = get.url ?? record.page;
      if (get.then) answer.then = "Optimise your own download to web GLB with the tool in huggingface.co/datasets/codepawl/asset-index/tree/main/tool";
      answer.why = "This library licenses files to each user and forbids passing them on, so the gate only links to it.";
      return answer;
    }
    answer.download = { page: get.url ?? record.page };
    if (get.zips) answer.download.zips = get.zips;
    if (get.file_in_kit) {
      answer.download.file_in_kit = get.file_in_kit;
      answer.download.how = "Download the kit zip from the page, then use this file from inside it.";
    }
    if (get.granularity === "pack") answer.download.how = "Download the pack from the page; this row is the whole pack.";
    if (record.thumbnail) answer.thumbnail = record.thumbnail;
    return answer;
  }

  async function listSources() {
    const manifest = await index.manifest();
    return {
      assets: manifest.documents,
      built_on: manifest.built_on,
      licence_classes: {
        cc0: "no credit needed (CC0, public domain)",
        attribution: "ship it with the credit line (CC BY, MIT, Apache, BSD)",
        "share-alike": "ship it with the credit line; what you make from it carries the same licence (CC BY-SA)",
        "link-only": "licensed by the library to each user; the gate only links to it (Megascans on Fab)",
      },
      tiers: TIER_NOTES,
      sources: manifest.source_summaries,
    };
  }

  async function findElsewhere(input) {
    return {
      query: input.query,
      note: "Links only. Check each asset's own licence on its page before using it, and keep its credit line.",
      sources: outsideSources(String(input.query ?? ""), input.kind),
    };
  }

  const handlers = {
    search_assets: searchAssets,
    get_asset: getAsset,
    list_sources: listSources,
    find_elsewhere: findElsewhere,
  };
  let definitions = TOOL_DEFINITIONS;
  let queue = async () => [];
  if (generation) {
    const generated = createGenerationTools({
      ...generation,
      fetchImpl,
      searchAssets,
      describeGenerated: (record) => describeGenerated(record, PACK_BASE),
    });
    Object.assign(handlers, generated.handlers);
    definitions = [...TOOL_DEFINITIONS, ...generated.definitions];
    queue = generated.queue;
  }

  return {
    definitions,
    queue,
    async call(name, input) {
      const handler = handlers[name];
      if (!handler) throw new Error(`unknown tool ${name}`);
      return handler(input ?? {});
    },
  };
}

async function polyHavenFiles(record, resolution, fetchImpl, gateBase) {
  const assetId = record.id.slice("polyhaven:".length);
  const response = await fetchImpl(`https://api.polyhaven.com/files/${encodeURIComponent(assetId)}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) return { download: { page: record.page }, error: `Poly Haven API answered ${response.status}` };
  const files = await response.json();
  const pick = (levels) => levels[resolution] ?? levels["1k"] ?? levels[Object.keys(levels)[0]];
  if (files.gltf) {
    const level = pick(files.gltf);
    const chosen = Object.keys(files.gltf).find((key) => files.gltf[key] === level);
    const includes = Object.fromEntries(Object.entries(level.gltf.include ?? {}).map(([path, file]) => [path, file.url]));
    if (gateBase) {
      const gltfUrl = `${gateBase}/polyhaven/${assetId}/${chosen}.gltf`;
      return {
        gltf_url: gltfUrl,
        gltf_note: "A .gltf whose buffers and textures point at Poly Haven's own files, so it loads from this one URL.",
        load: `new GLTFLoader().load("${gltfUrl}", (gltf) => scene.add(gltf.scene))`,
        resolutions: Object.keys(files.gltf),
        page: record.page,
      };
    }
    return {
      gltf_url: level.gltf.url,
      gltf_includes: includes,
      gltf_note: "Poly Haven keeps the .bin and textures in other folders than the .gltf, so map them with a URL modifier.",
      load: `const includes = ${JSON.stringify(includes)}; const manager = new THREE.LoadingManager(); manager.setURLModifier((url) => { const hit = Object.keys(includes).find((path) => url.endsWith(path)); return hit ? includes[hit] : url; }); new GLTFLoader(manager).load("${level.gltf.url}", (gltf) => scene.add(gltf.scene))`,
      resolutions: Object.keys(files.gltf),
      page: record.page,
    };
  }
  if (files.hdri) {
    const level = pick(files.hdri);
    return {
      hdri_url: level.hdr?.url,
      exr_url: level.exr?.url ?? null,
      resolutions: Object.keys(files.hdri),
      load: `new RGBELoader().load("${level.hdr?.url}", (texture) => { texture.mapping = THREE.EquirectangularReflectionMapping; scene.environment = texture; })`,
      page: record.page,
    };
  }
  const maps = {};
  for (const [mapName, levels] of Object.entries(files)) {
    if (["blend", "gltf", "mtlx"].includes(mapName) || typeof levels !== "object") continue;
    const level = pick(levels);
    const file = level?.jpg ?? level?.png ?? level?.exr;
    if (file?.url) maps[mapName] = file.url;
  }
  return { texture_maps: maps, resolution, page: record.page };
}
