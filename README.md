# Free 3D assets for AI agents (MCP)

An MCP server that lets any AI agent find free 3D assets and use them right away. Ask for "a wooden chair, 0.8 m"
and get a GLB URL, the real size in metres, the licence and a credit line to paste into the project.

- **75,509 assets** from 15 GLB packs on Hugging Face and 5 libraries.
- **41,292 have a ready GLB**: web, KTX2, LOD, mobile, engine and collision tiers.
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
| `find_elsewhere` | Search links for Poly Haven, ambientCG, Poly Pizza, Sketchfab, Smithsonian, NASA, Kenney, OpenGameArt and Fab when nothing fits. |

[examples/reading-corner](examples/reading-corner) is a three.js scene that an agent built with these tools alone.

The hosted gate also answers plain HTTP: `/api/search?q=wooden%20chair&glb_only=true`, `/api/asset/<id>`,
`/api/sources`, `/api/elsewhere?q=`.

## Sources

| Source | Assets | Licence | Files |
|---|---|---|---|
| [Amazon Berkeley Objects](https://huggingface.co/datasets/codepawl/abo-glb) | 7,953 | CC BY 4.0 | GLB, real metres |
| [Google Poly archive](https://huggingface.co/datasets/codepawl/google-poly-glb) | 9,971 | CC BY 3.0 | GLB, longest side 1 unit |
| [Objaverse (CC0 and CC BY)](https://huggingface.co/datasets/codepawl/objaverse-clean-glb) | 6,015 | CC0 / CC BY 4.0 per model | GLB, longest side 1 unit |
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
| Kenney | 4,434 | CC0 | inside the kit zip |
| Quaternius | 1,783 | CC0 (one pack link-only) | pack download |
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
