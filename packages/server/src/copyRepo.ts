import { cp } from "node:fs/promises";
import path from "node:path";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".plumbline",
]);

const SKIP_FILES = new Set([
  ".DS_Store",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "Pipfile.lock",
  "poetry.lock",
]);

export async function copyRepo(sourcePath: string, destDir: string): Promise<void> {
  await cp(sourcePath, destDir, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
    force: true,
    filter: (src: string) => {
      const base = path.basename(src);
      if (SKIP_DIRS.has(base)) {
        return false;
      }
      if (SKIP_FILES.has(base)) {
        return false;
      }
      return true;
    },
  });
}
