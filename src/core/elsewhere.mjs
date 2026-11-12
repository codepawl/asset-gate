// Free libraries outside the gate. Search URLs were opened by hand on 2026-11-12; licence notes come from each
// library's licence page (see RESEARCH.md).

const SOURCES = [
  {
    name: "Poly Haven",
    kinds: ["model", "material", "hdri"],
    search: (query) => `https://polyhaven.com/all?s=${query}`,
    licence: "CC0",
    credit: "not required",
  },
  {
    name: "ambientCG",
    kinds: ["material", "hdri", "model", "decal", "atlas"],
    search: (query) => `https://ambientcg.com/list?q=${query}`,
    licence: "CC0",
    credit: "not required",
  },
  {
    name: "Poly Pizza",
    kinds: ["model"],
    search: (query) => `https://poly.pizza/search/${query}`,
    licence: "CC0 or CC BY, per model",
    credit: "credit the author for CC BY models, as the model page shows",
  },
  {
    name: "Sketchfab (downloadable models)",
    kinds: ["model", "animation"],
    search: (query) => `https://sketchfab.com/search?q=${query}&type=models&features=downloadable`,
    licence: "per model (many CC BY); download needs a Sketchfab account",
    credit: "author, model link and licence, plus 'from Sketchfab'; never re-host the files",
    link_only: true,
  },
  {
    name: "Smithsonian 3D",
    kinds: ["model"],
    search: (query) => `https://3d.si.edu/search/collection?edan_q=${query}`,
    licence: "CC0 for items marked CC0",
    credit: "not required; the Smithsonian suggests title, museum and licence",
  },
  {
    name: "NASA 3D Resources",
    kinds: ["model", "terrain"],
    search: (query) => `https://github.com/search?q=repo%3Anasa%2FNASA-3D-Resources+${query}&type=code`,
    licence: "no US copyright; NASA media guidelines (no endorsement, no NASA logo)",
    credit: "name NASA as the source",
  },
  {
    name: "Kenney",
    kinds: ["model", "material", "atlas"],
    search: (query) => `https://kenney.nl/assets?search=${query}`,
    licence: "CC0",
    credit: "optional; do not use the Kenney logo",
  },
  {
    name: "OpenGameArt",
    kinds: ["model", "material", "animation", "atlas"],
    search: (query) => `https://opengameart.org/art-search-advanced?keys=${query}`,
    licence: "per asset (CC0, CC BY, CC BY-SA, GPL)",
    credit: "as the asset page asks",
  },
  {
    name: "Fab (free listings)",
    kinds: ["model", "material", "hdri", "decal"],
    search: (query) => `https://www.fab.com/search?q=${query}&is_free=1`,
    licence: "Fab Standard Licence per user, or CC BY where marked",
    credit: "per listing; Standard Licence files may not be passed on",
    link_only: true,
  },
];

export function outsideSources(query, kind) {
  const encoded = encodeURIComponent(query.trim());
  return SOURCES
    .filter((source) => !kind || source.kinds.includes(kind))
    .map((source) => ({
      name: source.name,
      url: source.search(encoded),
      licence: source.licence,
      credit: source.credit,
      ...(source.link_only ? { link_only: true } : {}),
    }));
}
