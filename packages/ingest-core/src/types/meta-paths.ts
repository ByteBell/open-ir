/**
 * Per-commit meta artifact paths. Built by `pathsFor(loc)`, where
 * `repositoryDir` and `metaOutputRoot` are siblings under
 * `~/.plumbline/orgs/<orgId>/<provider>/<knowledgeId>/<owner>/<repo>/<commit>/`,
 * and every leaf path (file-analysis, folder-summaries, etc.) lives under
 * `metaOutputRoot`.
 *
 * `metaRoot` is preserved as a back-compat alias for `metaOutputRoot` — every
 * legacy caller that reads `paths.metaRoot/...` still resolves correctly.
 * New code should reach for `metaOutputRoot` (or the named leaf paths).
 */
export interface MetaPaths {
  /** Cloned source tree for the commit. */
  repositoryDir: string;
  /** Parent of every meta artifact for this commit. */
  metaOutputRoot: string;
  /** Deprecated alias for `metaOutputRoot`. Kept so legacy callers keep resolving. */
  metaRoot: string;
  fileAnalysisDir: string;
  folderSummariesDir: string;
  bigFileAnalysisDir: string;
  bigFileChunksDir: string;
  bigFilesJson: string;
  scanManifestJson: string;
  repoSummaryJson: string;
}
