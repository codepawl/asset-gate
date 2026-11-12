# Reading corner, built by an agent through the gate

Claude Code (Sonnet, headless) built this scene from [TASK.md](TASK.md) with only the hosted MCP tools in
[mcp.json](mcp.json). It made 7 `search_assets` calls and 7 `get_asset` calls, and finished in 69 s and 18 turns
(2026-11-12). Every URL and credit line in [assets.json](assets.json) came from the gate.

Serve the folder and open `index.html`:

```bash
npx serve examples/reading-corner
```
