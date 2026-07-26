import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashSkillSubtree } from '../src/portfolio-hash.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-portfolio-hash-'));
  fs.mkdirSync(path.join(tmpDir, 'scripts'));
  fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), 'fixture\n');
  fs.writeFileSync(path.join(tmpDir, 'scripts', 'run.sh'), '#!/bin/sh\n');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Portfolio per-Skill subtree hash', () => {
  it('is deterministic and reports executable files', () => {
    fs.chmodSync(path.join(tmpDir, 'scripts', 'run.sh'), 0o755);
    const first = hashSkillSubtree(tmpDir);
    expect(first).toEqual(hashSkillSubtree(tmpDir));
    expect(first.tree_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.executable_files).toEqual(['scripts/run.sh']);
  });

  it('changes for bytes, path, file type and executable mode', () => {
    const baseline = hashSkillSubtree(tmpDir).tree_hash;

    fs.appendFileSync(path.join(tmpDir, 'SKILL.md'), 'bytes\n');
    const bytes = hashSkillSubtree(tmpDir).tree_hash;
    expect(bytes).not.toBe(baseline);

    fs.renameSync(path.join(tmpDir, 'SKILL.md'), path.join(tmpDir, 'INSTRUCTIONS.md'));
    const renamed = hashSkillSubtree(tmpDir).tree_hash;
    expect(renamed).not.toBe(bytes);

    fs.rmSync(path.join(tmpDir, 'INSTRUCTIONS.md'));
    fs.symlinkSync('scripts/run.sh', path.join(tmpDir, 'INSTRUCTIONS.md'));
    const symlink = hashSkillSubtree(tmpDir).tree_hash;
    expect(symlink).not.toBe(renamed);

    const beforeMode = hashSkillSubtree(tmpDir).tree_hash;
    fs.chmodSync(path.join(tmpDir, 'scripts', 'run.sh'), 0o755);
    const afterMode = hashSkillSubtree(tmpDir);
    expect(afterMode.tree_hash).not.toBe(beforeMode);
    expect(afterMode.executable_files).toEqual(['scripts/run.sh']);
  });
});
