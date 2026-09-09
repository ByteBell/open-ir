import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const SKILLS_INDEX_URI = "plumbline://skills/index";
const SKILL_FILE_URI_TEMPLATE = "plumbline://skills/{skillName}/{filename}";

interface SkillFile {
  filename: string;
  bytes: number;
}

interface SkillEntry {
  name: string;
  description: string;
  install_path: string;
  files: SkillFile[];
}

interface SkillsIndex {
  skills: SkillEntry[];
  source_root: string;
  generated_at: string;
}

export function registerSkillResources(server: McpServer): void {
  const skillsRoot = locateSkillsRoot();
  if (skillsRoot === null) {
    process.stderr.write(`[mcp/resources] No bundled skills directory found; skill resources disabled.\n`);
    return;
  }

  server.registerResource(
    "plumbline-skills-index",
    SKILLS_INDEX_URI,
    {
      title: "Plumbline Skills Index",
      description:
        "Lists every skill bundled with this server. Each entry includes name, description, target install path, and constituent files. Fetch each file via plumbline://skills/{name}/{filename} and write it to {install_path}/{filename}.",
      mimeType: "application/json",
    },
    async (uri) => {
      const index = await readSkillsIndex(skillsRoot);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(index, null, 2) }],
      };
    },
  );

  const template = new ResourceTemplate(SKILL_FILE_URI_TEMPLATE, {
    list: async () => {
      const index = await readSkillsIndex(skillsRoot);
      const resources = [];
      for (const skill of index.skills) {
        for (const file of skill.files) {
          resources.push({
            uri: `plumbline://skills/${skill.name}/${file.filename}`,
            name: `${skill.name}/${file.filename}`,
            mimeType: "text/markdown",
            description: `${skill.name} skill — ${file.filename} (${file.bytes} bytes)`,
          });
        }
      }
      return { resources };
    },
  });

  server.registerResource(
    "plumbline-skill-file",
    template,
    {
      title: "Plumbline Skill File",
      description:
        "Markdown content for a single bundled skill file. URI pattern: plumbline://skills/{skillName}/{filename}. Write to ~/.claude/skills/{skillName}/{filename} during bootstrap.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const skillName = String(variables["skillName"] ?? "");
      const filename = String(variables["filename"] ?? "");
      const filePath = resolveSkillFilePath(skillsRoot, skillName, filename);
      if (filePath === null) {
        throw new Error(`Invalid skill resource path: ${skillName}/${filename}`);
      }
      const content = await fs.readFile(filePath, "utf8");
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: content }] };
    },
  );
}

function locateSkillsRoot(): string | null {
  const here = fileURLToPath(import.meta.url);
  const packageRoot = path.resolve(path.dirname(here), "..");
  const candidate = path.resolve(packageRoot, "skills");
  return existsSync(candidate) ? candidate : null;
}

async function readSkillsIndex(skillsRoot: string): Promise<SkillsIndex> {
  const skills: SkillEntry[] = [];
  const entries = await fs.readdir(skillsRoot).catch(() => null);
  if (entries === null) {
    return { skills, source_root: skillsRoot, generated_at: new Date().toISOString() };
  }

  for (const entry of entries) {
    const skillDir = path.join(skillsRoot, entry);
    const stat = await fs.stat(skillDir).catch(() => null);
    if (stat === null || !stat.isDirectory()) {
      continue;
    }

    const skillMdPath = path.join(skillDir, "SKILL.md");
    const skillMdStat = await fs.stat(skillMdPath).catch(() => null);
    if (skillMdStat === null) {
      continue;
    }

    const description = await readSkillDescription(skillMdPath);
    const dirEntries = await fs.readdir(skillDir).catch(() => [] as string[]);
    const files: SkillFile[] = [];
    for (const filename of dirEntries) {
      if (!filename.endsWith(".md")) {
        continue;
      }
      const fileStat = await fs.stat(path.join(skillDir, filename)).catch(() => null);
      if (fileStat === null) {
        continue;
      }
      files.push({ filename, bytes: fileStat.size });
    }
    files.sort((a, b) => {
      if (a.filename === "SKILL.md") {
        return -1;
      }
      if (b.filename === "SKILL.md") {
        return 1;
      }
      return a.filename.localeCompare(b.filename);
    });
    skills.push({ name: entry, description, install_path: `~/.claude/skills/${entry}`, files });
  }

  return { skills, source_root: skillsRoot, generated_at: new Date().toISOString() };
}

async function readSkillDescription(skillMdPath: string): Promise<string> {
  const content = await fs.readFile(skillMdPath, "utf8").catch(() => "");
  if (!content.startsWith("---")) {
    return "";
  }
  const end = content.indexOf("\n---", 3);
  if (end < 0) {
    return "";
  }
  const frontmatter = content.slice(3, end);
  const lines = frontmatter.split("\n");
  let description = "";
  let collectingFolded = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/u, "");
    if (collectingFolded) {
      if (/^\s/u.test(line) && line.trim().length > 0) {
        description += (description.length > 0 ? " " : "") + line.trim();
        continue;
      }
      collectingFolded = false;
    }
    const match = line.match(/^description:\s*(.*)$/u);
    if (match !== null) {
      const after = (match[1] ?? "").trim();
      if (after === ">" || after === "|") {
        collectingFolded = true;
      } else {
        description = after.replace(/^["']|["']$/gu, "");
      }
    }
  }
  return description;
}

function resolveSkillFilePath(skillsRoot: string, skillName: string, filename: string): string | null {
  if (skillName.length === 0 || filename.length === 0) {
    return null;
  }
  if (skillName.includes("/") || skillName.includes("\\") || skillName.startsWith(".")) {
    return null;
  }
  if (filename.includes("/") || filename.includes("\\") || filename.startsWith(".")) {
    return null;
  }
  if (!filename.endsWith(".md")) {
    return null;
  }
  const target = path.resolve(skillsRoot, skillName, filename);
  const root = path.resolve(skillsRoot);
  if (!target.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  return target;
}
