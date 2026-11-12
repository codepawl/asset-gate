// One entry per library or pack the gate searches. Licence facts were read from each pack's own README and
// LICENSES.md on Hugging Face and from each library's site (see RESEARCH.md).

export const HUGGING_FACE_BASE = "https://huggingface.co/datasets/codepawl";

export const LICENCE_URLS = {
  "CC0-1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
  "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
  "CC-BY-3.0": "https://creativecommons.org/licenses/by/3.0/",
  "CC-BY-SA-3.0": "https://creativecommons.org/licenses/by-sa/3.0/",
  "MIT": "https://opensource.org/license/mit",
  "Apache-2.0": "https://www.apache.org/licenses/LICENSE-2.0",
  "BSD-2-Clause": "https://opensource.org/license/bsd-2-clause",
  "BSD-3-Clause": "https://opensource.org/license/bsd-3-clause",
  "BSD-3-Clause-Clear": "https://spdx.org/licenses/BSD-3-Clause-Clear.html",
  "public-domain": "https://creativecommons.org/publicdomain/mark/1.0/",
  "LicenseRef-Fab-Standard": "https://www.fab.com/eula",
  "LicenseRef-Quaternius-Asset-License": "https://quaternius.com/",
};

// Licence classes the search filters on.
//   cc0          no credit needed (CC0, public domain, no US copyright)
//   attribution  ship it with the credit line (CC BY, MIT, Apache, BSD)
//   share-alike  ship it with the credit line, and what you make from it carries the same licence (CC BY-SA)
//   link-only    the library licenses it to each user; we only link to it (Fab, Quaternius Asset Licence)
export function licenceClass(licence) {
  if (!licence) return "attribution";
  if (licence === "CC0-1.0" || licence === "public-domain") return "cc0";
  if (licence.startsWith("CC-BY-SA")) return "share-alike";
  if (licence.startsWith("LicenseRef-")) return "link-only";
  return "attribution";
}

export function normaliseLicence(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  const known = {
    "CC BY-SA 3.0": "CC-BY-SA-3.0",
    "public-domain": "public-domain",
    "NASA media usage guidelines (no US copyright)": "public-domain",
  };
  return known[text] ?? text;
}

// Hugging Face GLB packs. `defaults` fills fields a row leaves empty; `credit` builds the line to show.
export const PACKS = [
  {
    repo: "abo-glb", name: "Amazon Berkeley Objects", licence: "CC-BY-4.0", realScale: true,
    credit: () => "Amazon Berkeley Objects by Amazon.com (amazon-berkeley-objects.s3.amazonaws.com), CC BY 4.0. Converted to GLB by CodePawl.",
  },
  {
    repo: "simready-glb", name: "NVIDIA SimReady", licence: "CC-BY-4.0", realScale: true,
    credit: () => "NVIDIA SimReady assets (NVIDIA Corporation), CC BY 4.0. Converted to GLB by CodePawl.",
  },
  {
    repo: "scanned-objects-glb", name: "Google Scanned Objects", licence: "CC-BY-4.0", realScale: true,
    credit: () => "Google Scanned Objects by Google Research (fuel.gazebosim.org/1.0/GoogleResearch), CC BY 4.0. Converted to GLB by CodePawl.",
  },
  {
    repo: "objaverse-clean-glb", name: "Objaverse (CC0 and CC BY, links to Sketchfab)", licence: null, unitScale: "as uploaded to Sketchfab", linkOut: "sketchfab",
    credit: (row) => `"${row.title}" by ${row.authors} (${row.source_url}), ${row.license}. From Objaverse 1.0 (Allen Institute for AI); scaled and converted to GLB by CodePawl.`,
  },
  {
    repo: "google-poly-glb", name: "Google Poly archive", licence: "CC-BY-3.0", unitScale: "longest side 1 unit",
    credit: (row) => `"${row.title}" by ${row.authors} (${row.poly_url}), ${row.license}. Via the polygone.art archive; scaled and converted to GLB by CodePawl.`,
  },
  {
    repo: "smithsonian-3d-glb", name: "Smithsonian Open Access 3D", licence: "CC0-1.0",
    credit: (row) => `${row.title}, ${row.authors}, Smithsonian Open Access (CC0).`,
  },
  {
    repo: "kenney-glb", name: "Kenney game kits", licence: "CC0-1.0", unitScale: "file units, as the kit was built",
    credit: (row) => `${row.title} from ${row.kit} by Kenney (kenney.nl), CC0. Repacked as GLB by CodePawl.`,
  },
  {
    repo: "quaternius-glb", name: "Quaternius packs", licence: "CC0-1.0", unitScale: "file units, as the pack was built",
    credit: (row) => `${row.title} from ${row.kit} by Quaternius (quaternius.com), CC0. Converted to GLB by CodePawl.`,
  },
  {
    repo: "nasa-3d-glb", name: "NASA 3D Resources", licence: "public-domain",
    credit: (row) => `${row.title}, NASA 3D Resources (github.com/nasa/NASA-3D-Resources). No US copyright; do not imply NASA endorsement.`,
  },
  {
    repo: "pixel-atlas-glb", name: "Pixel Art Atlas 3D", licence: "CC0-1.0", unitScale: "1 unit wide", aiGenerated: true,
    credit: () => "Pixel Art Atlas by Angais (huggingface.co/datasets/Angais/pixel-art-atlas-1.4m), CC0. Built into 3D by CodePawl.",
  },
  {
    repo: "world-fish-glb", name: "World Fish", licence: "CC0-1.0",
    credit: () => "World Fish, made with the fish-kit method by @nachat_dayo, CC0. CodePawl.",
  },
  {
    repo: "0ad-art-glb", name: "0 A.D. art", licence: "CC-BY-SA-3.0",
    credit: (row) => `${row.title}, 0 A.D. art by Wildfire Games (wildfiregames.com), CC BY-SA 3.0. Converted to GLB by CodePawl.`,
  },
  {
    repo: "plateau-city-glb", name: "PLATEAU Japan city tiles", licence: "CC-BY-4.0", realScale: true,
    credit: (row) => `${row.title}, MLIT Project PLATEAU (mlit.go.jp/plateau), ${row.authors}, CC BY 4.0. Converted to GLB by CodePawl.`,
  },
  {
    repo: "mars-hirise-terrain", name: "Mars HiRISE terrain", licence: "public-domain", realScale: true,
    credit: (row) => `${row.title}, HiRISE DTM: NASA/JPL/University of Arizona. Meshed by CodePawl.`,
  },
  {
    repo: "ct-anatomy-glb", name: "CT anatomy", licence: "CC-BY-4.0",
    credit: () => "TotalSegmentator dataset (Wasserthal et al., University Hospital Basel), CC BY 4.0. Meshes by CodePawl.",
  },
  {
    repo: "menagerie-glb", name: "MuJoCo Menagerie robots", licence: null, realScale: true,
    credit: (row) => `${row.title}, MuJoCo Menagerie (Google DeepMind) and ${row.authors}, ${row.license}. Converted to GLB by CodePawl.`,
  },
  {
    repo: "100style-glb", name: "100STYLE motion clips", licence: "CC-BY-4.0",
    credit: () => "The 100STYLE Dataset, Ian Mason, CC BY 4.0. Retargeted to a CC0 Quaternius character by CodePawl.",
  },
];

// Libraries in codepawl/asset-index that are not packed as GLB yet.
export const LIBRARIES = {
  polyhaven: { name: "Poly Haven", hosted: "files at Poly Haven, CC0" },
  ambientcg: { name: "ambientCG", hosted: "zip at ambientCG, CC0" },
  kenney: { name: "Kenney", hosted: "inside the kit zip at kenney.nl, CC0" },
  quaternius: { name: "Quaternius", hosted: "pack at quaternius.com" },
  megascans: { name: "Quixel Megascans (Fab)", hosted: "claim on Fab; link only" },
};
