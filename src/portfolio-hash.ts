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
  sourcePath?: string;
}

export interface HashSkillSubtreeAtRevisionOptions {
  revision: string;
  sourcePath: string;
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

function filesystemLeaves(
  resolvedRoot: string,
  skipTopLevelControls = true,
): string[] {
  const leaves: string[] = [];

  function visit(directory: string, prefix = '', depth = 0): void {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      const relative = path.posix.join(prefix, entry.name);
      if (skipTopLevelControls && depth === 0 && isTopLevelControlPath(relative)) continue;
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

function assertPortableSourcePath(sourcePath: string): string {
  if (
    sourcePath.length === 0
    || sourcePath.startsWith('/')
    || sourcePath.includes('\\')
    || (sourcePath !== '.' && path.posix.normalize(sourcePath) !== sourcePath)
    || (sourcePath !== '.' && sourcePath.split('/').some((segment) => (
      segment === '' || segment === '.' || segment === '..'
    )))
  ) {
    throw new Error(`exact Skill hashing requires a portable sourcePath: ${sourcePath}`);
  }
  return sourcePath;
}

function resolvePinnedCommit(repositoryRoot: string, revision: string): void {
  if (!REVISION_PATTERN.test(revision)) {
    throw new Error('exact Skill hashing requires a pinned 40-character revision');
  }
  let resolvedRevision: string;
  try {
    resolvedRevision = execFileSync(
      'git',
      ['-C', repositoryRoot, 'rev-parse', `${revision}^{commit}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch (error) {
    throw new Error(`cannot resolve pinned Skill revision ${revision}`, { cause: error });
  }
  if (resolvedRevision !== revision) {
    throw new Error(`pinned revision does not resolve to the exact commit ${revision}`);
  }
}

function dirtySourcePaths(repositoryRoot: string): string[] {
  let output: Buffer;
  try {
    output = execFileSync(
      'git',
      [
        '-C',
        repositoryRoot,
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ],
      { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    throw new Error('cannot inspect source worktree status', { cause: error });
  }

  const records = output.toString('utf8').split('\0').filter(Boolean);
  const offending = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error('cannot parse source worktree status');
    }
    const status = record.slice(0, 2);
    const relative = record.slice(3).split(path.sep).join('/');
    if (!isTopLevelControlPath(relative)) offending.add(relative);
    if (status.includes('R') || status.includes('C')) {
      index += 1;
      const original = records[index];
      if (original === undefined) {
        throw new Error('cannot parse source worktree rename status');
      }
      const portableOriginal = original.split(path.sep).join('/');
      if (!isTopLevelControlPath(portableOriginal)) offending.add(portableOriginal);
    }
  }
  return [...offending].sort(compareText);
}

function readPinnedEntry(
  repositoryRoot: string,
  revision: string,
  relative: string,
): TrackedEntry | null {
  let output: Buffer;
  try {
    output = execFileSync(
      'git',
      [
        '-C',
        repositoryRoot,
        'ls-tree',
        '-z',
        '--full-tree',
        revision,
        '--',
        `:(literal)${relative}`,
      ],
      { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    throw new Error(`cannot inspect pinned Git path: ${relative}`, { cause: error });
  }
  const records = output.toString('utf8').split('\0').filter(Boolean);
  for (const record of records) {
    const match = /^([0-7]{6}) ([a-z]+) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('cannot parse pinned Git tree entry');
    const [, mode, type, objectId, entryRelative] = match;
    if (entryRelative === relative) {
      return { mode, type, objectId, relative: entryRelative };
    }
  }
  return null;
}

function ignoredByExactPinnedGitignore(
  repositoryRoot: string,
  revision: string,
  candidates: string[],
): Set<string> {
  if (candidates.length === 0) return new Set();
  const result = spawnSync(
    'git',
    [
      '-c',
      'core.excludesFile=/dev/null',
      '-C',
      repositoryRoot,
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
    throw new Error('cannot verify ignored paths for exact Skill hashing', {
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
      ? path.relative(repositoryRoot, source)
      : source;
    const portableSource = sourceRelative.split(path.sep).join('/');
    if (path.posix.basename(portableSource) !== '.gitignore') continue;

    if (!verifiedIgnoreFiles.has(portableSource)) {
      const trackedIgnore = readPinnedEntry(repositoryRoot, revision, portableSource);
      if (
        !trackedIgnore
        || trackedIgnore.type !== 'blob'
        || (trackedIgnore.mode !== '100644' && trackedIgnore.mode !== '100755')
      ) {
        throw new Error(
          `ignored content is not authorized by a pinned .gitignore: ${portableSource}`,
        );
      }
      const actualPath = path.join(repositoryRoot, ...portableSource.split('/'));
      let actualStat: fs.Stats;
      try {
        actualStat = fs.lstatSync(actualPath);
      } catch (error) {
        throw new Error(
          `pinned .gitignore is unavailable: ${portableSource}`,
          { cause: error },
        );
      }
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
          ['-C', repositoryRoot, 'cat-file', 'blob', trackedIgnore.objectId],
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

function readExactTrackedEntries(
  repositoryRoot: string,
  revision: string,
  sourcePath: string,
): TrackedEntry[] {
  let output: Buffer;
  try {
    output = execFileSync(
      'git',
      [
        '-C',
        repositoryRoot,
        'ls-tree',
        '-r',
        '-z',
        '--full-tree',
        revision,
        '--',
        `:(literal)${sourcePath}`,
      ],
      { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    throw new Error(
      `cannot resolve tracked paths for Skill ${sourcePath} at ${revision}`,
      { cause: error },
    );
  }

  const prefix = sourcePath === '.' ? '' : `${sourcePath}/`;
  const entries = output.toString('utf8').split('\0').filter(Boolean).map((record) => {
    const match = /^([0-7]{6}) ([a-z]+) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('cannot parse pinned Git tree entry');
    const [, mode, type, objectId, repositoryRelative] = match;
    if (
      path.posix.isAbsolute(repositoryRelative)
      || path.posix.normalize(repositoryRelative) !== repositoryRelative
      || repositoryRelative.split('/').some((segment) => segment === '.' || segment === '..')
    ) {
      throw new Error(`pinned Git tree contains a non-portable path: ${repositoryRelative}`);
    }
    if (prefix && !repositoryRelative.startsWith(prefix)) {
      throw new Error(`pinned Git path escapes sourcePath ${sourcePath}: ${repositoryRelative}`);
    }
    const relative = prefix ? repositoryRelative.slice(prefix.length) : repositoryRelative;
    if (!relative) {
      throw new Error(`Skill sourcePath is not a directory: ${sourcePath}`);
    }
    return { mode, type, objectId, relative };
  }).filter((entry) => (
    sourcePath !== '.' || !isTopLevelControlPath(entry.relative)
  ));

  if (entries.length === 0) {
    throw new Error(`pinned Skill sourcePath has no tracked files: ${sourcePath}`);
  }
  return entries;
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

function hashTrackedEntries(
  resolvedRoot: string,
  tracked: TrackedEntry[],
  enforcePinnedMode: boolean,
): SkillSubtreeDigest {
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
        const pinnedExecutable = entry.mode === '100755';
        if (enforcePinnedMode && executable !== pinnedExecutable) {
          throw new Error(
            `tracked Skill executable mode differs from pinned revision: ${entry.relative}`,
          );
        }
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

function hashPinnedTrackedEntries(
  repositoryRoot: string,
  tracked: TrackedEntry[],
): SkillSubtreeDigest {
  const tree = buildTrackedTree(tracked);
  const hash = crypto.createHash('sha256');
  const executableFiles: string[] = [];

  function readBlob(entry: TrackedEntry): Buffer {
    try {
      return execFileSync(
        'git',
        ['-C', repositoryRoot, 'cat-file', 'blob', entry.objectId],
        { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
      );
    } catch (error) {
      throw new Error(`cannot read pinned Git blob: ${entry.relative}`, { cause: error });
    }
  }

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
      if (entry.type !== 'blob') {
        throw new Error(`unsupported tracked Git entry type at ${entry.relative}: ${entry.type}`);
      }
      if (entry.mode === '120000') {
        frame(hash, 'symlink');
        frame(hash, relative);
        frame(hash, readBlob(entry));
      } else if (entry.mode === '100644' || entry.mode === '100755') {
        const executable = entry.mode === '100755';
        frame(hash, 'file');
        frame(hash, relative);
        frame(hash, executable ? 'executable' : 'not-executable');
        frame(hash, readBlob(entry));
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

  return hashTrackedEntries(resolvedRoot, tracked, false);
}

function hashExactTrackedSubtree(
  resolvedRoot: string,
  revision: string | undefined,
  sourcePathInput: string,
): SkillSubtreeDigest {
  if (!revision) {
    throw new Error('exact Skill hashing requires a pinned revision');
  }
  const sourcePath = assertPortableSourcePath(sourcePathInput);

  let repositoryRoot: string;
  try {
    repositoryRoot = fs.realpathSync(execFileSync(
      'git',
      ['-C', resolvedRoot, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim());
  } catch (error) {
    throw new Error('exact Skill hashing requires a Git worktree', { cause: error });
  }

  resolvePinnedCommit(repositoryRoot, revision);
  const head = execFileSync(
    'git',
    ['-C', repositoryRoot, 'rev-parse', 'HEAD'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  if (head !== revision) {
    throw new Error(
      `source-revision-mismatch: expected ${revision}, found ${head}`,
    );
  }

  const offending = dirtySourcePaths(repositoryRoot);
  if (offending.length > 0) {
    throw new Error(`dirty-source-refused: ${offending.join(', ')}`);
  }

  let expectedRoot: string;
  try {
    expectedRoot = fs.realpathSync(
      sourcePath === '.'
        ? repositoryRoot
        : path.join(repositoryRoot, ...sourcePath.split('/')),
    );
  } catch (error) {
    throw new Error(`Skill sourcePath is unavailable: ${sourcePath}`, { cause: error });
  }
  if (expectedRoot !== resolvedRoot) {
    throw new Error(
      `Skill root does not match sourcePath ${sourcePath}: ${resolvedRoot}`,
    );
  }

  const tracked = readExactTrackedEntries(repositoryRoot, revision, sourcePath);
  const trackedPaths = new Set(tracked.map((entry) => entry.relative));
  const untracked = filesystemLeaves(resolvedRoot, sourcePath === '.')
    .filter((relative) => !trackedPaths.has(relative));
  const toRepositoryRelative = (relative: string): string => (
    sourcePath === '.' ? relative : path.posix.join(sourcePath, relative)
  );
  const nestedControls = untracked
    .map(toRepositoryRelative)
    .filter(containsNestedControlPath);
  if (nestedControls.length > 0) {
    throw new Error(
      `exact Skill contains untracked nested control content: ${nestedControls[0]}`,
    );
  }
  const repositoryCandidates = untracked.map(toRepositoryRelative);
  const ignored = ignoredByExactPinnedGitignore(
    repositoryRoot,
    revision,
    repositoryCandidates,
  );
  const unsafeUntracked = repositoryCandidates.filter((relative) => !ignored.has(relative));
  if (unsafeUntracked.length > 0) {
    throw new Error(
      `exact Skill contains content outside pinned revision: ${unsafeUntracked[0]}`,
    );
  }

  return hashTrackedEntries(resolvedRoot, tracked, true);
}

export function hashSkillSubtree(
  root: string,
  options: HashSkillSubtreeOptions = {},
): SkillSubtreeDigest {
  const resolvedRoot = assertDirectory(root);
  if (options.sourcePath !== undefined) {
    return hashExactTrackedSubtree(resolvedRoot, options.revision, options.sourcePath);
  }
  return options.rootSkill
    ? hashTrackedRoot(resolvedRoot, options.revision)
    : hashFilesystemTree(resolvedRoot);
}

/**
 * Hash a Skill directly from a pinned Git object graph.
 *
 * This is the post-commit validation surface: the repository worktree may be
 * at a later revision because a self-hosted Lock commit must pin its preceding
 * canonical-content commit. Authoring must continue to use `hashSkillSubtree`
 * with `{ revision, sourcePath }`, which requires the exact checkout and a
 * clean worktree.
 */
export function hashSkillSubtreeAtRevision(
  repositoryRootInput: string,
  options: HashSkillSubtreeAtRevisionOptions,
): SkillSubtreeDigest {
  const repositoryRoot = assertDirectory(repositoryRootInput);
  const sourcePath = assertPortableSourcePath(options.sourcePath);
  let resolvedGitRoot: string;
  try {
    resolvedGitRoot = fs.realpathSync(execFileSync(
      'git',
      ['-C', repositoryRoot, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim());
  } catch (error) {
    throw new Error('pinned Skill validation requires a Git worktree', { cause: error });
  }
  if (resolvedGitRoot !== repositoryRoot) {
    throw new Error('pinned Skill validation requires the Git worktree root');
  }
  resolvePinnedCommit(repositoryRoot, options.revision);
  const tracked = readExactTrackedEntries(
    repositoryRoot,
    options.revision,
    sourcePath,
  );
  return hashPinnedTrackedEntries(repositoryRoot, tracked);
}
