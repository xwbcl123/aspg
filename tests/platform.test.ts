import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLink, removeLink, isValidLink, getLinkMethod, isCopyInSync, COPY_MARKER } from '../src/platform.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createLink', () => {
  it('should create a link to target directory', async () => {
    const target = path.join(tmpDir, 'source');
    const link = path.join(tmpDir, 'link');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'test.txt'), 'hello');

    const result = await createLink(target, link);
    expect(['symlink', 'junction', 'copy']).toContain(result.method);
    expect(fs.existsSync(path.join(link, 'test.txt'))).toBe(true);
  });

  it('should return dry-run result without creating files', async () => {
    const target = path.join(tmpDir, 'source');
    const link = path.join(tmpDir, 'link');
    fs.mkdirSync(target);

    const result = await createLink(target, link, true);
    expect(result.method).toBe('symlink');
    expect(fs.existsSync(link)).toBe(false);
  });
});

describe('removeLink', () => {
  it('should remove a link created by ASPG', async () => {
    const target = path.join(tmpDir, 'source');
    const link = path.join(tmpDir, 'link');
    fs.mkdirSync(target);

    await createLink(target, link);
    expect(fs.existsSync(link)).toBe(true);

    const removed = removeLink(link);
    expect(removed).toBe(true);
    expect(fs.existsSync(link)).toBe(false);
  });

  it('should not remove non-ASPG directories', () => {
    const dir = path.join(tmpDir, 'regular-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'file.txt'), 'keep me');

    const removed = removeLink(dir);
    expect(removed).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('should return false for non-existent paths', () => {
    expect(removeLink(path.join(tmpDir, 'nope'))).toBe(false);
  });
});

describe('isValidLink', () => {
  it('should return true for valid link', async () => {
    const target = path.join(tmpDir, 'source');
    const link = path.join(tmpDir, 'link');
    fs.mkdirSync(target);

    await createLink(target, link);
    expect(isValidLink(link, target)).toBe(true);
  });

  it('should return false for wrong target', async () => {
    const target = path.join(tmpDir, 'source');
    const other = path.join(tmpDir, 'other');
    const link = path.join(tmpDir, 'link');
    fs.mkdirSync(target);
    fs.mkdirSync(other);

    await createLink(target, link);
    expect(isValidLink(link, other)).toBe(false);
  });

  it('should return false for non-existent path', () => {
    expect(isValidLink(path.join(tmpDir, 'nope'), tmpDir)).toBe(false);
  });
});

describe('getLinkMethod', () => {
  it('should detect link method', async () => {
    const target = path.join(tmpDir, 'source');
    const link = path.join(tmpDir, 'link');
    fs.mkdirSync(target);

    const result = await createLink(target, link);
    const method = getLinkMethod(link);
    expect(method).toBe(result.method === 'junction' ? 'symlink' : result.method);
  });

  it('should return null for non-existent path', () => {
    expect(getLinkMethod(path.join(tmpDir, 'nope'))).toBeNull();
  });

  it('should return null for regular directory', () => {
    const dir = path.join(tmpDir, 'regular');
    fs.mkdirSync(dir);
    expect(getLinkMethod(dir)).toBeNull();
  });
});

describe('copy fallback marker handling', () => {
  it('should ignore copy marker when checking sync', () => {
    const ssot = path.join(tmpDir, 'ssot');
    const copy = path.join(tmpDir, 'copy');
    fs.mkdirSync(ssot, { recursive: true });
    fs.mkdirSync(copy, { recursive: true });

    fs.writeFileSync(path.join(ssot, 'skill.txt'), 'hello');
    fs.writeFileSync(path.join(ssot, COPY_MARKER), 'pollution');
    fs.writeFileSync(path.join(copy, 'skill.txt'), 'hello');
    fs.writeFileSync(path.join(copy, COPY_MARKER), ssot, 'utf-8');

    expect(isCopyInSync(copy, ssot)).toBe(true);
  });

  it('should not propagate marker from source during copy fallback creation', async () => {
    const ssot = path.join(tmpDir, 'ssot');
    const copy = path.join(tmpDir, 'copy');
    fs.mkdirSync(ssot, { recursive: true });
    fs.writeFileSync(path.join(ssot, 'skill.txt'), 'hello');
    fs.writeFileSync(path.join(ssot, COPY_MARKER), 'pollution');

    const originalSymlinkSync = fs.symlinkSync;
    const symlinkMock = vi.spyOn(fs, 'symlinkSync');
    symlinkMock.mockImplementation(((...args: Parameters<typeof fs.symlinkSync>) => {
      const type = args[2];
      if (type === 'dir' || type === 'junction') {
        throw new Error('force copy fallback');
      }
      return originalSymlinkSync(...args);
    }) as typeof fs.symlinkSync);

    const result = await createLink(ssot, copy);
    expect(result.method).toBe('copy');
    expect(fs.existsSync(path.join(copy, COPY_MARKER))).toBe(true);
    expect(fs.existsSync(path.join(copy, 'skill.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(copy, COPY_MARKER), 'utf-8').trim()).toBe(path.resolve(ssot));
  });
});
