// Search over the sharded index. `store` reads index files by path: `store.json(path)` and `store.bytes(path)`.
// The Worker reads them from its static assets, the local server from Hugging Face with a disk cache.

import { bucketOf, queryWords, sizeFromQuery, words } from "./text.mjs";
import { KINDS, readFacets, sizeBucket } from "./facets.mjs";

const SIZE_BUCKETS_PER_DOUBLING = 6;
const RERANK_FACTOR = 3;

// How well the asset is the thing asked for, not just a mention of it:
// 2 per query word in its category, 1 more if its title is short (the word is likely the subject).
function subjectScore(card, tokens) {
  const category = new Set(words(card.category));
  let score = 0;
  for (const token of tokens) if (category.has(token)) score += 2;
  const titleLength = words(card.title).length;
  if (titleLength > 0 && titleLength <= 6) score += 1;
  return score;
}

export class AssetIndex {
  constructor(store) {
    this.store = store;
    this.manifestPromise = null;
    this.facetsPromise = null;
  }

  manifest() {
    this.manifestPromise ??= this.store.json("manifest.json");
    return this.manifestPromise;
  }

  facets() {
    this.facetsPromise ??= this.store.bytes("facets.bin").then((bytes) => new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
    return this.facetsPromise;
  }

  // Full records ("docs") or the short ones search results show ("cards").
  async documents(documentNumbers, folder = "docs") {
    const manifest = await this.manifest();
    const blockSize = folder === "cards" ? manifest.card_block_size : manifest.block_size;
    const blocks = new Map();
    for (const number of documentNumbers) {
      const block = Math.floor(number / blockSize);
      if (!blocks.has(block)) blocks.set(block, this.store.json(`${folder}/${block}.json`));
    }
    const found = [];
    for (const number of documentNumbers) {
      const block = await blocks.get(Math.floor(number / blockSize));
      found.push(block[number % blockSize]);
    }
    return found;
  }

  async documentById(id) {
    const manifest = await this.manifest();
    const ids = await this.store.json(`ids/${bucketOf(id) % manifest.id_bucket_count}.json`);
    const number = ids[id];
    if (number === undefined) return null;
    const [record] = await this.documents([number]);
    return record;
  }

  // filters: { kind, licence: "any"|"cc0"|"shippable", no_share_alike, sources: [], size_m, min_size_m, max_size_m,
  //            glb_only, rigged, animated, style, real_size_only, no_ai_generated }
  async search(text, filters = {}, limit = 10) {
    const manifest = await this.manifest();
    const facets = await this.facets();
    const accept = makeFilter(manifest, filters, text);
    const tokens = queryWords(text);
    const picked = [];

    if (tokens.length === 0) {
      for (let number = 0; number < facets.length && picked.length < limit; number += 1) {
        if (accept(facets[number])) picked.push({ number, score: 0, matched: 0 });
      }
    } else {
      const lists = await Promise.all(tokens.map(async (token) => {
        const bucket = await this.store.json(`words/${bucketOf(token)}.json`);
        return bucket[token] ?? [];
      }));
      const scores = new Map();
      lists.forEach((list, tokenIndex) => {
        if (list.length === 0) return;
        const rarity = Math.log(1 + manifest.documents / list.length);
        for (const packed of list) {
          const number = packed >>> 2;
          const weight = packed & 3;
          const current = scores.get(number);
          if (current) {
            if (current.lastToken !== tokenIndex) current.matched += 1;
            current.score += rarity * weight;
            current.lastToken = tokenIndex;
          } else {
            scores.set(number, { number, score: rarity * weight, matched: 1, lastToken: tokenIndex });
          }
        }
      });
      const ranked = [];
      for (const candidate of scores.values()) {
        if (accept(facets[candidate.number])) ranked.push(candidate);
      }
      // More query words matched wins, then word weight, then the asset's place in the build order.
      ranked.sort((left, right) => right.matched - left.matched || right.score - left.score || left.number - right.number);
      const shortlist = ranked.slice(0, Math.min(ranked.length, limit * RERANK_FACTOR));
      const cards = await this.documents(shortlist.map((candidate) => candidate.number), "cards");
      shortlist.forEach((candidate, position) => {
        candidate.card = cards[position];
        candidate.subject = subjectScore(cards[position], tokens);
      });
      // "wooden chair" should give chairs before a dining set whose title mentions chairs.
      shortlist.sort((left, right) => right.matched - left.matched || right.subject - left.subject || right.score - left.score || left.number - right.number);
      picked.push(...shortlist.slice(0, limit));
    }

    const records = picked.every((candidate) => candidate.card)
      ? picked.map((candidate) => candidate.card)
      : await this.documents(picked.map((candidate) => candidate.number), "cards");
    return {
      matched_words: tokens,
      results: records.map((record, index) => ({ record, matched: picked[index].matched, query_words: tokens.length })),
    };
  }
}

function makeFilter(manifest, filters, text) {
  const kindIndex = filters.kind ? KINDS.indexOf(filters.kind) : -1;
  if (filters.kind && kindIndex < 0) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  const sourceIndexes = filters.sources?.length
    ? new Set(filters.sources.flatMap((source) => {
      // "kenney" also means the repacked "kenney-glb", so old names keep working after a library gets its own pack.
      const indexes = [source, `${source}-glb`].map((name) => manifest.sources.indexOf(name)).filter((index) => index >= 0);
      if (!indexes.length) throw new Error(`unknown source "${source}"; list_sources names them`);
      return indexes;
    }))
    : null;
  const target = filters.size_m ?? (filters.min_size_m || filters.max_size_m ? null : sizeFromQuery(text));
  let lowBucket = 0;
  let highBucket = 0;
  if (target) {
    lowBucket = sizeBucket(target) - SIZE_BUCKETS_PER_DOUBLING;
    highBucket = sizeBucket(target) + SIZE_BUCKETS_PER_DOUBLING;
  } else if (filters.min_size_m || filters.max_size_m) {
    lowBucket = filters.min_size_m ? sizeBucket(filters.min_size_m) : 1;
    highBucket = filters.max_size_m ? sizeBucket(filters.max_size_m) : 127;
  }
  const licence = filters.licence ?? "any";

  return (value) => {
    const facts = readFacets(value);
    if (kindIndex >= 0 && facts.kind !== filters.kind) return false;
    if (sourceIndexes && !sourceIndexes.has(facts.sourceIndex)) return false;
    if (licence === "cc0" && facts.licenceClass !== "cc0") return false;
    if (licence === "shippable" && facts.licenceClass === "link-only") return false;
    if (filters.no_share_alike && facts.licenceClass === "share-alike") return false;
    if (filters.glb_only && !facts.glbReady) return false;
    if (filters.rigged && !facts.rigged) return false;
    if (filters.animated && !facts.animated) return false;
    if (filters.style && facts.style !== filters.style) return false;
    if (filters.real_size_only && !facts.realScale) return false;
    if (filters.no_ai_generated && facts.aiGenerated) return false;
    if (lowBucket || highBucket) {
      if (!facts.sizeBucket) return false;
      if (facts.sizeBucket < lowBucket || facts.sizeBucket > highBucket) return false;
    }
    return true;
  };
}
