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
import type { LogLevel } from "./types.js";

const priorities: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export class Logger {
  readonly level: LogLevel;

  constructor(level: string | undefined) {
    const normalized = (level ?? "info").toLowerCase() as LogLevel;
    this.level = normalized in priorities ? normalized : "info";
  }

  private enabled(level: LogLevel): boolean {
    return priorities[level] <= priorities[this.level];
  }

  error(message: string): void {
    if (this.enabled("error")) core.error(message);
  }

  warn(message: string): void {
    if (this.enabled("warn")) core.warning(message);
  }

  info(message: string): void {
    if (this.enabled("info")) core.info(message);
  }

  debug(message: string): void {
    if (!this.enabled("debug")) return;
    if (process.env.ACTIONS_STEP_DEBUG === "true") core.debug(message);
    else core.info(`[debug] ${message}`);
  }
}
