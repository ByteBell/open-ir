import type { Config } from "@bb/types";

export class ConfigIncompleteError extends Error {
  override readonly name = "ConfigIncompleteError";
  readonly missing: readonly Config[];
  readonly hints: readonly string[];

  constructor(missing: readonly Config[], hints: readonly string[]) {
    super(`Plumbline config is missing required fields: ${missing.join(", ")}.\n` + `Run:\n  ${hints.join("\n  ")}`);
    this.missing = missing;
    this.hints = hints;
  }
}
