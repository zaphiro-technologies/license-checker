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

import { readFileSync } from "node:fs";
import type { Dependency } from "../../../types.js";
import { pythonVersionIsExact } from "./version.js";

export function parseRequirements(
  manifest: string,
  path: string,
  dependencies: Dependency[],
): void {
  const parseRequirement = (
    value: string,
  ):
    { name: string; version: string; versionResolved: boolean } | undefined => {
    const nameMatch = /^[A-Za-z0-9][A-Za-z0-9_.-]*/.exec(value);
    if (!nameMatch) return undefined;
    const name = nameMatch[0];
    let remainder = value.slice(name.length).trimStart();
    if (remainder.startsWith("[")) {
      const extrasEnd = remainder.indexOf("]");
      if (extrasEnd < 0) return undefined;
      remainder = remainder.slice(extrasEnd + 1).trimStart();
    }
    const operator = /^(===|==|~=|>=|<=|>|<)/.exec(remainder)?.[0];
    if (!operator) return { name, version: "*", versionResolved: false };
    remainder = remainder.slice(operator.length).trimStart();
    const semicolon = remainder.indexOf(";");
    const whitespace = remainder.search(/\s/);
    const end = [semicolon, whitespace]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];
    const version = remainder.slice(0, end ?? remainder.length) || "*";
    const versionResolved =
      (operator === "==" || operator === "===") &&
      pythonVersionIsExact(version);
    return {
      name,
      version,
      versionResolved,
    };
  };

  for (const [lineIndex, rawLine] of readFileSync(path, "utf8")
    .split(/\r?\n/)
    .entries()) {
    const commentStart = rawLine.indexOf("#");
    const line = (
      commentStart < 0 ? rawLine : rawLine.slice(0, commentStart)
    ).trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("-")) {
      dependencies.push({
        name: `(requirements input line ${lineIndex + 1})`,
        version: "unresolved",
        ecosystem: "python",
        manifest,
        versionResolved: false,
        versionResolutionError:
          "Requirements includes, constraints, and options must be expanded before license checking.",
      });
      continue;
    }
    const requirement = parseRequirement(line);
    if (!requirement) {
      dependencies.push({
        name: `(requirements input line ${lineIndex + 1})`,
        version: "unresolved",
        ecosystem: "python",
        manifest,
        versionResolved: false,
        versionResolutionError:
          "The requirements line could not be parsed as a pinned package.",
      });
      continue;
    }
    dependencies.push({
      ...requirement,
      ecosystem: "python",
      manifest,
      versionResolutionError: requirement.versionResolved
        ? undefined
        : "Python requirements must pin an exact version with == or ===.",
    });
  }
}
