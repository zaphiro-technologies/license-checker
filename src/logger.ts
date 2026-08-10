import * as core from '@actions/core';
import type { LogLevel } from './types.js';

const priorities: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export class Logger {
  readonly level: LogLevel;

  constructor(level: string | undefined) {
    const normalized = (level ?? 'info').toLowerCase() as LogLevel;
    this.level = normalized in priorities ? normalized : 'info';
  }

  private enabled(level: LogLevel): boolean {
    return priorities[level] <= priorities[this.level];
  }

  error(message: string): void {
    if (this.enabled('error')) core.error(message);
  }

  warn(message: string): void {
    if (this.enabled('warn')) core.warning(message);
  }

  info(message: string): void {
    if (this.enabled('info')) core.info(message);
  }

  debug(message: string): void {
    if (this.enabled('debug')) core.debug(message);
  }
}
