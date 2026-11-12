# Free 3D assets for AI agents (MCP)

An MCP server that lets any AI agent find free 3D assets and use them right away. Ask for "a wooden chair, 0.8 m"
and get a GLB URL, the real size in metres, the licence and a credit line to paste into the project.

- **75,598 assets** from 17 GLB packs on Hugging Face and 4 libraries.
- **40,294 have a ready GLB**: web, KTX2, LOD, mobile, engine and collision tiers.
- Sizes in metres where the source knows them, and the file's units where it does not.
- Every result names its licence. CC BY results come with a ready credit line.

## Add it

Hosted (nothing to install):

```bash
claude mcp add --transport http free-3d-assets https://assets.codepawl.com/mcp
```

Other clients take the same URL:

```json
{ "mcpServers": { "free-3d-assets": { "url": "https://assets.codepawl.com/mcp" } } }
```

Local, over stdio, with no server of ours in the loop:

```bash
claude mcp add free-3d-assets -- npx -y github:codepawl/asset-gate
```

The local server reads the same index from Hugging Face, caches it in `~/.cache/codepawl-asset-gate` and hands out
direct Hugging Face URLs.

## Tools

| Tool | Does |
|---|---|
| `search_assets` | Plain words plus filters: `kind`, `licence` (`cc0`, `shippable`), `no_share_alike`, `glb_only`, `size_m` or `min_size_m`/`max_size_m`, `real_size_only`, `style`, `rigged`, `animated`, `no_ai_generated`, `sources`. A size in the words ("rock 2 m") becomes a size filter. |
| `get_asset` | GLB URL, every tier with the decoders it needs (`MeshoptDecoder`, `KTX2Loader`, measured per pack), a three.js load snippet, size, licence, licence URL, author and credit line. The default tier is the one that needs the fewest decoders. Poly Haven assets give glTF, HDRI or texture URLs; Megascans gives a Fab link only. |
| `list_sources` | Every pack and library with counts, licences and scale. |
| `generate_asset`, `get_generation` | Hosted gate only. When nothing fits, queue a model made with TRELLIS.2 (MIT, marked `ai_generated`) and poll for it. See below. |
| `find_elsewhere` | Search links for Poly Haven, ambientCG, Poly Pizza, Sketchfab, Smithsonian, NASA, Kenney, OpenGameArt and Fab when nothing fits. |

[examples/reading-corner](examples/reading-corner) is a three.js scene that an agent built with these tools alone.

The hosted gate also answers plain HTTP: `/api/search?q=wooden%20chair&glb_only=true`, `/api/asset/<id>`,
`/api/sources`, `/api/elsewhere?q=`.

## Generated models

`generate_asset {prompt, image_url?, size_m?}` searches first and returns existing assets when they match every word
("generation skipped: found existing assets"). Only a miss queues a job: it returns `{job_id, status: "queued", eta_s}`,
and `get_generation {job_id}` answers `queued`, `running`, `done` (the same shape as `get_asset`, plus
`scale_to_apply` when `size_m` was given) or `failed` (a soft fail with a reason and no results). The same prompt and
image never generate twice: finished jobs are cached in
[codepawl/generated-glb](https://huggingface.co/datasets/codepawl/generated-glb). Limits: 5 new jobs per IP per day and
50 queued jobs in all. Over a limit, or when generation is unavailable, the answer is "no result". The same two calls are
`POST /api/generate` and `GET /api/generation/<id>`.

The Worker never calls a paid model and holds no keys. It stores the job in a KV namespace (2-day TTL) and lists it at
`GET /gen/queue`. `scripts/gen-processor.mjs --watch` on the owner's PC polls that list and does the work: FLUX schnell
for a reference picture of a text prompt, TRELLIS.2 on fal for the model, a sanity check (parses, mesh, over 500
triangles, not flat, finite), then three tiers (`engine` about 190k triangles, `lod1` about 25k, `web` with meshopt and
WebP) uploaded with a `record.json` and `status.json` to the dataset. fal spend is capped at $20 a month in a local
ledger (`~/.config/asset-gate/gen-ledger.json`). The fal key and the Hugging Face login stay on that machine. Tooling
(gltf-transform, meshoptimizer, sharp) installs under `~/.cache/asset-gate-tools`; the gate itself has no dependencies.
Generated assets join the search index as the `generated-glb` pack and are hidden by `no_ai_generated`.

## Sources

| Source | Assets | Licence | Files |
|---|---|---|---|
| [Amazon Berkeley Objects](https://huggingface.co/datasets/codepawl/abo-glb) | 7,953 | CC BY 4.0 | GLB, real metres |
| [Google Poly archive](https://huggingface.co/datasets/codepawl/google-poly-glb) | 9,971 | CC BY 3.0 | GLB, longest side 1 unit |
| Objaverse (CC0 and CC BY, from Sketchfab) | 6,015 | CC0 / CC BY 4.0 per model | link to the Sketchfab page only |
| [Pixel Art Atlas 3D](https://huggingface.co/datasets/codepawl/pixel-atlas-glb) | 6,194 | CC0 | GLB |
| [Smithsonian Open Access](https://huggingface.co/datasets/codepawl/smithsonian-3d-glb) | 3,451 | CC0 | GLB |
| [NVIDIA SimReady](https://huggingface.co/datasets/codepawl/simready-glb) | 2,595 | CC BY 4.0 | GLB with physics, real metres |
| [0 A.D. art](https://huggingface.co/datasets/codepawl/0ad-art-glb) | 1,670 | CC BY-SA 3.0 | GLB, many animated |
| [Google Scanned Objects](https://huggingface.co/datasets/codepawl/scanned-objects-glb) | 1,033 | CC BY 4.0 | GLB, real metres |
| [100STYLE motion clips](https://huggingface.co/datasets/codepawl/100style-glb) | 810 | CC BY 4.0 | rigged GLB clips |
| [PLATEAU Japan city tiles](https://huggingface.co/datasets/codepawl/plateau-city-glb) | 797 | CC BY 4.0 | GLB, real metres |
| [Mars HiRISE terrain](https://huggingface.co/datasets/codepawl/mars-hirise-terrain) | 320 | public domain | GLB, real metres |
| [NASA 3D Resources](https://huggingface.co/datasets/codepawl/nasa-3d-glb) | 256 | no US copyright | GLB |
| [World Fish](https://huggingface.co/datasets/codepawl/world-fish-glb) | 121 | CC0 | GLB |
| [MuJoCo Menagerie robots](https://huggingface.co/datasets/codepawl/menagerie-glb) | 79 | MIT / Apache / BSD per robot | GLB, real metres |
| [CT anatomy](https://huggingface.co/datasets/codepawl/ct-anatomy-glb) | 27 | CC BY 4.0 | GLB |
| Poly Haven | 2,387 | CC0 | glTF, HDRI and texture URLs from the Poly Haven API |
| ambientCG | 2,917 | CC0 | zip downloads |
| [Kenney game kits](https://huggingface.co/datasets/codepawl/kenney-glb) | 4,451 | CC0 | GLB, kit units |
| [Quaternius packs](https://huggingface.co/datasets/codepawl/quaternius-glb) | 566 | CC0 | GLB, many rigged and animated; the other packs link to their download |
| Quixel Megascans | 22,696 | Fab Standard Licence | link to Fab only |

Megascans files are licensed by Fab to each user and are never hosted or passed on here. The full licence notes per
source are in [RESEARCH.md](RESEARCH.md).

## How it works

`scripts/build-index.mjs` turns every pack's `metadata.jsonl` and the
[asset-index](https://huggingface.co/datasets/codepawl/asset-index) table into a sharded index: asset records in blocks
of 100, word postings in 1,024 buckets and one 32-bit number of facets per asset. A search reads the buckets for its
words and the small card blocks of its top results, so an MCP call takes about 2 ms of Worker CPU (median, measured
on 2026-11-12). GLB links are
302 redirects to Hugging Face; nothing is proxied.

```bash
npm run fetch      # download the metadata
npm run build      # build dist/site (index + landing page)
npm run probe      # read the glTF extensions each pack tier requires
npm test           # tests over the built index
npm run check-urls # HEAD a few files of every source and tier
npm run deploy     # Cloudflare Worker
```

## Credits

Poly Haven content comes through the Poly Haven API: Powered by Poly Haven. Each asset keeps its own licence; use the
credit line `get_asset` returns. Code: MIT.
