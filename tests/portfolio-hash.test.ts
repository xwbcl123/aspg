import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hashSkillSubtree,
  hashSkillSubtreeAtRevision,
} from '../src/portfolio-hash.js';

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

  it('hashes nested control names and executable content for non-root Skills', () => {
    const baseline = hashSkillSubtree(tmpDir);
    const nestedGit = path.join(tmpDir, 'sub', '.git');
    fs.mkdirSync(nestedGit, { recursive: true });
    fs.writeFileSync(path.join(nestedGit, 'payload'), 'git payload\n');
    expect(hashSkillSubtree(tmpDir).tree_hash).not.toBe(baseline.tree_hash);
    fs.rmSync(path.join(tmpDir, 'sub'), { recursive: true });

    const nestedAspg = path.join(tmpDir, 'sub', '.aspg');
    fs.mkdirSync(nestedAspg, { recursive: true });
    const executable = path.join(nestedAspg, 'evil.sh');
    fs.writeFileSync(executable, '#!/bin/sh\n');
    fs.chmodSync(executable, 0o755);
    const withExecutable = hashSkillSubtree(tmpDir);
    expect(withExecutable.tree_hash).not.toBe(baseline.tree_hash);
    expect(withExecutable.executable_files).toContain('sub/.aspg/evil.sh');
    fs.rmSync(path.join(tmpDir, 'sub'), { recursive: true });

    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(
      path.join(tmpDir, 'sub', 'payload.aspg-managed-link.json'),
      '{"payload":true}\n',
    );
    expect(hashSkillSubtree(tmpDir).tree_hash).not.toBe(baseline.tree_hash);
  });

  it('uses the pinned tracked set for repository-root Skills and fails closed', () => {
    const cloneA = path.join(tmpDir, 'clone-a');
    const cloneB = path.join(tmpDir, 'clone-b');
    fs.mkdirSync(path.join(cloneA, '.aspg'), { recursive: true });
    fs.mkdirSync(path.join(cloneA, 'sub', '.aspg'), { recursive: true });
    fs.writeFileSync(path.join(cloneA, 'SKILL.md'), 'same Skill\n');
    fs.writeFileSync(
      path.join(cloneA, '.gitignore'),
      '.venv/\n__pycache__/\ndist/\n',
    );
    fs.writeFileSync(path.join(cloneA, '.aspg', 'local-state'), 'ignored control\n');
    fs.writeFileSync(path.join(cloneA, '.aspg-copy-fallback'), 'ignored control\n');
    fs.writeFileSync(
      path.join(cloneA, 'skill.aspg-managed-link.json'),
      '{"version":1}\n',
    );
    const nestedExecutable = path.join(cloneA, 'sub', '.aspg', 'real.sh');
    fs.writeFileSync(nestedExecutable, '#!/bin/sh\n');
    fs.chmodSync(nestedExecutable, 0o755);
    fs.writeFileSync(
      path.join(cloneA, 'sub', 'payload.aspg-managed-link.json'),
      '{"tracked":true}\n',
    );
    execFileSync('git', ['init', '-q', cloneA]);
    execFileSync('git', ['-C', cloneA, 'add', '.']);
    execFileSync(
      'git',
      [
        '-C',
        cloneA,
        '-c',
        'user.name=ASPG Test',
        '-c',
        'user.email=aspg@example.test',
        'commit',
        '-qm',
        'fixture',
      ],
    );
    const revision = execFileSync(
      'git',
      ['-C', cloneA, 'rev-parse', 'HEAD'],
      { encoding: 'utf8' },
    ).trim();
    execFileSync('git', ['clone', '-q', cloneA, cloneB]);

    const first = hashSkillSubtree(cloneA, { rootSkill: true, revision });
    expect(first.executable_files).toContain('sub/.aspg/real.sh');
    expect(hashSkillSubtree(cloneB, { rootSkill: true, revision })).toEqual(first);
    expect(hashSkillSubtree(
      cloneB,
      { rootSkill: true, revision, sourcePath: '.' },
    )).toEqual(first);
    expect(hashSkillSubtreeAtRevision(
      cloneB,
      { revision, sourcePath: '.' },
    )).toEqual(first);

    fs.appendFileSync(path.join(cloneB, '.gitignore'), 'secret/\n');
    const dirtyIgnoreDigest = hashSkillSubtree(cloneB, { rootSkill: true, revision });
    expect(dirtyIgnoreDigest.tree_hash).not.toBe(first.tree_hash);
    expect(() => hashSkillSubtree(
      cloneB,
      { rootSkill: true, revision, sourcePath: '.' },
    )).toThrow(/dirty-source-refused: \.gitignore/);
    const hiddenExecutable = path.join(cloneB, 'secret', 'payload.sh');
    fs.mkdirSync(path.dirname(hiddenExecutable));
    fs.writeFileSync(hiddenExecutable, '#!/bin/sh\n');
    fs.chmodSync(hiddenExecutable, 0o755);
    expect(() => hashSkillSubtree(cloneB, { rootSkill: true, revision }))
      .toThrow(/\.gitignore bytes differ from pinned revision/);
    execFileSync('git', ['-C', cloneB, 'restore', '.gitignore']);
    fs.rmSync(path.join(cloneB, 'secret'), { recursive: true });

    for (const relative of [
      '.venv/lib/site.py',
      '__pycache__/module.pyc',
      'dist/bundle.js',
      '.aspg/device-state',
    ]) {
      const target = path.join(cloneB, ...relative.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `derived ${relative}\n`);
    }
    expect(hashSkillSubtree(cloneB, { rootSkill: true, revision })).toEqual(first);
    expect(hashSkillSubtree(
      cloneB,
      { rootSkill: true, revision, sourcePath: '.' },
    )).toEqual(first);

    fs.appendFileSync(path.join(cloneB, 'sub', '.aspg', 'real.sh'), 'echo changed\n');
    expect(hashSkillSubtree(cloneB, { rootSkill: true, revision }).tree_hash)
      .not.toBe(first.tree_hash);
    execFileSync('git', ['-C', cloneB, 'restore', 'sub/.aspg/real.sh']);

    const nestedGit = path.join(cloneB, 'sub', '.git');
    fs.mkdirSync(nestedGit);
    fs.writeFileSync(path.join(nestedGit, 'payload'), 'untracked control\n');
    expect(() => hashSkillSubtree(cloneB, { rootSkill: true, revision }))
      .toThrow(/untracked nested control content/);
    fs.rmSync(nestedGit, { recursive: true });

    fs.writeFileSync(path.join(cloneB, 'UNKNOWN.md'), 'untracked\n');
    expect(() => hashSkillSubtree(cloneB, { rootSkill: true, revision }))
      .toThrow(/outside pinned revision/);
    expect(() => hashSkillSubtree(cloneB, { rootSkill: true }))
      .toThrow(/requires a pinned revision/);
  });

  it('uses the pinned tracked set for non-root Skills and blocks C1 dirty-ignore bypasses', () => {
    const repository = path.join(tmpDir, 'source');
    const clone = path.join(tmpDir, 'clone');
    const sourcePath = 'skills/demo';
    const skill = path.join(repository, ...sourcePath.split('/'));
    fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, '.gitignore'),
      'skills/demo/.venv/\nskills/demo/__pycache__/\n',
    );
    fs.writeFileSync(path.join(repository, 'README.md'), 'source repository\n');
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'exact non-root Skill\n');
    const executable = path.join(skill, 'scripts', 'run.sh');
    fs.writeFileSync(executable, '#!/bin/sh\n');
    fs.chmodSync(executable, 0o755);
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['-C', repository, 'add', '.']);
    execFileSync(
      'git',
      [
        '-C',
        repository,
        '-c',
        'user.name=ASPG Test',
        '-c',
        'user.email=aspg@example.test',
        'commit',
        '-qm',
        'fixture',
      ],
    );
    const revision = execFileSync(
      'git',
      ['-C', repository, 'rev-parse', 'HEAD'],
      { encoding: 'utf8' },
    ).trim();
    execFileSync('git', ['clone', '-q', repository, clone]);
    const clonedSkill = path.join(clone, ...sourcePath.split('/'));

    const first = hashSkillSubtree(skill, { revision, sourcePath });
    expect(first.executable_files).toEqual(['scripts/run.sh']);
    expect(hashSkillSubtree(clonedSkill, { revision, sourcePath })).toEqual(first);

    for (const relative of ['.venv/lib/site.py', '__pycache__/module.pyc']) {
      const target = path.join(clonedSkill, ...relative.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `derived ${relative}\n`);
    }
    expect(hashSkillSubtree(clonedSkill, { revision, sourcePath })).toEqual(first);

    fs.appendFileSync(
      path.join(clone, '.gitignore'),
      'skills/demo/secret/\n',
    );
    const hidden = path.join(clonedSkill, 'secret', 'hidden.sh');
    fs.mkdirSync(path.dirname(hidden), { recursive: true });
    fs.writeFileSync(hidden, '#!/bin/sh\n');
    expect(() => hashSkillSubtree(clonedSkill, { revision, sourcePath }))
      .toThrow(/dirty-source-refused: \.gitignore/);
    execFileSync('git', ['-C', clone, 'restore', '.gitignore']);
    fs.rmSync(path.join(clonedSkill, 'secret'), { recursive: true });

    const unknown = path.join(clonedSkill, 'UNKNOWN.md');
    fs.writeFileSync(unknown, 'untracked\n');
    expect(() => hashSkillSubtree(clonedSkill, { revision, sourcePath }))
      .toThrow(/dirty-source-refused: skills\/demo\/UNKNOWN\.md/);
    fs.rmSync(unknown);

    fs.appendFileSync(path.join(clonedSkill, 'SKILL.md'), 'dirty bytes\n');
    expect(() => hashSkillSubtree(clonedSkill, { revision, sourcePath }))
      .toThrow(/dirty-source-refused: skills\/demo\/SKILL\.md/);
    execFileSync('git', ['-C', clone, 'restore', 'skills/demo/SKILL.md']);

    fs.chmodSync(path.join(clonedSkill, 'scripts', 'run.sh'), 0o644);
    expect(() => hashSkillSubtree(clonedSkill, { revision, sourcePath }))
      .toThrow(/dirty-source-refused|executable mode differs from pinned revision/);
    execFileSync('git', ['-C', clone, 'restore', 'skills/demo/scripts/run.sh']);

    fs.rmSync(path.join(clonedSkill, 'SKILL.md'));
    fs.symlinkSync('scripts/run.sh', path.join(clonedSkill, 'SKILL.md'));
    expect(() => hashSkillSubtree(clonedSkill, { revision, sourcePath }))
      .toThrow(/dirty-source-refused|changed type/);
    fs.rmSync(path.join(clonedSkill, 'SKILL.md'));
    execFileSync('git', ['-C', clone, 'restore', 'skills/demo/SKILL.md']);

    fs.appendFileSync(path.join(clone, 'README.md'), 'dirty outside subtree\n');
    expect(() => hashSkillSubtree(clonedSkill, { revision, sourcePath }))
      .toThrow(/dirty-source-refused: README\.md/);
    execFileSync('git', ['-C', clone, 'restore', 'README.md']);

    fs.writeFileSync(path.join(clone, 'README.md'), 'second revision\n');
    execFileSync('git', ['-C', clone, 'add', 'README.md']);
    execFileSync(
      'git',
      [
        '-C',
        clone,
        '-c',
        'user.name=ASPG Test',
        '-c',
        'user.email=aspg@example.test',
        'commit',
        '-qm',
        'second fixture',
      ],
    );
    expect(() => hashSkillSubtree(clonedSkill, { revision, sourcePath }))
      .toThrow(/source-revision-mismatch/);
    expect(hashSkillSubtreeAtRevision(
      clone,
      { revision, sourcePath },
    )).toEqual(first);
  });
});
