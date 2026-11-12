# Research: free 3D assets for agents (read 2026-11-12)

"Measured" means the primary source (repo, API or terms page) was read. "Inferred" means a reading of it.

**Answer.** No existing MCP does what the gate does: one search across many libraries, real sizes, licence and
credit line, a direct GLB URL, no host app. The closest is blender-mcp, which needs Blender running. The licence
picture is workable. Three real constraints: Fab/Megascans stay link-out, Sketchfab files are never re-hosted by us,
and the Poly Haven live-API credit applies to the Worker.

## 1. What exists

### blender-mcp (ahujasid), measured

- [github.com/ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp), MIT, 34,117 stars, last push 2026-11-04.
- Integrates Poly Haven, Sketchfab and Poly Pizza through `search_assets` and `import_asset`; generation (Tripo,
  Hunyuan3D, Hyper3D Rodin, Meshy) through one `generate_3d` tool.
- Nine tools: `execute_blender_code`, `look`, `get_scene_info`, `generate_3d`, `search_assets`, `import_asset`,
  `get_addon_status`, `disable_telemetry`, `record_trajectory_feedback`.
- Needs Blender running: an addon opens a socket on `localhost:9876`. Nothing works headless, and there are no GLB URLs
  because assets go straight into a Blender scene.
- Poly Haven imports print a source line and a `scale_mm` note. Sketchfab imports are scaled to a `target_size`, so the
  true size is lost. No common credit line across sources.

### Other servers (measured with `gh`, 2026-11-12)

| Tool | Sources | Stars | Last push | Host app |
|---|---|---|---|---|
| [RN0000/polyhaven-mcp](https://github.com/RN0000/polyhaven-mcp) | Poly Haven only, direct file URLs | 0 | 2026-07-08 | none |
| [gregkop/sketchfab-mcp-server](https://github.com/gregkop/sketchfab-mcp-server) | Sketchfab | 46 | 2025-03-09 | none |
| [AliRezaBeigy/sketchfab-mcp-server](https://github.com/AliRezaBeigy/sketchfab-mcp-server) | Sketchfab | 2 | 2026-06-29 | none |
| [HaD0Yun/poly-pizza-mcp](https://github.com/HaD0Yun/poly-pizza-mcp) | Poly Pizza | 3 | 2025-12-21 | none |
| [MatthewHallCom/Poly-Pizza-MCP](https://github.com/MatthewHallCom/Poly-Pizza-MCP) | Poly Pizza | 2 | 2025-12-17 | none |

No ambientCG, Kenney, Quaternius, Smithsonian or Megascans MCP was found. The official registry
(`registry.modelcontextprotocol.io`) returned nothing for these sources. Smithery, Glama and mcp.so were not read
directly: check them before any "first" claim in a post.

## 2. Licence rules per source

| Source | Licence | What the gate may do | Read at |
|---|---|---|---|
| Poly Haven | CC0 assets; API free for any use incl. commercial | Return file URLs from the API. Send a unique User-Agent (ToS 2.4); show a light "Powered by Poly Haven" credit wherever the live API's content shows (ToS 2.5). Never scrape the website (site ToS 3.2) | [API ToS](https://github.com/Poly-Haven/Public-API/blob/master/ToS.md), [licence](https://polyhaven.com/license) |
| ambientCG | CC0, no credit needed | Link the zips; cache politely | [licence](https://docs.ambientcg.com/license/) |
| Kenney | CC0, credit optional; no Kenney logo | Link the kit zip | [support](https://kenney.nl/support) |
| Quaternius | CC0 for 82 packs; one pack under the Quaternius Asset Licence (no redistribution) | Link; that one pack is link-only | [faq](https://quaternius.com/faq.html) |
| Smithsonian Open Access | CC0 items only; no Smithsonian logo; third-party rights may remain | Our GLB pack (CC0 items only) | [faq](https://www.si.edu/openaccess/faq) |
| Fab / Megascans | Fab Standard Licence: no free standalone redistribution | Link to the Fab listing only, never a file or a streaming redirect | [eula](https://www.fab.com/eula) |
| Sketchfab | Terms bar collecting content "for the purposes of ... making the content available to others"; Download API needs end-user login | Link-out only. Never re-host from Sketchfab directly | [terms 2026-10-27](https://sketchfab.com/terms), [download API](https://sketchfab.com/developers/download-api/guidelines) |
| CC BY 4.0 / 3.0 | Credit: creator, licence and link, link to the material, note of changes (3.0 also wants the title) | Every row carries a ready credit line with "converted by CodePawl" | [CC BY 4.0 deed](https://creativecommons.org/licenses/by/4.0/deed.en) |
| Amazon Berkeley Objects | CC BY 4.0, credit Amazon.com | Our GLB pack with credit | [ABO](https://amazon-berkeley-objects.s3.amazonaws.com/index.html) |
| NVIDIA SimReady | CC BY 4.0, credit NVIDIA | Our GLB pack with credit | [HF card](https://huggingface.co/datasets/nvidia/PhysicalAI-SimReady-Warehouse-01) |
| Google Scanned Objects | CC BY 4.0 | Our GLB pack with credit | [Google Research](https://research.google/blog/scanned-objects-by-google-research-a-dataset-of-3d-scanned-common-household-items/) |
| Hugging Face as a CDN | `/resolve/` limits per 5 minutes: 3,000 anonymous per IP, 5,000 free user | Redirect clients to HF, never proxy, so each agent uses its own IP budget | [rate limits](https://huggingface.co/docs/hub/rate-limits) |

Open risk (inferred): `codepawl/objaverse-clean-glb` holds CC0 and CC BY models that Objaverse collected from
Sketchfab. The CC licences allow redistribution, Sketchfab's terms bar bulk re-publishing by whoever collected them.
The pack is already public; the gate only indexes it and carries each author's credit. Read Objaverse's own terms
before promoting that pack by name.

## 3. Where the gate wins and loses

Wins (inferred from the comparison):

- One search across 15 GLB packs and 6 libraries, about 75,000 assets. Every other MCP covers one source.
- A direct GLB URL with no host app; works in three.js, 67js, Godot, Unity, Blender or a plain script.
- One credit line per asset, CC BY tracked, and a licence filter (CC0 only, shippable, no share-alike).
- Real size in metres where known (ABO, SimReady, Scanned Objects, PLATEAU, Mars, Menagerie, Megascans listings,
  Poly Haven), and the file's units stated where it is not.
- Scanned, CAD-like, anatomy, robot and city data that the live libraries do not have.

Loses:

- No Sketchfab live search (largest catalogue, but login-gated and not ours to re-host).
- Megascans is a link, not a file.
- No generation and no scene editing; the gate hands back a file and stops.
- Poly Haven is the best-proven single source and stays the place people already go.

## Decisions taken from this

1. Every record carries licence, licence URL, author, source page and a ready credit line.
2. Poly Haven API calls send `User-Agent: codepawl-asset-gate/<version>` and results credit Poly Haven.
3. Fab, Megascans and Sketchfab stay link-out. The fallback tool only links to them.
4. GLB downloads are 302 redirects to HF `resolve/` URLs, never proxied.
