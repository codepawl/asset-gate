// Opens a few files of every source and tier with HEAD requests and reports any that do not answer 200.
//   node scripts/check-urls.mjs [index folder] [samples per source]
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalServer } from "../src/stdio.mjs";

const projectFolder = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexFolder = process.argv[2] ?? join(projectFolder, "dist", "site", "index", "v1");
const samplesPerSource = Number(process.argv[3] ?? 3);
const { index, tools } = createLocalServer(indexFolder);
const manifest = await index.manifest();
const facets = await index.facets();

const bySource = new Map();
for (let number = 0; number < facets.length; number += 1) {
  const source = manifest.sources[(facets[number] >>> 6) & 0x3f];
  const list = bySource.get(source) ?? [];
  list.push(number);
  bySource.set(source, list);
}

const failures = [];
let checked = 0;
for (const [source, numbers] of bySource) {
  const picks = [numbers[0], numbers[Math.floor(numbers.length / 2)], numbers[numbers.length - 1]].slice(0, samplesPerSource);
  for (const record of await index.documents(picks)) {
    const asset = await tools.call("get_asset", { id: record.id });
    const tierUrls = Object.fromEntries(Object.entries(asset.tiers ?? {}).map(([name, tier]) => [name, tier.url]));
    const urls = { ...tierUrls, ...(asset.extra_files ?? {}), thumbnail: asset.thumbnail, gltf: asset.gltf_url, hdri: asset.hdri_url };
    for (const [label, url] of Object.entries(urls)) {
      if (!url || url.includes("polyhaven.com/asset_img")) continue;
      const response = await fetch(url, { method: "HEAD", redirect: "follow" });
      checked += 1;
      if (response.status !== 200) failures.push(`${response.status} ${source} ${label} ${url}`);
    }
  }
}
console.log(`checked ${checked} URLs, ${failures.length} failed`);
for (const line of failures) console.log(line);
process.exitCode = failures.length ? 1 : 0;
