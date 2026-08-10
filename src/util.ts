import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { minimatch } from "minimatch";

export function pathForGlob(path: string): string {
  return path.split(sep).join("/");
}

export function matchesPath(
  path: string,
  patterns: string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return false;
  const normalized = pathForGlob(path).replace(/^\.\//, "");
  return patterns.some((pattern) => {
    const candidate = pathForGlob(pattern).replace(/^\.\//, "");
    return (
      minimatch(normalized, candidate, { dot: true, matchBase: false }) ||
      minimatch(normalized, `${candidate.replace(/\/$/, "")}/**`, {
        dot: true,
      }) ||
      normalized === candidate.replace(/\/$/, "") ||
      normalized.startsWith(`${candidate.replace(/\/$/, "")}/`)
    );
  });
}

export function listRepositoryFiles(root: string): string[] {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return output.split(/\r?\n/).filter(Boolean);
  } catch {
    const files: string[] = [];
    const ignored = new Set([
      ".git",
      "node_modules",
      "vendor",
      "dist",
      "build",
      ".venv",
      "venv",
    ]);

    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (entry.isFile())
          files.push(pathForGlob(relative(root, absolute)));
      }
    };

    walk(root);
    return files;
  }
}

export function readJson(path: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function isFile(path: string): boolean {
  try {
    return existsSync(path) && lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
