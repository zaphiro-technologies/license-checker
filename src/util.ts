/*
 * Copyright 2026 Zaphiro Technologies
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { sep } from "node:path";
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

export function readJson(path: string): unknown {
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
