/**
 * platform.ts — Cross-platform symlink/junction/copy utilities
 * Handles Windows Developer Mode limitations gracefully.
 */
import fs from 'node:fs';
import path from 'node:path';

const COPY_MARKER = '.aspg-copy-fallback';

export type LinkMethod = 'symlink' | 'junction' | 'copy';

export interface LinkResult {
  method: LinkMethod;
  target: string;
  link: string;
}

/**
 * Create a directory link with Windows degradation:
 * 1. symlink('dir') — needs Developer Mode or admin
 * 2. junction — no special permissions, dir only
 * 3. Physical copy + marker file
 */
export async function createLink(
  target: string,
  linkPath: string,
  dryRun = false,
): Promise<LinkResult> {
  const absTarget = path.resolve(target);
  const absLink = path.resolve(linkPath);

  if (dryRun) {
    return { method: 'symlink', target: absTarget, link: absLink };
  }

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(absLink), { recursive: true });

  // Try symlink first
  try {
    fs.symlinkSync(absTarget, absLink, 'dir');
    return { method: 'symlink', target: absTarget, link: absLink };
  } catch {
    // Fall through to junction
  }

  // Try junction (Windows only, no special perms needed)
  if (process.platform === 'win32') {
    try {
      fs.symlinkSync(absTarget, absLink, 'junction');
      return { method: 'junction', target: absTarget, link: absLink };
    } catch {
      // Fall through to copy
    }
  }

  // Fallback: physical copy
  copyDirSync(absTarget, absLink);
  fs.writeFileSync(path.join(absLink, COPY_MARKER), absTarget, 'utf-8');
  return { method: 'copy', target: absTarget, link: absLink };
}

/**
 * Remove a link/junction/copy created by ASPG.
 * Returns true if something was removed.
 */
export function removeLink(linkPath: string, dryRun = false): boolean {
  const absLink = path.resolve(linkPath);

  if (!fs.existsSync(absLink)) return false;

  if (dryRun) return true;

  const stat = fs.lstatSync(absLink);

  // Symlink or junction
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(absLink);
    return true;
  }

  // Directory with copy marker
  if (stat.isDirectory()) {
    const marker = path.join(absLink, COPY_MARKER);
    if (fs.existsSync(marker)) {
      fs.rmSync(absLink, { recursive: true, force: true });
      return true;
    }
    // No marker — not ours, don't touch
    return false;
  }

  return false;
}

/**
 * Check if a link is valid and points to the expected target.
 */
export function isValidLink(linkPath: string, expectedTarget: string): boolean {
  const absLink = path.resolve(linkPath);
  const absTarget = path.resolve(expectedTarget);

  if (!fs.existsSync(absLink)) return false;

  const stat = fs.lstatSync(absLink);

  if (stat.isSymbolicLink()) {
    try {
      const resolved = fs.realpathSync(absLink);
      return resolved === fs.realpathSync(absTarget);
    } catch {
      return false; // broken link
    }
  }

  // Copy fallback — check marker
  if (stat.isDirectory()) {
    const marker = path.join(absLink, COPY_MARKER);
    if (fs.existsSync(marker)) {
      const storedTarget = fs.readFileSync(marker, 'utf-8').trim();
      return path.resolve(storedTarget) === absTarget;
    }
  }

  return false;
}

/**
 * Get the link method currently in use for a path.
 */
export function getLinkMethod(linkPath: string): LinkMethod | null {
  const absLink = path.resolve(linkPath);
  if (!fs.existsSync(absLink)) return null;

  const stat = fs.lstatSync(absLink);
  if (stat.isSymbolicLink()) {
    // Distinguish junction from symlink on Windows
    // Node.js lstat doesn't differentiate, treat both as 'symlink'
    return 'symlink';
  }
  if (stat.isDirectory() && fs.existsSync(path.join(absLink, COPY_MARKER))) {
    return 'copy';
  }
  return null;
}

/**
 * Check if a copy fallback is in sync with SSOT.
 */
export function isCopyInSync(copyPath: string, ssotPath: string): boolean {
  const absPath = path.resolve(copyPath);
  const marker = path.join(absPath, COPY_MARKER);
  if (!fs.existsSync(marker)) return false;

  // Compare file lists (shallow)
  const ssotFiles = getFileList(ssotPath);
  const copyFiles = getFileList(absPath).filter((f) => f !== COPY_MARKER);
  if (ssotFiles.length !== copyFiles.length) return false;

  for (const file of ssotFiles) {
    const src = path.join(ssotPath, file);
    const dst = path.join(absPath, file);
    if (!fs.existsSync(dst)) return false;
    // Compare mtime as quick check
    const srcStat = fs.statSync(src);
    const dstStat = fs.statSync(dst);
    if (srcStat.mtimeMs > dstStat.mtimeMs) return false;
  }
  return true;
}

function getFileList(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) entries.push(entry.name);
    if (entry.isDirectory()) {
      for (const sub of getFileList(path.join(dir, entry.name))) {
        entries.push(path.join(entry.name, sub));
      }
    }
  }
  return entries;
}

/**
 * Check if a path is an ASPG-managed link (symlink, junction, or copy with marker).
 * Returns true if the path exists and was created by ASPG.
 */
export function isAspgManaged(linkPath: string): boolean {
  const absLink = path.resolve(linkPath);
  try {
    const stat = fs.lstatSync(absLink);
    if (stat.isSymbolicLink()) return true;
    if (stat.isDirectory()) {
      return fs.existsSync(path.join(absLink, COPY_MARKER));
    }
  } catch {
    // Path does not exist
  }
  return false;
}

/**
 * Check if a path has a dangling lstat entry (e.g. broken symlink).
 */
export function isStaleLink(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function copyDirSync(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}
