/**
 * Deterministic per-Skill subtree hashing.
 *
 * Non-root Skills hash every filesystem entry. Repository-root Skills use the
 * pinned Git revision as their path universe, exclude only top-level repository
 * control state, and fail closed on untracked content that is not ignored by a
 * tracked .gitignore.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface SkillSubtreeDigest {
  tree_hash: string;
  executable_files: string[];
}

export interface HashSkillSubtreeOptions {
  rootSkill?: boolean;
  revision?: string;
}

interface TrackedEntry {
  mode: string;
  type: string;
  objectId: string;
  relative: string;
}

interface TrackedNode {
  directories: Map<string, TrackedNode>;
  entries: Map<string, TrackedEntry>;
}

const ROOT_CONTROL_NAMES = new Set(['.git', '.aspg', '.aspg-copy-fallback']);
const REVISION_PATTERN = /^[0-9a-f]{40}$/;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function frame(hash: crypto.Hash, value: string | Buffer): void {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(data.length));
  hash.update(length);
  hash.update(data);
}

function isTopLevelControlPath(relative: string): boolean {
  const segments = relative.split('/');
  const top = segments[0];
  if (ROOT_CONTROL_NAMES.has(top)) return true;
  return segments.length === 1 && top.endsWith('.aspg-managed-link.json');
}

function containsNestedControlPath(relative: string): boolean {
  const segments = relative.split('/');
  return segments.some((segment, index) => (
    index > 0
    && (
      ROOT_CONTROL_NAMES.has(segment)
      || segment.endsWith('.aspg-managed-link.json')
    )
  ));
}

function assertDirectory(root: string): string {
  const resolvedRoot = fs.realpathSync(root);
  if (!fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Skill subtree is not a directory: ${root}`);
  }
  return resolvedRoot;
}

function hashFilesystemTree(resolvedRoot: string): SkillSubtreeDigest {
  const hash = crypto.createHash('sha256');
  const executableFiles: string[] = [];

  function visit(directory: string, prefix = ''): void {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => compareText(a.name, b.name));

    for (const entry of entries) {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);

      if (stat.isDirectory()) {
        frame(hash, 'directory');
        frame(hash, relative);
        visit(absolute, relative);
      } else if (stat.isSymbolicLink()) {
        frame(hash, 'symlink');
        frame(hash, relative);
        frame(hash, fs.readlinkSync(absolute));
      } else if (stat.isFile()) {
        const executable = (stat.mode & 0o111) !== 0;
        frame(hash, 'file');
        frame(hash, relative);
        frame(hash, executable ? 'executable' : 'not-executable');
        frame(hash, fs.readFileSync(absolute));
        if (executable) executableFiles.push(relative);
      } else {
        throw new Error(`unsupported file type in Skill subtree: ${relative}`);
      }
    }
  }

  visit(resolvedRoot);
  return {
    tree_hash: `sha256:${hash.digest('hex')}`,
    executable_files: executableFiles.sort(compareText),
  };
}

function readTrackedEntries(resolvedRoot: string, revision: string): TrackedEntry[] {
  if (!REVISION_PATTERN.test(revision)) {
    throw new Error('repository-root Skill hashing requires a pinned 40-character revision');
  }

  let repositoryRoot: string;
  let output: Buffer;
  try {
    repositoryRoot = execFileSync(
      'git',
      ['-C', resolvedRoot, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    const resolvedRevision = execFileSync(
      'git',
      ['-C', resolvedRoot, 'rev-parse', `${revision}^{commit}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (resolvedRevision !== revision) {
      throw new Error(`pinned revision does not resolve to the exact commit ${revision}`);
    }
    output = execFileSync(
      'git',
      ['-C', resolvedRoot, 'ls-tree', '-r', '-z', '--full-tree', revision],
      { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    throw new Error(
      `cannot resolve tracked paths for repository-root Skill at ${revision}`,
      { cause: error },
    );
  }

  if (fs.realpathSync(repositoryRoot) !== resolvedRoot) {
    throw new Error('repository-root Skill hashing requires the Git worktree root');
  }

  return output.toString('utf8').split('\0').filter(Boolean).map((record) => {
    const match = /^([0-7]{6}) ([a-z]+) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('cannot parse pinned Git tree entry');
    const [, mode, type, objectId, relative] = match;
    if (
      path.posix.isAbsolute(relative)
      || path.posix.normalize(relative) !== relative
      || relative.split('/').some((segment) => segment === '.' || segment === '..')
    ) {
      throw new Error(`pinned Git tree contains a non-portable path: ${relative}`);
    }
    return { mode, type, objectId, relative };
  }).filter((entry) => !isTopLevelControlPath(entry.relative));
}

function filesystemLeaves(resolvedRoot: string): string[] {
  const leaves: string[] = [];

  function visit(directory: string, prefix = '', depth = 0): void {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      const relative = path.posix.join(prefix, entry.name);
      if (depth === 0 && isTopLevelControlPath(relative)) continue;
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute, relative, depth + 1);
      else if (stat.isFile() || stat.isSymbolicLink()) leaves.push(relative);
      else throw new Error(`unsupported file type in Skill subtree: ${relative}`);
    }
  }

  visit(resolvedRoot);
  return leaves;
}

function ignoredByTrackedGitignore(
  resolvedRoot: string,
  candidates: string[],
  trackedEntries: Map<string, TrackedEntry>,
): Set<string> {
  if (candidates.length === 0) return new Set();
  const result = spawnSync(
    'git',
    [
      '-c',
      'core.excludesFile=/dev/null',
      '-C',
      resolvedRoot,
      'check-ignore',
      '--no-index',
      '-z',
      '-v',
      '--stdin',
    ],
    {
      input: `${candidates.join('\0')}\0`,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error('cannot verify ignored paths for repository-root Skill', {
      cause: result.error,
    });
  }

  const fields = result.stdout.toString('utf8').split('\0');
  const ignored = new Set<string>();
  const verifiedIgnoreFiles = new Set<string>();
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const source = fields[index];
    const candidate = fields[index + 3];
    const sourceRelative = path.isAbsolute(source)
      ? path.relative(resolvedRoot, source)
      : source;
    const portableSource = sourceRelative.split(path.sep).join('/');
    const trackedIgnore = trackedEntries.get(portableSource);
    if (path.posix.basename(portableSource) !== '.gitignore' || !trackedIgnore) continue;

    if (!verifiedIgnoreFiles.has(portableSource)) {
      if (
        trackedIgnore.type !== 'blob'
        || (trackedIgnore.mode !== '100644' && trackedIgnore.mode !== '100755')
      ) {
        throw new Error(
          `tracked .gitignore has unsupported pinned type or mode: ${portableSource}`,
        );
      }
      const actualPath = path.join(resolvedRoot, ...portableSource.split('/'));
      const actualStat = fs.lstatSync(actualPath);
      const actualExecutable = (actualStat.mode & 0o111) !== 0;
      const pinnedExecutable = trackedIgnore.mode === '100755';
      if (!actualStat.isFile() || actualExecutable !== pinnedExecutable) {
        throw new Error(
          `tracked .gitignore type or mode differs from pinned revision: ${portableSource}`,
        );
      }
      let pinnedBytes: Buffer;
      try {
        pinnedBytes = execFileSync(
          'git',
          ['-C', resolvedRoot, 'cat-file', 'blob', trackedIgnore.objectId],
          { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
        );
      } catch (error) {
        throw new Error(
          `cannot read pinned .gitignore blob: ${portableSource}`,
          { cause: error },
        );
      }
      if (!fs.readFileSync(actualPath).equals(pinnedBytes)) {
        throw new Error(
          `tracked .gitignore bytes differ from pinned revision: ${portableSource}`,
        );
      }
      verifiedIgnoreFiles.add(portableSource);
    }
    ignored.add(candidate);
  }
  return ignored;
}

function buildTrackedTree(entries: TrackedEntry[]): TrackedNode {
  const root: TrackedNode = { directories: new Map(), entries: new Map() };
  for (const entry of entries) {
    const segments = entry.relative.split('/');
    const name = segments.pop()!;
    let node = root;
    for (const segment of segments) {
      if (node.entries.has(segment)) {
        throw new Error(`pinned Git tree path conflicts at ${entry.relative}`);
      }
      let child = node.directories.get(segment);
      if (!child) {
        child = { directories: new Map(), entries: new Map() };
        node.directories.set(segment, child);
      }
      node = child;
    }
    if (node.directories.has(name) || node.entries.has(name)) {
      throw new Error(`duplicate pinned Git tree path: ${entry.relative}`);
    }
    node.entries.set(name, entry);
  }
  return root;
}

function hashTrackedRoot(
  resolvedRoot: string,
  revision: string | undefined,
): SkillSubtreeDigest {
  if (!revision) {
    throw new Error('repository-root Skill hashing requires a pinned revision');
  }
  const tracked = readTrackedEntries(resolvedRoot, revision);
  const trackedEntries = new Map(tracked.map((entry) => [entry.relative, entry]));
  const trackedPaths = new Set(trackedEntries.keys());
  const untracked = filesystemLeaves(resolvedRoot)
    .filter((relative) => !trackedPaths.has(relative));
  const nestedControls = untracked.filter(containsNestedControlPath);
  if (nestedControls.length > 0) {
    throw new Error(
      `repository-root Skill contains untracked nested control content: ${nestedControls[0]}`,
    );
  }
  const ignored = ignoredByTrackedGitignore(resolvedRoot, untracked, trackedEntries);
  const unsafeUntracked = untracked.filter((relative) => !ignored.has(relative));
  if (unsafeUntracked.length > 0) {
    throw new Error(
      `repository-root Skill contains content outside pinned revision: ${unsafeUntracked[0]}`,
    );
  }

  const tree = buildTrackedTree(tracked);
  const hash = crypto.createHash('sha256');
  const executableFiles: string[] = [];

  function visit(node: TrackedNode, prefix = ''): void {
    const names = [...node.directories.keys(), ...node.entries.keys()].sort(compareText);
    for (const name of names) {
      const relative = path.posix.join(prefix, name);
      const directory = node.directories.get(name);
      if (directory) {
        frame(hash, 'directory');
        frame(hash, relative);
        visit(directory, relative);
        continue;
      }

      const entry = node.entries.get(name)!;
      const absolute = path.join(resolvedRoot, ...entry.relative.split('/'));
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absolute);
      } catch (error) {
        throw new Error(`tracked Skill path is missing: ${entry.relative}`, { cause: error });
      }

      if (entry.type !== 'blob') {
        throw new Error(`unsupported tracked Git entry type at ${entry.relative}: ${entry.type}`);
      }
      if (entry.mode === '120000') {
        if (!stat.isSymbolicLink()) {
          throw new Error(`tracked Skill symlink has changed type: ${entry.relative}`);
        }
        frame(hash, 'symlink');
        frame(hash, relative);
        frame(hash, fs.readlinkSync(absolute));
      } else if (entry.mode === '100644' || entry.mode === '100755') {
        if (!stat.isFile()) {
          throw new Error(`tracked Skill file has changed type: ${entry.relative}`);
        }
        const executable = (stat.mode & 0o111) !== 0;
        frame(hash, 'file');
        frame(hash, relative);
        frame(hash, executable ? 'executable' : 'not-executable');
        frame(hash, fs.readFileSync(absolute));
        if (executable) executableFiles.push(relative);
      } else {
        throw new Error(`unsupported tracked Git mode at ${entry.relative}: ${entry.mode}`);
      }
    }
  }

  visit(tree);
  return {
    tree_hash: `sha256:${hash.digest('hex')}`,
    executable_files: executableFiles.sort(compareText),
  };
}

export function hashSkillSubtree(
  root: string,
  options: HashSkillSubtreeOptions = {},
): SkillSubtreeDigest {
  const resolvedRoot = assertDirectory(root);
  return options.rootSkill
    ? hashTrackedRoot(resolvedRoot, options.revision)
    : hashFilesystemTree(resolvedRoot);
}
