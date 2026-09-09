// SPDX-License-Identifier: AGPL-3.0-only WITH non-commercial-clause

/**
 * Raised when a repository operation targets a `knowledgeId` that has no
 * document in the active store. Provider-agnostic: thrown by every
 * `IDocumentDatabaseProvider` implementation, not by one driver.
 */
export class KnowledgeNotFoundError extends Error {
  override readonly name = "KnowledgeNotFoundError";
  readonly knowledgeId: string;

  constructor(knowledgeId: string) {
    super(`No knowledge document found with knowledgeId="${knowledgeId}".`);
    this.knowledgeId = knowledgeId;
  }
}
