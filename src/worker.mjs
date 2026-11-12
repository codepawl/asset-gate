// Cloudflare Worker: the hosted gate.
//   POST /mcp                         MCP over Streamable HTTP (stateless, JSON responses)
//   GET  /f/<id>/<tier>.glb           302 to the file on Hugging Face (never proxied)
//   GET  /polyhaven/<id>/<res>.gltf   Poly Haven glTF with absolute file URLs, so it loads from one URL
//   GET  /api/search?q=..., /api/asset/<id>, /api/sources   the same tools as plain JSON
// The index files are static assets under /index/v1/ in the same deploy.

import { AssetIndex } from "./core/search.mjs";
import { createTools, USER_AGENT } from "./core/tools.mjs";
import { createMcpHandler } from "./core/mcp.mjs";
// Bundled with the code, so a fresh isolate does not fetch them before its first search.
import bundledManifest from "../dist/site/index/v1/manifest.json";
import bundledFacets from "../dist/site/index/v1/facets.bin";

const INDEX_PREFIX = "/index/v1/";
const CACHE_LIMIT = 400;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
};

// Parsed index files live for the isolate's lifetime, so a warm isolate opens each file once.
const parsedFiles = new Map();
let assetIndex = null;

function assetStore(env, origin) {
  async function read(path) {
    const response = await env.ASSETS.fetch(new Request(`${origin}${INDEX_PREFIX}${path}`));
    if (!response.ok) throw new Error(`index file ${path}: HTTP ${response.status}`);
    return response;
  }
  function remember(path, promise) {
    if (parsedFiles.size >= CACHE_LIMIT) parsedFiles.delete(parsedFiles.keys().next().value);
    parsedFiles.set(path, promise);
    promise.catch(() => parsedFiles.delete(path));
    return promise;
  }
  return {
    json(path) {
      if (path === "manifest.json") return Promise.resolve(bundledManifest);
      return parsedFiles.get(path) ?? remember(path, read(path).then((response) => response.json()));
    },
    bytes(path) {
      if (path === "facets.bin") return Promise.resolve(new Uint8Array(bundledFacets));
      return parsedFiles.get(path) ?? remember(path, read(path).then(async (response) => new Uint8Array(await response.arrayBuffer())));
    },
  };
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value, null, 1), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS, ...extraHeaders },
  });
}

function logToolCall(call) {
  console.log(JSON.stringify({ event: "tool_call", tool: call.name, ok: call.ok, ms: call.milliseconds, query: call.arguments.query ?? call.arguments.id ?? null }));
}

async function handleMcp(request, handle) {
  if (request.method === "GET") return new Response("This server answers POST only (stateless Streamable HTTP).", { status: 405, headers: { Allow: "POST", ...CORS_HEADERS } });
  if (request.method === "DELETE") return new Response(null, { status: 405, headers: CORS_HEADERS });
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map(handle))).filter(Boolean);
    return responses.length ? json(responses) : new Response(null, { status: 202, headers: CORS_HEADERS });
  }
  const response = await handle(body);
  return response ? json(response) : new Response(null, { status: 202, headers: CORS_HEADERS });
}

async function redirectToFile(index, id, tier) {
  const record = await index.documentById(id);
  if (!record?.tiers?.[tier]) return json({ error: `no ${tier} file for ${id}` }, 404);
  const manifest = await index.manifest();
  const path = record.tiers[tier].split("/").map(encodeURIComponent).join("/");
  return new Response(null, {
    status: 302,
    headers: { Location: `${manifest.pack_base}/${record.pack}/resolve/main/${path}`, "Cache-Control": "public, max-age=86400", ...CORS_HEADERS },
  });
}

async function polyHavenGltf(assetId, resolution, context) {
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.internal/polyhaven/${assetId}/${resolution}.gltf`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const filesResponse = await fetch(`https://api.polyhaven.com/files/${encodeURIComponent(assetId)}`, { headers: { "User-Agent": USER_AGENT } });
  if (!filesResponse.ok) return json({ error: `Poly Haven API answered ${filesResponse.status}` }, 502);
  const files = await filesResponse.json();
  const level = files.gltf?.[resolution] ?? files.gltf?.["1k"];
  if (!level) return json({ error: `${assetId} has no glTF` }, 404);
  const gltfResponse = await fetch(level.gltf.url, { headers: { "User-Agent": USER_AGENT } });
  if (!gltfResponse.ok) return json({ error: `Poly Haven file answered ${gltfResponse.status}` }, 502);
  const gltf = await gltfResponse.json();
  const includes = level.gltf.include ?? {};
  const absolute = (uri) => includes[uri]?.url ?? new URL(uri, level.gltf.url).href;
  for (const buffer of gltf.buffers ?? []) if (buffer.uri && !buffer.uri.startsWith("data:")) buffer.uri = absolute(buffer.uri);
  for (const image of gltf.images ?? []) if (image.uri && !image.uri.startsWith("data:")) image.uri = absolute(image.uri);
  gltf.asset = { ...gltf.asset, copyright: `${assetId} by Poly Haven (polyhaven.com), CC0. Powered by Poly Haven.` };
  const response = new Response(JSON.stringify(gltf), {
    headers: { "Content-Type": "model/gltf+json", "Cache-Control": "public, max-age=86400", ...CORS_HEADERS },
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function handleApi(url, tools) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[1] === "search") {
    const parameters = Object.fromEntries(url.searchParams);
    const input = { query: parameters.q ?? parameters.query ?? "" };
    for (const [key, value] of Object.entries(parameters)) {
      if (key === "q" || key === "query") continue;
      if (value === "true" || value === "false") input[key] = value === "true";
      else if (/^\d+(\.\d+)?$/.test(value)) input[key] = Number(value);
      else if (key === "sources") input[key] = value.split(",");
      else input[key] = value;
    }
    return json(await tools.call("search_assets", input));
  }
  if (parts[1] === "asset" && parts[2]) {
    return json(await tools.call("get_asset", { id: decodeURIComponent(parts.slice(2).join("/")), tier: url.searchParams.get("tier") ?? undefined, resolution: url.searchParams.get("resolution") ?? undefined }));
  }
  if (parts[1] === "sources") return json(await tools.call("list_sources", {}));
  if (parts[1] === "elsewhere") return json(await tools.call("find_elsewhere", { query: url.searchParams.get("q") ?? "", kind: url.searchParams.get("kind") ?? undefined }));
  return json({ error: "unknown endpoint", endpoints: ["/api/search?q=", "/api/asset/<id>", "/api/sources", "/api/elsewhere?q="] }, 404);
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    assetIndex ??= new AssetIndex(assetStore(env, url.origin));
    // Behind the custom domain requests arrive over https; wrangler dev reports the route host over http.
    const isLocal = ["localhost", "127.0.0.1"].includes(url.hostname);
    const gateBase = isLocal ? url.origin : `https://${url.host}`;
    const tools = createTools({ index: assetIndex, gateBase });
    const handle = createMcpHandler(tools, { onToolCall: logToolCall });

    try {
      if (url.pathname === "/mcp" || url.pathname === "/mcp/") return await handleMcp(request, handle);
      const fileMatch = /^\/f\/([^/]+)\/(.+)\/([a-z0-9]+)\.glb$/.exec(url.pathname);
      if (fileMatch) return await redirectToFile(assetIndex, `${decodeURIComponent(fileMatch[1])}:${decodeURIComponent(fileMatch[2])}`, fileMatch[3]);
      const gltfMatch = /^\/polyhaven\/([A-Za-z0-9_-]+)\/(1k|2k|4k|8k)\.gltf$/.exec(url.pathname);
      if (gltfMatch) return await polyHavenGltf(gltfMatch[1], gltfMatch[2], context);
      if (url.pathname.startsWith("/api/")) return await handleApi(url, tools);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ event: "error", path: url.pathname, message: String(error?.message ?? error) }));
      return json({ error: String(error?.message ?? error) }, 500);
    }
  },
};
