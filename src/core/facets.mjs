// Every asset gets one 32-bit number holding what the filters need, so a filter never opens the asset records.

export const KINDS = ["model", "material", "hdri", "decal", "atlas", "brush", "terrain", "animation"];
export const LICENCE_CLASSES = ["cc0", "attribution", "share-alike", "link-only"];
export const STYLES = [null, "photoreal", "stylized", "lowpoly"];

const KIND_BITS = 0;
const LICENCE_BITS = 4;
const SOURCE_BITS = 6;
const SIZE_BITS = 12;
const GLB_BIT = 1 << 19;
const RIGGED_BIT = 1 << 20;
const ANIMATED_BIT = 1 << 21;
const STYLE_BITS = 22;
const AI_BIT = 1 << 24;
const REAL_SCALE_BIT = 1 << 25;
const DIRECT_BIT = 1 << 26;

// Size buckets on a log scale, about 12% wide, from under a millimetre to over a kilometre. 0 means unknown.
export function sizeBucket(metres) {
  if (!metres || !(metres > 0)) return 0;
  const bucket = Math.round(Math.log2(metres) * 6) + 64;
  return Math.min(127, Math.max(1, bucket));
}

export function packFacets(facts) {
  let value = 0;
  value |= (KINDS.indexOf(facts.kind) & 0xf) << KIND_BITS;
  value |= (LICENCE_CLASSES.indexOf(facts.licenceClass) & 0x3) << LICENCE_BITS;
  value |= (facts.sourceIndex & 0x3f) << SOURCE_BITS;
  value |= (sizeBucket(facts.sizeMetres) & 0x7f) << SIZE_BITS;
  if (facts.glbReady) value |= GLB_BIT;
  if (facts.rigged) value |= RIGGED_BIT;
  if (facts.animated) value |= ANIMATED_BIT;
  value |= (Math.max(0, STYLES.indexOf(facts.style ?? null)) & 0x3) << STYLE_BITS;
  if (facts.aiGenerated) value |= AI_BIT;
  if (facts.realScale) value |= REAL_SCALE_BIT;
  if (facts.direct) value |= DIRECT_BIT;
  return value >>> 0;
}

export function readFacets(value) {
  return {
    kind: KINDS[(value >>> KIND_BITS) & 0xf],
    licenceClass: LICENCE_CLASSES[(value >>> LICENCE_BITS) & 0x3],
    sourceIndex: (value >>> SOURCE_BITS) & 0x3f,
    sizeBucket: (value >>> SIZE_BITS) & 0x7f,
    glbReady: Boolean(value & GLB_BIT),
    rigged: Boolean(value & RIGGED_BIT),
    animated: Boolean(value & ANIMATED_BIT),
    style: STYLES[(value >>> STYLE_BITS) & 0x3],
    aiGenerated: Boolean(value & AI_BIT),
    realScale: Boolean(value & REAL_SCALE_BIT),
    direct: Boolean(value & DIRECT_BIT),
  };
}
