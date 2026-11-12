// Builds the search index the gate serves: asset records in blocks, word postings in buckets, one facet number per
// asset. Input: cache/packs/<pack>/metadata.jsonl (from scripts/fetch-sources.sh) and the codepawl/asset-index
// metadata.jsonl. Output: dist/index/v1/...
//
//   node scripts/build-index.mjs [--asset-index <path to metadata.jsonl>]

import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_TIER_REQUIREMENTS, HUGGING_FACE_BASE, LIBRARIES, LICENCE_URLS, PACKS, licenceClass, normaliseLicence } from "./sources.mjs";
import { BUCKET_COUNT, bucketOf, words } from "../src/core/text.mjs";
import { packFacets } from "../src/core/facets.mjs";

const projectFolder = join(dirname(fileURLToPath(import.meta.url)), "..");
const packsFolder = join(projectFolder, "cache", "packs");
const siteFolder = join(projectFolder, "dist", "site");
const outputFolder = join(siteFolder, "index", "v1");
const argumentList = process.argv.slice(2);
const assetIndexPath = argumentList.includes("--asset-index")
  ? argumentList[argumentList.indexOf("--asset-index") + 1]
  : join(projectFolder, "cache", "asset-index", "metadata.jsonl");

const BLOCK_SIZE = 20;
const CARD_BLOCK_SIZE = 50;
const CARD_FIELDS = ["id", "title", "source", "kind", "category", "licence", "size_m", "surface_m", "file_units", "triangles", "rigged", "animated", "pack", "thumbnail", "link_out"];
const MAX_POSTINGS_PER_WORD = 6000;
const READ_ON = new Date().toISOString().slice(0, 10);

async function readJsonLines(path) {
  const rows = [];
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
  return rows;
}

function parseMaybe(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function roundSize(size) {
  if (!Array.isArray(size) || size.length < 3 || size.some((value) => typeof value !== "number" || !(value > 0))) return null;
  return size.map((value) => Number(value.toPrecision(4)));
}

function largest(size) {
  return Array.isArray(size) ? Math.max(...size) : null;
}

// ---------- Hugging Face packs ----------

// Tier → path inside the pack, from whatever fields the pack's metadata uses.
function packTiers(pack, row) {
  const files = parseMaybe(row.files);
  if (files && typeof files === "object") return { ...files };
  const tiers = {};
  if (pack.repo === "abo-glb") {
    tiers.web = row.file;
    if (row.ktx2_file) tiers.ktx2 = row.ktx2_file;
    for (const [index, level] of (parseMaybe(row.lods) ?? []).entries()) tiers[`lod${index + 1}`] = level.file;
    tiers.engine = row.file_name;
  } else if (pack.repo === "scanned-objects-glb") {
    tiers.web = row.file;
    tiers.ktx2 = `objects_ktx2/${row.id}/${row.id}.glb`;
    for (const level of [1, 2, 3]) tiers[`lod${level}`] = `lods/${row.id}/${row.id}_lod${level}.glb`;
    tiers.engine = row.file_name;
  } else if (pack.repo === "simready-glb") {
    const asset = row.asset;
    tiers.web = row.glb;
    tiers.ktx2 = `glb_ktx2/${asset}.glb`;
    for (const level of [1, 2, 3]) tiers[`lod${level}`] = `lods/${asset}/${asset}_lod${level}.glb`;
    tiers.mobile = `mobile/${asset}/${asset}.glb`;
    tiers.engine = row.file_name;
  } else if (pack.repo === "menagerie-glb") {
    tiers.web = `${row.name}/${row.name}.glb`;
    tiers.engine = row.file_name;
  } else if (pack.repo === "ct-anatomy-glb") {
    tiers.web = row.file;
    tiers.engine = row.file_name;
  } else if (row.file_name) {
    tiers.engine = row.file_name;
  }
  return tiers;
}

// asset-index rows by id, so repacked kits keep the tags and surface words the index already has.
const libraryRowsById = new Map();

const measuredBoundsByPack = new Map();

function measuredBounds(pack) {
  if (!measuredBoundsByPack.has(pack)) {
    const path = join(projectFolder, "cache", "bounds", `${pack}.json`);
    measuredBoundsByPack.set(pack, existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
  }
  return measuredBoundsByPack.get(pack);
}

function packRecord(pack, row, simreadyBounds) {
  const id = row.id ?? row.asset ?? row.name ?? row.scan;
  const title = row.title ?? row.name ?? row.asset ?? id;
  const licence = normaliseLicence(row.license ?? row.licence) ?? pack.licence;
  let kind = "model";
  let category = row.category ?? row.product_type ?? row.kind ?? null;
  let style = null;
  let rigged = false;
  let animated = false;
  let sizeMetres = null;
  let realScale = Boolean(pack.realScale);
  const extraWords = [];
  const notes = [];

  switch (pack.repo) {
    case "abo-glb":
      sizeMetres = roundSize(row.size_metres);
      style = "photoreal";
      extraWords.push(row.brand, row.color, row.material, row.style, row.product_type);
      break;
    case "scanned-objects-glb":
      sizeMetres = roundSize(row.size_metres);
      style = "photoreal";
      extraWords.push(row.brand, ...(row.source_categories ?? []));
      break;
    case "simready-glb": {
      const bounds = simreadyBounds.get(row.asset);
      if (bounds) sizeMetres = roundSize(bounds.max.map((value, axis) => value - bounds.min[axis]));
      style = "photoreal";
      extraWords.push(row.asset.replace(/_[a-z]\d+$/, "").replace(/([a-z])([A-Z])/g, "$1 $2"));
      if (row.joints > 0) notes.push(`${row.joints} physics joints, ${row.rigid_bodies} rigid bodies`);
      break;
    }
    case "plateau-city-glb":
      category = "city tile";
      style = "photoreal";
      extraWords.push(row.city, "city", "building", "japan", ...(row.layers ?? []));
      notes.push(`Real-world tile at ${row.centre_latlon?.join(", ")}, CRS ${row.crs}`);
      break;
    case "mars-hirise-terrain":
      kind = "terrain";
      style = "photoreal";
      sizeMetres = row.tile_size_m ? [row.tile_size_m, (row.elevation_max_m - row.elevation_min_m) || 1, row.tile_size_m].map((value) => Number(value.toFixed(2))) : null;
      extraWords.push("mars", "terrain", row.site_name, row.mission, row.rationale);
      break;
    case "menagerie-glb":
      // Measured from the GLB by scripts/measure-bounds.mjs; Menagerie models are in metres.
      sizeMetres = roundSize(measuredBounds("menagerie-glb")[row.name]);
      category = `robot ${row.kind}`;
      rigged = row.joints > 0;
      extraWords.push("robot", row.kind, row.menagerie_model);
      notes.push(`${row.joints} joints, ${row.actuators} actuators`);
      break;
    case "100style-glb":
      kind = "animation";
      category = "motion clip";
      rigged = true;
      animated = true;
      extraWords.push("motion", "locomotion", "animation", row.style, row.movement_name, row.description);
      notes.push(`${row.seconds} s at ${Math.round(row.fps)} fps on a CC0 Quaternius character`);
      break;
    case "0ad-art-glb": {
      style = "stylized";
      const clips = row.clips ?? [];
      animated = clips.length > 0;
      rigged = animated;
      extraWords.push(row.kind, row.civ, ...clips);
      if (clips.length) notes.push(`clips: ${clips.join(", ")}`);
      break;
    }
    case "world-fish-glb":
      category = "fish";
      style = "stylized";
      extraWords.push("fish", row.common, row.scientific, row.family, row.zone, row.water === "salt" ? "sea ocean marine" : "freshwater river");
      if (row.max_length_cm) notes.push(`species grows to ${row.max_length_cm} cm`);
      break;
    case "pixel-atlas-glb":
      style = "stylized";
      category = "pixel art";
      extraWords.push("pixel", "pixel art", "voxel", row.subject, row.caption);
      break;
    case "ct-anatomy-glb":
      category = "human anatomy";
      style = "photoreal";
      extraWords.push("anatomy", "human", "body", "organ", "skeleton", "medical", ...(row.systems ?? []));
      if (row.height_m) notes.push(`scan covers ${row.coverage}, ${row.height_m} m tall`);
      break;
    case "smithsonian-3d-glb":
      category = "museum scan";
      style = "photoreal";
      extraWords.push("museum", "scan", "history");
      break;
    case "nasa-3d-glb":
      extraWords.push("nasa", "space", row.kind);
      break;
    case "kenney-glb":
    case "quaternius-glb": {
      style = "lowpoly";
      category = `${pack.repo === "kenney-glb" ? "kenney" : "quaternius"}/${row.kit_slug}`;
      const clips = row.clips ?? [];
      animated = Boolean(row.animated);
      rigged = Boolean(row.rigged);
      const libraryRow = libraryRowsById.get(`${pack.repo === "kenney-glb" ? "kenney" : "quaternius"}:${row.id}`);
      extraWords.push(row.kit, ...(libraryRow?.tags ?? []), libraryRow?.surface_type, ...clips);
      if (clips.length) notes.push(`clips: ${clips.join(", ")}`);
      break;
    }
    case "objaverse-clean-glb":
    case "google-poly-glb":
      if (pack.repo === "google-poly-glb") style = "lowpoly";
      animated = (row.animations ?? 0) > 0;
      break;
    default:
      break;
  }

  // Link-out packs (Objaverse, from Sketchfab): the gate points at the original page and never serves our copy.
  const tiers = pack.linkOut ? null : packTiers(pack, row);
  const record = {
    id: `${pack.repo}:${id}`,
    title,
    source: pack.repo,
    kind,
    category,
    style,
    licence,
    licence_url: row.license_url ?? LICENCE_URLS[licence] ?? null,
    authors: row.authors ?? null,
    credit: pack.credit({ ...row, title, license: licence }),
    page: row.source_url ?? row.poly_url ?? `${HUGGING_FACE_BASE}/${pack.repo}`,
    size_m: sizeMetres,
    file_units: sizeMetres ? "metres" : (row.size_units ? `file units, not metres: ${row.size_units.join(" x ")}` : (pack.unitScale ?? null)),
    triangles: (typeof row.triangles === "object" ? row.triangles?.engine : row.triangles) ?? null,
    pack: pack.repo,
    tiers,
    // ABO rows carry no thumbnail field, but the pack has one WebP per object in thumbs/.
    thumbnail: pack.linkOut ? null : row.thumbnail ?? row.thumb ?? (pack.repo === "abo-glb" ? `thumbs/${id}.webp` : null),
    link_out: pack.linkOut ? { site: pack.linkOut, url: row.source_url } : null,
    rigged: rigged || null,
    animated: animated || null,
    ai_generated: pack.aiGenerated || null,
    notes: notes.length ? notes.join("; ") : null,
  };
  const prior = 2 + Math.log10(1 + (row.likes ?? 0)) + (row.quality_score ?? 0) / 50 + (sizeMetres ? 0.5 : 0);
  return {
    record,
    prior,
    group: pack.linkOut ? 2 : realScale && sizeMetres ? 0 : 1,
    titleText: title,
    tagText: [category, row.kind, pack.name].filter(Boolean).join(" "),
    otherText: extraWords.filter(Boolean).join(" "),
    facts: {
      kind,
      licenceClass: licenceClass(licence),
      glbReady: Boolean(tiers) && Object.keys(tiers).length > 0,
      rigged,
      animated,
      style,
      aiGenerated: Boolean(pack.aiGenerated),
      realScale: Boolean(sizeMetres),
      direct: !pack.linkOut,
      sizeMetres: largest(sizeMetres),
    },
  };
}

// ---------- codepawl/asset-index libraries ----------

const LIBRARY_CREDITS = {
  kenney: "Kenney (kenney.nl), CC0",
  quaternius: "Quaternius (quaternius.com), CC0",
};

// ambientCG serves a preview for every asset id at a fixed path (seen in its v2 API previewData, 2026-11-12).
function libraryThumbnail(row) {
  if (row.source === "ambientcg") return `https://acg-media.struffelproductions.com/file/ambientCG-Web/media/thumbnail/256-PNG/${row.source_id}.png`;
  return null;
}

function libraryRecord(row) {
  const get = parseMaybe(row.get) ?? {};
  const licence = normaliseLicence(row.licence);
  const klass = licenceClass(licence);
  const sizeMetres = roundSize(row.size_m) ?? (row.scan_area_m ? roundSize([row.scan_area_m[0], 0.001, row.scan_area_m[1]]) : null);
  const isSurface = !row.size_m && row.scan_area_m;
  let credit = row.credit ?? LIBRARY_CREDITS[row.source] ?? null;
  if (row.source === "megascans") credit = `${row.title}, Quixel Megascans via Fab (${get.url}). Licensed to you under the Fab Standard Licence when you claim it; do not redistribute.`;
  const notes = [];
  if (isSurface) notes.push(`scanned area ${row.scan_area_m.join(" x ")} m`);
  if (row.tileable) notes.push("tileable");
  if (row.pbr_maps?.length) notes.push(`maps: ${row.pbr_maps.join(", ")}`);
  if (row.max_texture_px) notes.push(`up to ${row.max_texture_px} px`);
  if (row.no_ai) notes.push("Fab NoAI: not for AI training");
  const record = {
    id: row.asset_id,
    title: row.title,
    source: row.source,
    kind: row.kind,
    category: row.category_path ?? null,
    style: row.style ?? null,
    licence,
    licence_url: LICENCE_URLS[licence] ?? null,
    authors: Array.isArray(row.authors) ? row.authors.join(", ") : row.authors ?? null,
    credit,
    page: row.source_url,
    size_m: isSurface ? null : sizeMetres,
    surface_m: isSurface ? row.scan_area_m : null,
    file_units: row.model_size_units ? `file units, not metres: ${row.model_size_units.join(" x ")}` : (sizeMetres ? "metres" : null),
    triangles: row.triangles ?? null,
    get,
    thumbnail: row.preview_url ?? libraryThumbnail(row),
    collection: row.collection ?? null,
    rigged: row.rigged || null,
    animated: row.animated || null,
    ai_generated: row.ai_generated || null,
    notes: notes.length ? notes.join("; ") : null,
  };
  const group = row.source === "polyhaven" ? 1 : klass === "link-only" ? 3 : 2;
  return {
    record,
    prior: 1 + (row.size_m ? 0.5 : 0) + (row.triangles ? 0.2 : 0),
    group,
    titleText: row.title,
    tagText: [row.kind, row.category_path, row.surface_type, row.collection, ...(row.tags ?? [])].filter(Boolean).join(" "),
    otherText: [...(row.biomes ?? []), row.animation_role, row.style].filter(Boolean).join(" "),
    facts: {
      kind: row.kind,
      licenceClass: klass,
      glbReady: false,
      rigged: Boolean(row.rigged),
      animated: Boolean(row.animated),
      style: row.style ?? null,
      aiGenerated: Boolean(row.ai_generated),
      realScale: Boolean(row.size_m || row.scan_area_m),
      direct: klass !== "link-only",
      sizeMetres: largest(row.size_m ?? row.scan_area_m),
    },
  };
}

// ---------- build ----------

async function main() {
  const entries = [];
  const sourceKeys = [];
  const sourceSummaries = [];

  const simreadyBounds = new Map();
  const manifestPath = join(packsFolder, "simready-glb", "manifest.jsonl");
  if (existsSync(manifestPath)) {
    for (const row of await readJsonLines(manifestPath)) if (row.bounds) simreadyBounds.set(row.asset, row.bounds);
  }

  if (!existsSync(assetIndexPath)) throw new Error(`missing ${assetIndexPath}; run scripts/fetch-sources.sh`);
  const allLibraryRows = await readJsonLines(assetIndexPath);
  for (const row of allLibraryRows) libraryRowsById.set(row.asset_id, row);
  // Library rows that a GLB pack now covers: Smithsonian, Kenney models, and Quaternius packs with converted models.
  const repackedIds = new Set();
  const repackedQuaterniusPacks = new Set();

  for (const pack of PACKS) {
    const path = join(packsFolder, pack.repo, "metadata.jsonl");
    if (!existsSync(path) && pack.optional) continue;
    if (!existsSync(path)) throw new Error(`missing ${path}; run scripts/fetch-sources.sh`);
    const rows = await readJsonLines(path);
    const sourceIndex = sourceKeys.push(pack.repo) - 1;
    const licences = new Map();
    for (const row of rows) {
      const entry = packRecord(pack, row, simreadyBounds);
      entry.facts.sourceIndex = sourceIndex;
      if (pack.repo === "kenney-glb") repackedIds.add(`kenney:${row.id}`);
      if (pack.repo === "quaternius-glb") {
        repackedIds.add(`quaternius:${row.id}`);
        repackedQuaterniusPacks.add(`quaternius:${row.kit_slug}`);
      }
      entries.push(entry);
      licences.set(entry.record.licence, (licences.get(entry.record.licence) ?? 0) + 1);
    }
    sourceSummaries.push({
      source: pack.repo,
      name: pack.name,
      kind: "glb pack",
      assets: rows.length,
      licences: Object.fromEntries(licences),
      files: pack.linkOut ? `links to each model page on ${pack.linkOut}; no file served` : "GLB on Hugging Face (web, and where built: ktx2, lod1-3, mobile, engine, collision)",
      scale: pack.realScale ? "real metres" : (pack.unitScale ?? "as authored"),
      url: `${HUGGING_FACE_BASE}/${pack.repo}`,
    });
  }

  const libraryRows = allLibraryRows.filter((row) => row.source !== "smithsonian" && !repackedIds.has(row.asset_id) && !repackedQuaterniusPacks.has(row.asset_id));
  const librarySummaries = new Map();
  for (const row of libraryRows) {
    if (!sourceKeys.includes(row.source)) sourceKeys.push(row.source);
    const entry = libraryRecord(row);
    entry.facts.sourceIndex = sourceKeys.indexOf(row.source);
    entries.push(entry);
    const summary = librarySummaries.get(row.source) ?? { assets: 0, licences: {}, kinds: {} };
    summary.assets += 1;
    summary.licences[entry.record.licence] = (summary.licences[entry.record.licence] ?? 0) + 1;
    summary.kinds[row.kind] = (summary.kinds[row.kind] ?? 0) + 1;
    librarySummaries.set(row.source, summary);
  }
  for (const [key, summary] of librarySummaries) {
    sourceSummaries.push({
      source: key,
      name: LIBRARIES[key]?.name ?? key,
      kind: "library",
      assets: summary.assets,
      licences: summary.licences,
      kinds: summary.kinds,
      files: LIBRARIES[key]?.hosted ?? "at the library",
      scale: key === "megascans" || key === "polyhaven" ? "real metres where listed" : "as authored",
      url: { polyhaven: "https://polyhaven.com", ambientcg: "https://ambientcg.com", kenney: "https://kenney.nl", quaternius: "https://quaternius.com", megascans: "https://www.fab.com/sellers/Quixel" }[key],
    });
  }

  // Best first: real-size GLB, other GLB and Poly Haven, CC0 downloads, link-only. The document number is the rank
  // an empty query returns, and the tie-breaker everywhere else.
  entries.sort((left, right) => left.group - right.group || right.prior - left.prior || left.record.id.localeCompare(right.record.id));

  rmSync(outputFolder, { recursive: true, force: true });
  mkdirSync(join(outputFolder, "docs"), { recursive: true });
  mkdirSync(join(outputFolder, "words"), { recursive: true });
  mkdirSync(join(outputFolder, "cards"), { recursive: true });

  const facets = new Uint32Array(entries.length);
  const postings = new Map();
  const idToDocument = {};
  for (const [documentNumber, entry] of entries.entries()) {
    facets[documentNumber] = packFacets(entry.facts);
    idToDocument[entry.record.id] = documentNumber;
    const weights = new Map();
    for (const [text, weight] of [[entry.otherText, 1], [entry.tagText, 2], [entry.titleText, 3]]) {
      for (const word of words(text)) weights.set(word, Math.max(weights.get(word) ?? 0, weight));
    }
    for (const [word, weight] of weights) {
      let list = postings.get(word);
      if (!list) {
        list = [];
        postings.set(word, list);
      }
      if (list.length < MAX_POSTINGS_PER_WORD) list.push(documentNumber * 4 + weight);
    }
  }

  for (let start = 0; start < entries.length; start += BLOCK_SIZE) {
    const block = entries.slice(start, start + BLOCK_SIZE).map((entry) => {
      const record = entry.record;
      for (const key of Object.keys(record)) if (record[key] === null || record[key] === undefined) delete record[key];
      return record;
    });
    writeFileSync(join(outputFolder, "docs", `${start / BLOCK_SIZE}.json`), JSON.stringify(block));
  }

  // Cards: the few fields a search result shows, in small blocks, so a search decodes little.
  for (let start = 0; start < entries.length; start += CARD_BLOCK_SIZE) {
    const block = entries.slice(start, start + CARD_BLOCK_SIZE).map((entry) => {
      const card = {};
      for (const field of CARD_FIELDS) if (entry.record[field] !== undefined) card[field] = entry.record[field];
      if (entry.record.tiers) card.glb = true;
      return card;
    });
    writeFileSync(join(outputFolder, "cards", `${start / CARD_BLOCK_SIZE}.json`), JSON.stringify(block));
  }

  const buckets = Array.from({ length: BUCKET_COUNT }, () => ({}));
  for (const [word, list] of postings) buckets[bucketOf(word)][word] = list;
  for (const [index, bucket] of buckets.entries()) writeFileSync(join(outputFolder, "words", `${index}.json`), JSON.stringify(bucket));

  writeFileSync(join(outputFolder, "facets.bin"), Buffer.from(facets.buffer));
  // id → document number, split by the first characters of the id so a lookup reads one small file.
  const idBuckets = {};
  for (const [id, documentNumber] of Object.entries(idToDocument)) {
    const key = bucketOf(id) % 256;
    (idBuckets[key] ??= {})[id] = documentNumber;
  }
  mkdirSync(join(outputFolder, "ids"), { recursive: true });
  for (let index = 0; index < 256; index += 1) writeFileSync(join(outputFolder, "ids", `${index}.json`), JSON.stringify(idBuckets[index] ?? {}));

  const manifest = {
    version: 1,
    built_on: READ_ON,
    documents: entries.length,
    block_size: BLOCK_SIZE,
    card_block_size: CARD_BLOCK_SIZE,
    bucket_count: BUCKET_COUNT,
    id_bucket_count: 256,
    words: postings.size,
    sources: sourceKeys,
    pack_base: HUGGING_FACE_BASE,
    // From scripts/probe-tiers.mjs: the glTF extensions each pack's tiers require.
    tier_requirements: {
      "generated-glb": GENERATED_TIER_REQUIREMENTS,
      ...(existsSync(join(projectFolder, "cache", "tier-requirements.json"))
        ? JSON.parse(readFileSync(join(projectFolder, "cache", "tier-requirements.json"), "utf8"))
        : {}),
    },
    source_summaries: sourceSummaries,
  };
  writeFileSync(join(outputFolder, "manifest.json"), JSON.stringify(manifest, null, 1));
  const landing = readFileSync(join(projectFolder, "site", "index.html"), "utf8")
    .replaceAll("{{ASSETS}}", entries.length.toLocaleString("en-US"))
    .replaceAll("{{GLB}}", entries.filter((entry) => entry.facts.glbReady).length.toLocaleString("en-US"))
    .replaceAll("{{SOURCES}}", String(sourceKeys.length));
  writeFileSync(join(siteFolder, "index.html"), landing);
  cpSync(join(projectFolder, "site", "favicon.svg"), join(siteFolder, "favicon.svg"));
  const counts = {};
  for (const entry of entries) counts[entry.facts.licenceClass] = (counts[entry.facts.licenceClass] ?? 0) + 1;
  console.log(JSON.stringify({ documents: entries.length, words: postings.size, licence_classes: counts, glb_ready: entries.filter((entry) => entry.facts.glbReady).length }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
