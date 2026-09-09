import { Command } from "commander";
import { getJson } from "./httpClient.ts";
import { info, table, error } from "./output.ts";
import { runMcpInstall } from "./mcpInstall.ts";

interface McpStats {
  global: {
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
  };
  monthly: Array<{
    identityId: string;
    year: number;
    month: number;
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    tokensUsed: number;
  }>;
}

export function buildMcpCommand(): Command {
  const mcp = new Command("mcp").description("Manage and view MCP usage");

  mcp
    .command("install")
    .description("Detect installed coding tools and register the plumbline MCP endpoint in their config.")
    .action(async () => {
      await runMcpInstall();
    });

  mcp
    .command("stats")
    .description("Show input/output token stats for MCP")
    .action(async () => {
      try {
        const stats = await getJson<McpStats>("/api/v1/mcp/stats");

        info("--- Global MCP Usage ---");
        table(
          ["Metric", "Value"],
          [
            ["Total Requests", stats.global.totalRequests.toLocaleString()],
            ["Input Tokens", stats.global.totalInputTokens.toLocaleString()],
            ["Output Tokens", stats.global.totalOutputTokens.toLocaleString()],
            ["Total Tokens", stats.global.totalTokens.toLocaleString()],
          ],
        );

        if (stats.monthly.length > 0) {
          info("\n--- Monthly Usage by Identity ---");
          const monthlyRows = stats.monthly.map((m) => [
            m.identityId,
            `${m.year}-${m.month.toString().padStart(2, "0")}`,
            m.requestCount.toLocaleString(),
            m.inputTokens.toLocaleString(),
            m.outputTokens.toLocaleString(),
            m.tokensUsed.toLocaleString(),
          ]);

          table(["Identity", "Period", "Reqs", "In Tokens", "Out Tokens", "Total"], monthlyRows);
        } else {
          info("\nNo monthly usage records found.");
        }
      } catch (err) {
        error(`Failed to fetch MCP stats: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  return mcp;
}
