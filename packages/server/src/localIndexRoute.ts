import type { Request, Response, Router } from "express";
import express from "express";
import { stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { KnowledgeState, type KnowledgeDoc } from "@bb/types";
import { getPlumblineHome } from "@bb/config";
import { knowledgeDb } from "@bb/db";
import { knowledgeGraph } from "@bb/graph-db";
import { enqueueLocalIngest } from "@bb/queue";
import { copyRepo } from "./copyRepo.ts";

interface LocalIndexBody {
  sourcePath?: unknown;
}

export function buildLocalIndexRoute(): Router {
  const router = express.Router();
  router.post("/api/v1/local/index", async (req: Request, res: Response) => {
    const body = req.body as LocalIndexBody;
    if (typeof body.sourcePath !== "string" || body.sourcePath.length === 0) {
      res.status(400).json({ error: "sourcePath required" });
      return;
    }
    const sourcePath = body.sourcePath;
    if (!path.isAbsolute(sourcePath)) {
      res.status(422).json({ error: "sourcePath must be absolute" });
      return;
    }
    try {
      const s = await stat(sourcePath);
      if (!s.isDirectory()) {
        res.status(400).json({ error: "not a directory" });
        return;
      }
    } catch {
      res.status(400).json({ error: "path does not exist" });
      return;
    }

    const knowledgeId = crypto.randomUUID();
    // Staging snapshot of the user-supplied source tree. Sits in its own
    // top-level dir so it stays distinct from the kube-v2 `orgs/` tree where
    // analysed knowledges live. The worker reads from this snapshot rather
    // than the original `sourcePath` so a user moving / mutating their dir
    // after submission doesn't affect the in-flight ingestion.
    const snapshotsRoot = path.join(getPlumblineHome(), "local-snapshots");
    await mkdir(snapshotsRoot, { recursive: true, mode: 0o700 });
    const destDir = path.join(snapshotsRoot, knowledgeId);

    await copyRepo(sourcePath, destDir);

    const now = new Date();
    const doc: KnowledgeDoc = {
      knowledgeId,
      source: { kind: "local", sourcePath },
      info: {},
      status: { state: KnowledgeState.Created },
      createdAt: now,
      updatedAt: now,
    };
    await knowledgeDb.upsertKnowledge(doc);
    await knowledgeGraph.upsertKnowledgeNode(doc);
    const jobId = await enqueueLocalIngest({ knowledgeId, rootDir: destDir });
    res.status(200).json({ knowledgeId, jobId });
  });
  return router;
}
