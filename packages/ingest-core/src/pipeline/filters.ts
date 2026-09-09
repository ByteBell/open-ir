import { SEED_DIRECTORIES, SEED_EXTENSIONS, SEED_FILENAMES } from "./skip-decisions/seed.ts";

const LEGACY_SKIP_DIRS = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".plumbline",
];

const LEGACY_SKIP_FILES = [
  ".DS_Store",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "Pipfile.lock",
  "poetry.lock",
];

const LEGACY_BINARY_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".bmp",
  ".tiff",
  ".svg",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".mp3",
  ".wav",
  ".flac",
  ".ogg",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".eot",
  ".class",
  ".jar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".wasm",
  ".bin",
];

export const SKIP_DIRS: ReadonlySet<string> = new Set([...SEED_DIRECTORIES, ...LEGACY_SKIP_DIRS]);
export const SKIP_FILES: ReadonlySet<string> = new Set([...SEED_FILENAMES, ...LEGACY_SKIP_FILES]);
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([...SEED_EXTENSIONS, ...LEGACY_BINARY_EXTENSIONS]);

export function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Reject a file by filename or extension. `sets`, when supplied, overlays
 * per-job ignore overrides onto the defaults; omitting it falls back to the
 * built-in `SKIP_FILES` / `BINARY_EXTENSIONS` unions (behavior unchanged).
 */
export function passesPathFilters(
  name: string,
  ext: string,
  sets?: { filenames: ReadonlySet<string>; extensions: ReadonlySet<string> },
): boolean {
  const filenames = sets?.filenames ?? SKIP_FILES;
  const extensions = sets?.extensions ?? BINARY_EXTENSIONS;
  if (filenames.has(name)) {
    return false;
  }
  if (extensions.has(ext.toLowerCase())) {
    return false;
  }
  return true;
}
