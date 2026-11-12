// Text handling shared by the index build and the search, so both cut words the same way.

const STOP_WORDS = new Set([
  "a", "an", "the", "of", "for", "with", "and", "or", "in", "on", "to", "by", "at", "from", "is", "it",
  "3d", "model", "models", "glb", "gltf", "asset", "assets", "free", "mesh", "file", "files", "some", "any",
  "me", "i", "need", "want", "find", "get", "please", "x",
]);

// A few words people use for the same thing. Each maps to the word the libraries use most.
const SYNONYMS = {
  couch: "sofa", automobile: "car", vehicle: "car", seat: "chair", stool: "chair", lamp: "light",
  rug: "carpet", bin: "trash", garbage: "trash", plant: "plant", shrub: "bush", boulder: "rock",
  stone: "rock", pebble: "rock", skybox: "hdri", environment: "hdri", texture: "material",
  wood: "wood", wooden: "wood", metallic: "metal", tree: "tree", fish: "fish", robot: "robot",
};

function stem(word) {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 4 && /(ches|shes|sses|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

export function words(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word) && !/^\d+$/.test(word))
    .map(stem);
}

// Two-word names that the libraries call by another word. Matched on the cut words, before synonyms.
const PHRASES = {
  "robot dog": "quadruped robot",
  "robotic dog": "quadruped robot",
  "robot hand": "end effector robot",
  "robot gripper": "end effector robot",
  "humanoid robot": "humanoid robot",
};

function expandPhrases(cutWords) {
  const joined = cutWords.join(" ");
  let expanded = joined;
  for (const [phrase, replacement] of Object.entries(PHRASES)) {
    const phraseWords = words(phrase).join(" ");
    if (expanded.includes(phraseWords)) expanded = expanded.replace(phraseWords, words(replacement).join(" "));
  }
  return expanded === joined ? cutWords : expanded.split(" ");
}

export function queryWords(text) {
  const found = [];
  for (const word of expandPhrases(words(text))) {
    const mapped = SYNONYMS[word] ?? word;
    if (!found.includes(mapped)) found.push(mapped);
  }
  return found;
}

// Bucket a token lands in. FNV-1a, so the build (Node) and the Worker agree.
export const BUCKET_COUNT = 1024;

export function bucketOf(token) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % BUCKET_COUNT;
}

// "a 2 m rock", "chair 45cm" → size in metres.
export function sizeFromQuery(text) {
  const match = /(\d+(?:\.\d+)?)\s?(mm|cm|m)\b/i.exec(text ?? "");
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "mm") return value / 1000;
  if (unit === "cm") return value / 100;
  return value;
}
