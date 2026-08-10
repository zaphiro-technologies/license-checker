import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDependencies } from '../src/dependencies.js';
import { Logger } from '../src/logger.js';
import type { LicenseEyeConfig } from '../src/types.js';

describe('dependency checker', () => {
  it('uses configured license overrides before remote resolution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'license-checker-deps-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'go.mod'), `module example.com/app\n\nrequire (\n  github.com/zaphiro-technologies/roger v1.2.3\n)\n`);
    const config: LicenseEyeConfig = {
      header: { license: { 'spdx-id': 'Apache-2.0' } },
      dependency: {
        files: ['go.mod'],
        licenses: [{ name: 'github.com/zaphiro-technologies/roger', license: 'Apache-2.0' }],
      },
    };
    const report = await checkDependencies(root, config, undefined, false, new Logger('error'));
    expect(report.checked).toBe(1);
    expect(report.failures).toHaveLength(0);
    expect(report.results[0]?.resolution).toBe('configured');
  });
});
