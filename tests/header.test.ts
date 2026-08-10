import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkHeaders } from '../src/header.js';
import { Logger } from '../src/logger.js';
import type { LicenseEyeConfig } from '../src/types.js';

describe('header checker', () => {
  it('checks JavaScript, Go, and Python comment headers and ignores configured paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'license-checker-header-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.github'), { recursive: true });
    const header = `/*\n * Copyright 2024 Zaphiro Technologies\n * SPDX-License-Identifier: Apache-2.0\n */\n`;
    writeFileSync(join(root, 'src/good.js'), `${header}\nexport const answer = 42;\n`);
    writeFileSync(join(root, 'src/bad.py'), 'print("missing header")\n');
    writeFileSync(join(root, '.github/workflow.js'), 'print("ignored")\n');

    const config: LicenseEyeConfig = {
      header: {
        license: { 'spdx-id': 'Apache-2.0', 'copyright-year': 2024, 'copyright-owner': 'Zaphiro Technologies' },
        'paths-ignore': ['.github'],
      },
    };
    const report = checkHeaders(root, config, new Logger('error'));
    expect(report.checked).toBe(2);
    expect(report.ignored).toBe(1);
    expect(report.failures.map((failure) => failure.file)).toEqual(['src/bad.py']);
  });
});
