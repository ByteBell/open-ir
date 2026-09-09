export class LayoutMigrationRequiredError extends Error {
  override readonly name = "LayoutMigrationRequiredError";
  readonly hint: string;

  constructor(detectedLegacyPath: string) {
    super(
      [
        "On-disk layout is the legacy `repos/.meta/<knowledgeId>/` shape;",
        "this build expects the commit-scoped layout under `orgs/<orgId>/<provider>/`.",
        `Detected legacy path: ${detectedLegacyPath}`,
        "Run: plumbline migrate paths",
      ].join("\n  "),
    );
    this.hint = "plumbline migrate paths";
  }
}
