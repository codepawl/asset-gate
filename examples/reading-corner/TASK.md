Build a small, good-looking three.js scene in one file, `index.html`, in this folder: a cozy reading corner.
It needs at least 5 real 3D assets (for example an armchair, a floor lamp, a side table, a rug or plant, a bookshelf)
plus an HDRI for lighting.

Rules:
- Get every asset ONLY through the free-3d-assets MCP tools (search_assets, get_asset). Do not invent URLs or use any other source.
- Place things at their real size: use size_m from get_asset; scale assets whose size is not in metres to a sensible real size.
- Load three.js r170 from https://cdn.jsdelivr.net/npm/three@0.170.0/ via an importmap (GLTFLoader, RGBELoader, OrbitControls, MeshoptDecoder from examples/jsm).
- Add a credits overlay listing every asset's credit line from get_asset.
- When done, also write `assets.json`: one entry per asset with id, url used, size_m and credit.
