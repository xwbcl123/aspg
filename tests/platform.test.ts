import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  COPY_MARKER,
  LINK_MARKER_SUFFIX,
  LinkSafetyError,
  createLink,
  getLinkMethod,
  isCopyInSync,
  isValidLink,
  removeLink,
  syncCopyFallback,
} from '../src/platform.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
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

  it('refuses an unmanaged real directory without merging content', async () => {
    const target = path.join(tmpDir, 'source');
    const link = path.join(tmpDir, 'link');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'canonical.txt'), 'canonical');
    fs.mkdirSync(link);
    fs.writeFileSync(path.join(link, 'local.txt'), 'preserve');

    await expect(createLink(target, link)).rejects.toMatchObject({
      code: 'ASPG_LINK_DESTINATION_REAL_DIRECTORY',
    });
    expect(fs.readFileSync(path.join(link, 'local.txt'), 'utf-8')).toBe('preserve');
    expect(fs.existsSync(path.join(link, 'canonical.txt'))).toBe(false);
  });

  it('refuses a file destination', async () => {
    const target = path.join(tmpDir, 'source');
    const link = path.join(tmpDir, 'link');
    fs.mkdirSync(target);
    fs.writeFileSync(link, 'preserve');

    await expect(createLink(target, link)).rejects.toMatchObject({
      code: 'ASPG_LINK_DESTINATION_FILE',
    });
    expect(fs.readFileSync(link, 'utf-8')).toBe('preserve');
  });

  it('refuses a foreign link even when it points to the requested target', async () => {
    const target = path.join(tmpDir, 'source');
    const link = path.join(tmpDir, 'link');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, 'dir');

    await expect(createLink(target, link)).rejects.toMatchObject({
      code: 'ASPG_LINK_DESTINATION_FOREIGN_LINK',
    });
    expect(fs.readlinkSync(link)).toBe(target);
  });

  it('atomically replaces a sidecar-recorded stale link', async () => {
    const first = path.join(tmpDir, 'first');
    const second = path.join(tmpDir, 'second');
    const link = path.join(tmpDir, 'link');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(second, 'second.txt'), 'second');

    await createLink(first, link);
    await createLink(second, link);

    expect(isValidLink(link, second)).toBe(true);
    expect(fs.existsSync(path.join(link, 'second.txt'))).toBe(true);
  });

  it('cleans temporary artifacts when atomic rename is interrupted', async () => {
    const target = path.join(tmpDir, 'source');
    const link = path.join(tmpDir, 'link');
    fs.mkdirSync(target);

    const originalRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((source, destination) => {
      if (String(source).includes('.aspg-link-')) {
        throw Object.assign(new Error('interrupted'), { code: 'EIO' });
      }
      return originalRename(source, destination);
    }) as typeof fs.renameSync);

    await expect(createLink(target, link)).rejects.toMatchObject({
      code: 'ASPG_LINK_ATOMIC_RENAME_FAILED',
    });
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.existsSync(`${link}${LINK_MARKER_SUFFIX}`)).toBe(false);
    expect(
      fs.readdirSync(tmpDir).some(
        (name) => name.includes('.aspg-link-') || name.includes('.aspg-marker-'),
      ),
    ).toBe(false);
  });

  it('preserves the previous managed link when replacement is interrupted', async () => {
    const first = path.join(tmpDir, 'first');
    const second = path.join(tmpDir, 'second');
    const link = path.join(tmpDir, 'link');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    await createLink(first, link);

    const originalRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((source, destination) => {
      if (String(source).includes('.aspg-link-')) {
        throw Object.assign(new Error('interrupted replacement'), { code: 'EIO' });
      }
      return originalRename(source, destination);
    }) as typeof fs.renameSync);

    await expect(createLink(second, link)).rejects.toMatchObject({
      code: 'ASPG_LINK_ATOMIC_RENAME_FAILED',
    });
    expect(isValidLink(link, first)).toBe(true);
    expect(fs.existsSync(`${link}${LINK_MARKER_SUFFIX}`)).toBe(true);
    expect(
      fs.readdirSync(tmpDir).some(
        (name) => name.includes('.aspg-link-') || name.includes('.aspg-marker-'),
      ),
    ).toBe(false);
  });

  it('does not silently copy when symlink creation fails on darwin/linux', async () => {
    const target = path.join(tmpDir, 'source');
    const link = path.join(tmpDir, 'link');
    fs.mkdirSync(target);
    vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });

    const error = await createLink(target, link, { platform: 'linux' })
      .then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(LinkSafetyError);
    expect(error).toMatchObject({ code: 'ASPG_LINK_SYMLINK_CREATE_FAILED' });
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

  it('never recursively removes a real directory even with a copy marker', () => {
    const dir = path.join(tmpDir, 'legacy-copy');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, COPY_MARKER), '/some/source');
    fs.writeFileSync(path.join(dir, 'user-file.txt'), 'preserve');

    expect(removeLink(dir)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'user-file.txt'), 'utf-8')).toBe('preserve');
  });

  it('does not remove a foreign symlink', () => {
    const target = path.join(tmpDir, 'source');
    const link = path.join(tmpDir, 'foreign');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, 'dir');

    expect(removeLink(link)).toBe(false);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
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
    expect(method).toBe(result.method);
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

    const result = await createLink(ssot, copy, { platform: 'win32' });
    expect(result.method).toBe('copy');
    expect(fs.existsSync(path.join(copy, COPY_MARKER))).toBe(true);
    expect(fs.existsSync(path.join(copy, 'skill.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(copy, COPY_MARKER), 'utf-8').trim()).toBe(path.resolve(ssot));
  });

  it('dereferences Skill symlinks when an explicit Windows copy is required', async () => {
    const canonicalSkill = path.join(tmpDir, 'canonical-skill');
    const ssot = path.join(tmpDir, 'ssot');
    const copy = path.join(tmpDir, 'copy');
    fs.mkdirSync(canonicalSkill);
    fs.writeFileSync(path.join(canonicalSkill, 'SKILL.md'), '# linked skill');
    fs.mkdirSync(ssot);
    fs.symlinkSync(canonicalSkill, path.join(ssot, 'linked-skill'), 'dir');

    vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('force Windows copy'), { code: 'EPERM' });
    });

    const result = await createLink(ssot, copy, { platform: 'win32' });
    expect(result.method).toBe('copy');
    expect(
      fs.readFileSync(path.join(copy, 'linked-skill', 'SKILL.md'), 'utf-8'),
    ).toBe('# linked skill');
    expect(isCopyInSync(copy, ssot)).toBe(true);
  });

  it('refreshes only an explicitly marked Windows copy fallback', () => {
    const ssot = path.join(tmpDir, 'ssot');
    const copy = path.join(tmpDir, 'copy');
    fs.mkdirSync(ssot);
    fs.mkdirSync(copy);
    fs.writeFileSync(path.join(ssot, 'current.txt'), 'current');
    fs.writeFileSync(path.join(copy, 'stale.txt'), 'stale');
    fs.writeFileSync(path.join(copy, COPY_MARKER), ssot, 'utf-8');

    syncCopyFallback(ssot, copy, false, 'win32');

    expect(fs.existsSync(path.join(copy, 'stale.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(copy, 'current.txt'), 'utf-8')).toBe('current');
    expect(isCopyInSync(copy, ssot)).toBe(true);
  });

  it('refuses a Windows copy marker that does not match the requested target', () => {
    const ssot = path.join(tmpDir, 'ssot');
    const copy = path.join(tmpDir, 'copy');
    fs.mkdirSync(ssot);
    fs.mkdirSync(copy);
    fs.writeFileSync(path.join(copy, 'local.txt'), 'preserve');
    fs.writeFileSync(path.join(copy, COPY_MARKER), path.join(tmpDir, 'other'), 'utf-8');

    expect(() => syncCopyFallback(ssot, copy, false, 'win32')).toThrowError(
      /ASPG_LINK_DESTINATION_REAL_DIRECTORY/,
    );
    expect(fs.readFileSync(path.join(copy, 'local.txt'), 'utf-8')).toBe('preserve');
  });
});
