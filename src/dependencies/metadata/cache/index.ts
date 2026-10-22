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

import * as core from "@actions/core";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CACHE_PREFIX = "license-checker-metadata-v1";
const CACHE_FILE = join(
  tmpdir(),
  "license-checker",
  "dependency-metadata.json",
);
const ALLOWED_HOSTS = new Set(["registry.npmjs.org", "pypi.org"]);
const metadata = new Map<string, unknown>();
let dependencyHash: string | undefined;
let restoredKey: string | undefined;
let enabled = false;

function cacheKey(contentHash: string): string {
  return `${CACHE_PREFIX}-${dependencyHash}-${contentHash}`;
}

function isCacheableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      ALLOWED_HOSTS.has(parsed.hostname) &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

export function getCachedMetadata(url: string): unknown {
  return isCacheableUrl(url) ? metadata.get(url) : undefined;
}

export function rememberMetadata(url: string, value: unknown): void {
  if (isCacheableUrl(url)) metadata.set(url, value);
}

export async function restoreMetadataCache(
  root: string,
  dependencyFiles: string[],
): Promise<void> {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    !process.env.ACTIONS_RUNTIME_TOKEN ||
    (!process.env.ACTIONS_CACHE_URL && !process.env.ACTIONS_RUNTIME_URL)
  )
    return;

  enabled = true;
  const hash = createHash("sha256");
  for (const path of [...dependencyFiles].sort()) {
    hash.update(path);
    hash.update("\0");
    try {
      hash.update(await readFile(join(root, path)));
    } catch {
      hash.update("<missing>");
    }
    hash.update("\0");
  }
  dependencyHash = hash.digest("hex").slice(0, 16);

  try {
    const cache = await import("@actions/cache");
    const restored = await cache.restoreCache([CACHE_FILE], cacheKey("seed"), [
      `${CACHE_PREFIX}-${dependencyHash}-`,
      `${CACHE_PREFIX}-`,
    ]);
    restoredKey = restored;
    if (!restored) return;

    const parsed: unknown = JSON.parse(await readFile(CACHE_FILE, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return;
    for (const [url, value] of Object.entries(parsed))
      rememberMetadata(url, value);
    core.info(
      `Restored ${metadata.size} dependency metadata entries from cache.`,
    );
  } catch (error) {
    core.warning(
      `Could not restore dependency metadata cache: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function saveMetadataCache(): Promise<void> {
  if (!enabled || !dependencyHash || metadata.size === 0) return;
  try {
    const cache = await import("@actions/cache");
    await mkdir(join(tmpdir(), "license-checker"), { recursive: true });
    const serialized = JSON.stringify(Object.fromEntries(metadata), null, 2);
    await writeFile(CACHE_FILE, serialized);
    const contentHash = createHash("sha256")
      .update(serialized)
      .digest("hex")
      .slice(0, 16);
    const key = cacheKey(contentHash);
    if (key === restoredKey) return;
    await cache.saveCache([CACHE_FILE], key);
    core.info(`Saved ${metadata.size} dependency metadata entries to cache.`);
  } catch (error) {
    core.warning(
      `Could not save dependency metadata cache: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
