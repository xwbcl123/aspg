/**
 * Deterministic per-Skill subtree hashing.
 *
 * The digest includes entry type, portable relative path, bytes (or symlink
 * target bytes) and the regular-file executable bit.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface SkillSubtreeDigest {
  tree_hash: string;
  executable_files: string[];
}

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

export function hashSkillSubtree(root: string): SkillSubtreeDigest {
  const resolvedRoot = fs.realpathSync(root);
  if (!fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Skill subtree is not a directory: ${root}`);
  }

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
