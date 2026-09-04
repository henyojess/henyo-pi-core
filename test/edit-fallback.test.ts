import { describe, it, expect } from 'vitest';
import { version } from '../src/edit-fallback.js';

describe('edit-fallback scaffold', () => {
  it('exports a semver version string', () => {
    expect(version).toBeTypeOf('string');
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
