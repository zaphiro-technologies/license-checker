import { describe, expect, it } from 'vitest';
import { checkCompatibility, normalizeLicenseExpression, normalizeLicenseId } from '../src/spdx.js';

describe('SPDX normalization', () => {
  it('normalizes common package-manager license names', () => {
    expect(normalizeLicenseId('MIT License')).toBe('MIT');
    expect(normalizeLicenseId('Apache License 2.0')).toBe('Apache-2.0');
    expect(normalizeLicenseExpression('MIT OR Apache-2.0')).toBe('(MIT OR Apache-2.0)');
    expect(normalizeLicenseExpression('GPL-2.0-only WITH Classpath-exception-2.0')).toBe('GPL-2.0-only WITH Classpath-exception-2.0');
  });

  it('evaluates expressions using License Eye compatibility categories', () => {
    expect(checkCompatibility('Apache-2.0', 'MIT', false)).toBe('compatible');
    expect(checkCompatibility('Apache-2.0', 'MPL-2.0', false)).toBe('unknown');
    expect(checkCompatibility('Apache-2.0', 'MPL-2.0', true)).toBe('weak-compatible');
    expect(checkCompatibility('Apache-2.0', 'GPL-3.0-only', false)).toBe('incompatible');
    expect(checkCompatibility('Apache-2.0', 'BSD-4-Clause', false)).toBe('unknown');
    expect(checkCompatibility('Apache-2.0', 'GPL-3.0-only OR MIT', false)).toBe('compatible');
  });
});
