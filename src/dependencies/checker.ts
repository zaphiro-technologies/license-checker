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

import type {
  Dependency,
  DependencyConfig,
  DependencyResult,
  Ecosystem,
  LicenseRule,
} from "../types.js";
import type { Logger } from "../logger.js";

export type GoPackageListRunner = (
  moduleDirectory: string,
  packages: string[],
  includeTests: boolean,
) => string;

export interface DependencyCheckContext {
  root: string;
  path: string;
  absolutePath: string;
  dependencyConfig: DependencyConfig;
  goPackageList: GoPackageListRunner;
}

export interface LicenseEvidence {
  license?: string;
  source?: string;
  matchText?: string;
  version?: string;
  resolution: Exclude<
    DependencyResult["resolution"],
    "configured" | "exception"
  >;
}

export interface LicenseResolutionContext {
  root: string;
  token?: string;
  logger: Logger;
  includeMatchText: boolean;
  licenseRules?: LicenseRule[];
}

export abstract class DependencyChecker {
  abstract readonly ecosystem: Ecosystem;
  abstract supports(manifestName: string): boolean;
  abstract collect(context: DependencyCheckContext): Dependency[];
  abstract resolveLicense(
    dependency: Dependency,
    context: LicenseResolutionContext,
  ): Promise<LicenseEvidence>;
}
