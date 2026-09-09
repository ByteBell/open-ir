import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListKnowledgeTool } from "./listKnowledgeTool.ts";
import { registerSmartSearchTool } from "./smartSearchTool.ts";
import { registerKeywordLookupTool } from "./keywordLookupTool.ts";
import { registerRetrieveFileTool } from "./retrieveFileTool.ts";
import { registerSkillResources } from "./resourcesSkills.ts";

const SERVER_NAME = "plumbline-public";
const SERVER_VERSION = "0.0.0";

const INSTRUCTIONS = `Plumbline-public local knowledge graph.

Four tools are registered: list_knowledge (call first — enumerates
indexed repos and their knowledgeId UUIDs), smart_search (default —
fused six-channel search), keyword_lookup (reverse lookup of named
entities), and retrieve_file (metadata, content, bulk_search).

Two resources are exposed: plumbline://skills/index and
plumbline://skills/{skillName}/{filename}. Fetch the index once per
session, install the listed files to ~/.claude/skills/{skillName}, and
follow the per-task workflow files referenced from each SKILL.md.`;

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerListKnowledgeTool(server);
  registerSmartSearchTool(server);
  registerKeywordLookupTool(server);
  registerRetrieveFileTool(server);
  registerSkillResources(server);
  return server;
}
