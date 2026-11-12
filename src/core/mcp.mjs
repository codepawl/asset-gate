// A tools-only MCP server as one function: JSON-RPC message in, response out (null for notifications).
// Both transports use it: stdio (src/stdio.mjs) and Streamable HTTP without sessions (src/worker.mjs).

import { VERSION } from "./tools.mjs";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS =
  "Free 3D assets for building scenes. search_assets finds models, materials and HDRIs (sizes in metres where known); " +
  "get_asset gives the file URL and a credit line to keep with the asset; list_sources shows the libraries and licences; " +
  "find_elsewhere links other free libraries when nothing fits; on the hosted gate, generate_asset then queues an AI-generated model (poll get_generation). Keep every non-CC0 credit line in the project's credits.";

function result(id, value) {
  return { jsonrpc: "2.0", id, result: value };
}

function failure(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export function createMcpHandler(tools, { serverName = "codepawl-asset-gate", onToolCall = null } = {}) {
  return async function handle(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return failure(message?.id, -32600, "Invalid request");
    }
    const isNotification = message.id === undefined || message.id === null;
    if (isNotification) return null;
    const params = message.params ?? {};

    switch (message.method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const protocolVersion = SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0];
        return result(message.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: serverName, title: "CodePawl free 3D assets", version: VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return result(message.id, {});
      case "tools/list":
        return result(message.id, { tools: tools.definitions });
      case "tools/call": {
        const name = params.name;
        if (!tools.definitions.some((tool) => tool.name === name)) return failure(message.id, -32602, `Unknown tool: ${name}`);
        const started = Date.now();
        try {
          const output = await tools.call(name, params.arguments ?? {});
          onToolCall?.({ name, arguments: params.arguments ?? {}, milliseconds: Date.now() - started, ok: !output?.error, count: output?.count ?? null });
          return result(message.id, {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
            isError: Boolean(output?.error),
          });
        } catch (error) {
          onToolCall?.({ name, arguments: params.arguments ?? {}, milliseconds: Date.now() - started, ok: false });
          return result(message.id, { content: [{ type: "text", text: String(error?.message ?? error) }], isError: true });
        }
      }
      case "resources/list":
        return result(message.id, { resources: [] });
      case "prompts/list":
        return result(message.id, { prompts: [] });
      default:
        return failure(message.id, -32601, `Method not found: ${message.method}`);
    }
  };
}
