import { getConfigValue } from "@bb/config";
import { Config, type BusinessContextProcessingPayload, type JobMessage, JobType } from "@bb/types";
import { logger } from "@bb/logger";
import type { JobHandler } from "@bb/queue";
import { executeBusinessContextStrategy } from "#src/strategy/execute.ts";
import { storeBusinessContextToNeo4j } from "#src/strategy/store-graph.ts";
import type { BusinessContextAnalysis, BusinessContextLlmOptions } from "#src/types.ts";
import { readFile } from "node:fs/promises";

const DEFAULT_ORG_ID = "local";

function buildLlmOptions(payload: BusinessContextProcessingPayload): BusinessContextLlmOptions {
  const opts: BusinessContextLlmOptions = {};
  if (payload.llmApiKey !== undefined) {
    opts.apiKey = payload.llmApiKey;
  }
  if (payload.llmProvider !== undefined) {
    opts.provider = payload.llmProvider;
  }
  if (payload.llmModel !== undefined) {
    opts.model = payload.llmModel;
  }
  return opts;
}

function resolveOrgId(payload: BusinessContextProcessingPayload): string {
  if (payload.orgId !== undefined && payload.orgId.length > 0) {
    return payload.orgId;
  }
  const configured = getConfigValue(Config.OrgId);
  return configured.length > 0 ? configured : DEFAULT_ORG_ID;
}

/**
 * Queue job handler for `JobType.BusinessContextProcessing`. Runs the disk
 * strategy then the graph store. Re-reads the persisted analysis from disk
 * before the graph step so a deferred / split execution path produces the same
 * result as the inline path.
 */
export const handleBusinessContextProcessing: JobHandler<JobType.BusinessContextProcessing> = async (
  msg: JobMessage<BusinessContextProcessingPayload>,
): Promise<void> => {
  const { payload } = msg;
  const orgId = resolveOrgId(payload);
  const input = {
    text: payload.customText,
    knowledgeId: payload.knowledgeId,
    commitHash: payload.commitHash,
    orgId,
    ...(payload.description !== undefined ? { description: payload.description } : {}),
  };

  logger.info(
    `business-context.handler: starting job=${msg.id} knowledge=${input.knowledgeId} commit=${input.commitHash.substring(0, 12)}`,
  );

  const storage = await executeBusinessContextStrategy(input, { llmOptions: buildLlmOptions(payload) });

  // Re-load the persisted analysis to feed the graph step. Keeps the contract
  // identical whether the graph step runs inline or is deferred to a follow-up
  // job: in both cases the source of truth is what's on disk.
  const envelope = JSON.parse(await readFile(storage.analysisPath, "utf-8")) as {
    analysis: BusinessContextAnalysis;
  };

  await storeBusinessContextToNeo4j(
    { knowledgeId: input.knowledgeId, orgId, commitHash: input.commitHash },
    envelope.analysis,
    storage.sanitizedTitle,
  );

  logger.info(`business-context.handler: completed job=${msg.id}`);
};
