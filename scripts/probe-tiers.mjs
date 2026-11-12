// Reads the glTF JSON chunk at the start of a few GLB files per pack and tier, and records the extensions each tier
// requires. The build stores them so get_asset can pick a tier the caller's loader opens and print the right setup.
//   node scripts/probe-tiers.mjs   → cache/tier-requirements.json
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalServer } from "../src/stdio.mjs";

const projectFolder = join(dirname(fileURLToPath(import.meta.url)), "..");
const { index } = createLocalServer(join(projectFolder, "dist", "site", "index", "v1"));
const manifest = await index.manifest();
const facets = await index.facets();

async function requiredExtensions(url) {
  let size = 65536;
  for (;;) {
    const response = await fetch(url, { headers: { Range: `bytes=0-${size - 1}` } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x46546c67) throw new Error(`not a GLB: ${url}`);
    const jsonLength = view.getUint32(12, true);
    if (bytes.length >= 20 + jsonLength) {
      const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
      return json.extensionsRequired ?? [];
    }
    size = 20 + jsonLength;
  }
}

const firstBySource = new Map();
for (let number = 0; number < facets.length; number += 1) {
  const source = manifest.sources[(facets[number] >>> 6) & 0x3f];
  const list = firstBySource.get(source) ?? [];
  if (list.length < 3 && (facets[number] & (1 << 19))) list.push(number);
  firstBySource.set(source, list);
}

const requirements = {};
for (const [source, numbers] of firstBySource) {
  if (!numbers.length) continue;
  const records = await index.documents(numbers);
  const tiers = {};
  for (const record of records) {
    for (const [tier, path] of Object.entries(record.tiers)) {
      if (!path.endsWith(".glb")) continue;
      const url = `${manifest.pack_base}/${record.pack}/resolve/main/${path.split("/").map(encodeURIComponent).join("/")}`;
      const required = await requiredExtensions(url);
      tiers[tier] = [...new Set([...(tiers[tier] ?? []), ...required])].sort();
    }
  }
  requirements[source] = tiers;
  console.log(source, JSON.stringify(tiers));
}
writeFileSync(join(projectFolder, "cache", "tier-requirements.json"), JSON.stringify(requirements, null, 1));
