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

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface LicenseConfig {
  "spdx-id"?: string;
  "copyright-owner"?: string;
  "copyright-year"?: string | number;
  "software-name"?: string;
  content?: string;
  pattern?: string;
}

export interface HeaderRule {
  path?: string;
  license: LicenseConfig;
  paths?: string[];
  "paths-ignore"?: string[];
  comment?: "always" | "never" | "on-failure";
  "license-location-threshold"?: number;
  language?: Record<string, unknown>;
}

export interface DependencyLicenseOverride {
  name: string;
  version?: string;
  license: string;
}

export interface DependencyExclude {
  name: string;
  version?: string;
  recursive?: boolean;
}

export interface DependencyException {
  name: string;
  version: string;
  url: string;
  reason: string;
}

export interface DependencyConfig {
  files?: string[];
  licenses?: DependencyLicenseOverride[];
  threshold?: number;
  excludes?: DependencyExclude[];
  exceptions?: DependencyException[];
  require_fsf_free?: boolean;
  require_osi_approved?: boolean;
}

export interface LicenseEyeConfig {
  header?: HeaderRule | HeaderRule[];
  dependency?: DependencyConfig;
}

export type Ecosystem = "npm" | "go" | "python";

export interface Dependency {
  name: string;
  version: string;
  ecosystem: Ecosystem;
  manifest: string;
  rawLicense?: string;
  source?: string;
}

export interface DependencyResult extends Dependency {
  license: string;
  normalized: string;
  resolution:
    | "configured"
    | "exception"
    | "manifest"
    | "registry"
    | "repository"
    | "unknown";
  compatible:
    | "approved-exception"
    | "compatible"
    | "weak-compatible"
    | "incompatible"
    | "unknown";
  approval?: Pick<DependencyException, "url" | "reason">;
  reason?: string;
  distributionWarning?: string;
}

export interface DependencyReport {
  checked: number;
  results: DependencyResult[];
  failures: DependencyResult[];
}

export interface CheckReport {
  dependency: DependencyReport;
  failed: boolean;
}
