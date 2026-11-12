#!/usr/bin/env node
// Local MCP server over stdio. Needs no Worker: it reads the index from Hugging Face (or a local folder) and keeps
// what it read in a disk cache, and hands out direct Hugging Face file URLs.
//
//   ASSET_GATE_INDEX   index folder or URL (default: the index on Hugging Face)
//   ASSET_GATE_CACHE   cache folder (default: ~/.cache/codepawl-asset-gate)

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { AssetIndex } from "./core/search.mjs";
import { createTools, USER_AGENT } from "./core/tools.mjs";
import { createMcpHandler } from "./core/mcp.mjs";

export const DEFAULT_INDEX_URL = "https://huggingface.co/datasets/codepawl/asset-index/resolve/main/gate/v1";

export function folderStore(folder) {
  return {
    async json(path) {
      return JSON.parse(await readFile(join(folder, path), "utf8"));
    },
    async bytes(path) {
      return new Uint8Array(await readFile(join(folder, path)));
    },
  };
}

export function remoteStore(baseUrl, cacheFolder) {
  let versionFolder = null;

  async function download(path) {
    const response = await fetch(`${baseUrl}/${path}`, { headers: { "User-Agent": USER_AGENT } });
    if (!response.ok) throw new Error(`index file ${path}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function cached(path) {
    if (path === "manifest.json") {
      const bytes = await download(path);
      const manifest = JSON.parse(new TextDecoder().decode(bytes));
      versionFolder = join(cacheFolder, `v${manifest.version}-${manifest.built_on}`);
      return bytes;
    }
    const target = join(versionFolder ?? join(cacheFolder, "unversioned"), path);
    if (existsSync(target)) return new Uint8Array(await readFile(target));
    const bytes = await download(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return bytes;
  }

  return {
    async json(path) {
      return JSON.parse(new TextDecoder().decode(await cached(path)));
    },
    bytes: cached,
  };
}

export function createLocalServer(indexLocation = process.env.ASSET_GATE_INDEX ?? DEFAULT_INDEX_URL) {
  const cacheFolder = process.env.ASSET_GATE_CACHE ?? join(homedir(), ".cache", "codepawl-asset-gate");
  const store = /^https?:\/\//.test(indexLocation) ? remoteStore(indexLocation.replace(/\/$/, ""), cacheFolder) : folderStore(indexLocation);
  const index = new AssetIndex(store);
  const tools = createTools({ index });
  return { index, tools, handle: createMcpHandler(tools) };
}

export async function main() {
  const { handle } = createLocalServer();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
      continue;
    }
    // Answer each message as soon as it is done; a slow search does not hold up a ping.
    Promise.resolve(handle(message))
      .then((response) => {
        if (response) process.stdout.write(JSON.stringify(response) + "\n");
      })
      .catch((error) => process.stderr.write(`asset-gate: ${error?.stack ?? error}\n`));
  }
}

