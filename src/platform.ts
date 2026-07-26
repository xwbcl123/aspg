/**
 * platform.ts — fail-closed cross-platform link and bridge utilities.
 *
 * On darwin/linux ASPG creates links only. Windows may explicitly degrade from
 * symlink to junction and then to a marked physical copy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const COPY_MARKER = '.aspg-copy-fallback';
export const LINK_MARKER_SUFFIX = '.aspg-managed-link.json';

export type LinkMethod = 'symlink' | 'junction' | 'copy';

export interface LinkResult {
  method: LinkMethod;
  target: string;
  link: string;
}

export interface CreateLinkOptions {
  dryRun?: boolean;
  platform?: NodeJS.Platform;
}

interface ManagedLinkRecord {
  version: 1;
  target: string;
  method: Exclude<LinkMethod, 'copy'>;
}

export class LinkSafetyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'LinkSafetyError';
  }
}

function lstatIfPresent(targetPath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function managedMarkerPath(linkPath: string): string {
  return `${linkPath}${LINK_MARKER_SUFFIX}`;
}

function resolveRawLinkTarget(linkPath: string): string {
  const rawTarget = fs.readlinkSync(linkPath);
  return path.resolve(path.dirname(linkPath), rawTarget);
}

function readManagedRecord(linkPath: string): ManagedLinkRecord | undefined {
  const markerPath = managedMarkerPath(linkPath);
  const markerStat = lstatIfPresent(markerPath);
  if (!markerStat?.isFile()) return undefined;

  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as Partial<ManagedLinkRecord>;
    if (
      parsed.version !== 1
      || typeof parsed.target !== 'string'
      || !['symlink', 'junction'].includes(parsed.method ?? '')
    ) {
      return undefined;
    }
    return {
      version: 1,
      target: path.resolve(parsed.target),
      method: parsed.method as Exclude<LinkMethod, 'copy'>,
    };
  } catch {
    return undefined;
  }
}

function managedSymlinkRecord(linkPath: string): ManagedLinkRecord | undefined {
  const stat = lstatIfPresent(linkPath);
  if (!stat?.isSymbolicLink()) return undefined;
  const record = readManagedRecord(linkPath);
  if (!record) return undefined;
  try {
    return resolveRawLinkTarget(linkPath) === record.target ? record : undefined;
  } catch {
    return undefined;
  }
}

function writeManagedRecord(markerPath: string, record: ManagedLinkRecord): void {
  fs.writeFileSync(markerPath, `${JSON.stringify(record)}\n`, {
    encoding: 'utf-8',
    flag: 'wx',
    mode: 0o600,
  });
}

function temporarySibling(linkPath: string, label: string): string {
  return path.join(
    path.dirname(linkPath),
    `.${path.basename(linkPath)}.aspg-${label}-${process.pid}-${randomUUID()}`,
  );
}

function cleanupTemporary(targetPath: string): void {
  const stat = lstatIfPresent(targetPath);
  if (!stat) return;
  if (stat.isSymbolicLink() || stat.isFile()) {
    fs.unlinkSync(targetPath);
    return;
  }
  // Recursive cleanup is restricted to ASPG's unique temporary path.
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function assertTargetDirectory(absTarget: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absTarget);
  } catch (error) {
    throw new LinkSafetyError(
      'ASPG_LINK_TARGET_NOT_DIRECTORY',
      `link target is missing or inaccessible: ${absTarget}`,
      { cause: error },
    );
  }
  if (!stat.isDirectory()) {
    throw new LinkSafetyError(
      'ASPG_LINK_TARGET_NOT_DIRECTORY',
      `link target is not a directory: ${absTarget}`,
    );
  }
}

type ExistingDestination =
  | { kind: 'absent' }
  | { kind: 'managed-link'; record: ManagedLinkRecord }
  | { kind: 'copy'; target?: string }
  | { kind: 'foreign-link' }
  | { kind: 'directory' }
  | { kind: 'file' };

function inspectDestination(linkPath: string): ExistingDestination {
  const stat = lstatIfPresent(linkPath);
  if (!stat) return { kind: 'absent' };
  if (stat.isSymbolicLink()) {
    const record = managedSymlinkRecord(linkPath);
    return record ? { kind: 'managed-link', record } : { kind: 'foreign-link' };
  }
  if (stat.isDirectory()) {
    const markerPath = path.join(linkPath, COPY_MARKER);
    if (lstatIfPresent(markerPath)?.isFile()) {
      try {
        return {
          kind: 'copy',
          target: path.resolve(fs.readFileSync(markerPath, 'utf-8').trim()),
        };
      } catch {
        return { kind: 'copy' };
      }
    }
    return { kind: 'directory' };
  }
  return { kind: 'file' };
}

function refusalForDestination(absLink: string, destination: ExistingDestination): never {
  switch (destination.kind) {
    case 'foreign-link':
      throw new LinkSafetyError(
        'ASPG_LINK_DESTINATION_FOREIGN_LINK',
        `refusing to replace an unrecorded or marker-mismatched link: ${absLink}`,
      );
    case 'directory':
    case 'copy':
      throw new LinkSafetyError(
        'ASPG_LINK_DESTINATION_REAL_DIRECTORY',
        `refusing to merge into or replace a real directory: ${absLink}`,
      );
    case 'file':
      throw new LinkSafetyError(
        'ASPG_LINK_DESTINATION_FILE',
        `refusing to replace a file: ${absLink}`,
      );
    default:
      throw new LinkSafetyError(
        'ASPG_LINK_DESTINATION_CHANGED',
        `link destination changed during activation: ${absLink}`,
      );
  }
}

function sameDestination(
  left: ExistingDestination,
  right: ExistingDestination,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'absent' && right.kind === 'absent') return true;
  if (left.kind === 'managed-link' && right.kind === 'managed-link') {
    return left.record.method === right.record.method
      && left.record.target === right.record.target;
  }
  return false;
}

function createTemporaryLink(
  absTarget: string,
  tempLink: string,
  platform: NodeJS.Platform,
): Exclude<LinkMethod, 'copy'> | 'copy' {
  try {
    fs.symlinkSync(absTarget, tempLink, 'dir');
    return 'symlink';
  } catch (symlinkError) {
    if (platform !== 'win32') {
      throw new LinkSafetyError(
        'ASPG_LINK_SYMLINK_CREATE_FAILED',
        `symlink creation failed; copy fallback is forbidden on ${platform}`,
        { cause: symlinkError },
      );
    }
  }

  try {
    fs.symlinkSync(absTarget, tempLink, 'junction');
    return 'junction';
  } catch {
    // Explicit Windows-only degradation.
  }

  copyDirSync(absTarget, tempLink);
  fs.writeFileSync(path.join(tempLink, COPY_MARKER), absTarget, 'utf-8');
  return 'copy';
}

/**
 * Create or replace an ASPG-managed directory link.
 *
 * Safety:
 * - target must resolve to a directory;
 * - destination must be absent or carry a valid ASPG sidecar record;
 * - unmanaged directories, files, copy fallbacks and foreign links are refused;
 * - the new link is created at a unique same-directory path and renamed;
 * - darwin/linux never degrade to copy.
 */
export async function createLink(
  target: string,
  linkPath: string,
  dryRunOrOptions: boolean | CreateLinkOptions = false,
): Promise<LinkResult> {
  const options = typeof dryRunOrOptions === 'boolean'
    ? { dryRun: dryRunOrOptions }
    : dryRunOrOptions;
  const dryRun = options.dryRun ?? false;
  const platform = options.platform ?? process.platform;
  const absTarget = path.resolve(target);
  const absLink = path.resolve(linkPath);

  assertTargetDirectory(absTarget);

  const initial = inspectDestination(absLink);
  const markerPath = managedMarkerPath(absLink);

  if (initial.kind === 'managed-link' && initial.record.target === absTarget) {
    return { method: initial.record.method, target: absTarget, link: absLink };
  }
  if (!['absent', 'managed-link'].includes(initial.kind)) {
    refusalForDestination(absLink, initial);
  }
  if (initial.kind === 'absent' && lstatIfPresent(markerPath)) {
    throw new LinkSafetyError(
      'ASPG_LINK_ORPHAN_MARKER',
      `refusing activation while an orphan managed-link marker exists: ${markerPath}`,
    );
  }

  if (dryRun) {
    return { method: 'symlink', target: absTarget, link: absLink };
  }

  fs.mkdirSync(path.dirname(absLink), { recursive: true });

  const tempLink = temporarySibling(absLink, 'link');
  const tempMarker = temporarySibling(absLink, 'marker');
  let method: LinkMethod | undefined;
  let activated = false;
  const previousRawTarget = initial.kind === 'managed-link'
    ? fs.readlinkSync(absLink)
    : undefined;

  try {
    method = createTemporaryLink(absTarget, tempLink, platform);
    if (method !== 'copy') {
      writeManagedRecord(tempMarker, {
        version: 1,
        target: absTarget,
        method,
      });
    }

    const beforeRename = inspectDestination(absLink);
    if (!sameDestination(initial, beforeRename)) {
      throw new LinkSafetyError(
        'ASPG_LINK_DESTINATION_CHANGED',
        `link destination changed during activation: ${absLink}`,
      );
    }

    try {
      fs.renameSync(tempLink, absLink);
      activated = true;
    } catch (error) {
      throw new LinkSafetyError(
        'ASPG_LINK_ATOMIC_RENAME_FAILED',
        `atomic link activation failed: ${absLink}`,
        { cause: error },
      );
    }

    if (method !== 'copy') {
      try {
        fs.renameSync(tempMarker, markerPath);
      } catch (error) {
        // Roll back link activation so callers never observe a successful
        // unrecorded ASPG link after this function returns an error.
        fs.unlinkSync(absLink);
        if (initial.kind === 'managed-link' && previousRawTarget !== undefined) {
          fs.symlinkSync(previousRawTarget, absLink, initial.record.method === 'junction'
            ? 'junction'
            : 'dir');
        }
        activated = false;
        throw new LinkSafetyError(
          'ASPG_LINK_MARKER_ACTIVATION_FAILED',
          `managed-link marker activation failed; previous link restored: ${absLink}`,
          { cause: error },
        );
      }
    }

    return { method, target: absTarget, link: absLink };
  } finally {
    cleanupTemporary(tempLink);
    cleanupTemporary(tempMarker);
    if (!activated && initial.kind === 'absent') {
      // A failed first activation must leave no destination or sidecar.
      const current = lstatIfPresent(absLink);
      if (current?.isSymbolicLink()) fs.unlinkSync(absLink);
      if (lstatIfPresent(markerPath)?.isFile()) fs.unlinkSync(markerPath);
    }
  }
}

/**
 * Remove only a sidecar-recorded ASPG symlink/junction.
 *
 * Real directories — including legacy copy fallbacks — are never recursively
 * deleted by this primitive.
 */
export function removeLink(linkPath: string, dryRun = false): boolean {
  const absLink = path.resolve(linkPath);
  const record = managedSymlinkRecord(absLink);
  if (!record) return false;
  if (dryRun) return true;

  const markerPath = managedMarkerPath(absLink);
  const parkedMarker = temporarySibling(absLink, 'remove-marker');
  fs.renameSync(markerPath, parkedMarker);
  try {
    fs.unlinkSync(absLink);
  } catch (error) {
    fs.renameSync(parkedMarker, markerPath);
    throw new LinkSafetyError(
      'ASPG_LINK_REMOVE_FAILED',
      `managed link removal failed; marker restored: ${absLink}`,
      { cause: error },
    );
  }
  fs.unlinkSync(parkedMarker);
  return true;
}

/** Check whether a link resolves to the expected target. */
export function isValidLink(linkPath: string, expectedTarget: string): boolean {
  const absLink = path.resolve(linkPath);
  const absTarget = path.resolve(expectedTarget);
  const stat = lstatIfPresent(absLink);
  if (!stat?.isSymbolicLink()) return false;
  try {
    return fs.realpathSync(absLink) === fs.realpathSync(absTarget);
  } catch {
    return false;
  }
}

/** Return the current link method, including broken symbolic links. */
export function getLinkMethod(linkPath: string): LinkMethod | null {
  const absLink = path.resolve(linkPath);
  const stat = lstatIfPresent(absLink);
  if (!stat) return null;
  if (stat.isSymbolicLink()) {
    return readManagedRecord(absLink)?.method ?? 'symlink';
  }
  if (stat.isDirectory() && lstatIfPresent(path.join(absLink, COPY_MARKER))?.isFile()) {
    return 'copy';
  }
  return null;
}

/** Check whether a marked Windows copy fallback matches the SSOT contents. */
export function isCopyInSync(copyPath: string, ssotPath: string): boolean {
  const absCopy = path.resolve(copyPath);
  const absSsot = path.resolve(ssotPath);
  const marker = path.join(absCopy, COPY_MARKER);
  if (!lstatIfPresent(marker)?.isFile()) return false;
  if (path.resolve(fs.readFileSync(marker, 'utf-8').trim()) !== absSsot) return false;

  try {
    const ssotFiles = getFileList(absSsot, { ignoreCopyMarker: true });
    const copyFiles = getFileList(absCopy, { ignoreCopyMarker: true });
    if (ssotFiles.length !== copyFiles.length) return false;
    for (let index = 0; index < ssotFiles.length; index += 1) {
      if (ssotFiles[index] !== copyFiles[index]) return false;
      const src = fs.readFileSync(path.join(absSsot, ssotFiles[index]));
      const dst = fs.readFileSync(path.join(absCopy, copyFiles[index]));
      if (!src.equals(dst)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function hasCopyMarker(dir: string): boolean {
  return lstatIfPresent(path.join(path.resolve(dir), COPY_MARKER))?.isFile() ?? false;
}

export function removeCopyMarker(dir: string, dryRun = false): boolean {
  const markerPath = path.join(path.resolve(dir), COPY_MARKER);
  if (!lstatIfPresent(markerPath)?.isFile()) return false;
  if (dryRun) return true;
  fs.unlinkSync(markerPath);
  return true;
}

/**
 * Refresh an explicit Windows copy fallback.
 *
 * Existing directories must carry a marker matching the requested target.
 * Copy fallback is rejected on darwin/linux.
 */
export function syncCopyFallback(
  target: string,
  copyPath: string,
  dryRun = false,
  platform: NodeJS.Platform = process.platform,
): void {
  const absTarget = path.resolve(target);
  const absCopy = path.resolve(copyPath);
  assertTargetDirectory(absTarget);
  if (platform !== 'win32') {
    throw new LinkSafetyError(
      'ASPG_LINK_COPY_UNSUPPORTED',
      `copy fallback refresh is forbidden on ${platform}: ${absCopy}`,
    );
  }

  const destination = inspectDestination(absCopy);
  if (
    destination.kind !== 'absent'
    && !(destination.kind === 'copy' && destination.target === absTarget)
  ) {
    refusalForDestination(absCopy, destination);
  }
  if (dryRun) return;

  if (destination.kind === 'absent') fs.mkdirSync(absCopy, { recursive: true });
  syncDirContents(absTarget, absCopy);
  fs.writeFileSync(path.join(absCopy, COPY_MARKER), absTarget, 'utf-8');
}

/** Return directory entries, following symlinks to directory targets. */
export function listLinkedDirectories(dir: string): string[] {
  if (!lstatIfPresent(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => {
      if (entry.isDirectory()) return true;
      if (!entry.isSymbolicLink()) return false;
      try {
        return fs.statSync(path.join(dir, entry.name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((entry) => entry.name)
    .sort();
}

/** Check whether a path is a sidecar-recorded ASPG symlink/junction. */
export function isAspgManaged(linkPath: string): boolean {
  return managedSymlinkRecord(path.resolve(linkPath)) !== undefined;
}

/** Check if lstat sees an entry, including a dangling symbolic link. */
export function isStaleLink(targetPath: string): boolean {
  return lstatIfPresent(targetPath) !== undefined;
}

function copyDirSync(
  src: string,
  dst: string,
  activeRealDirs: Set<string> = new Set(),
): void {
  const realSrc = fs.realpathSync(src);
  if (activeRealDirs.has(realSrc)) {
    throw new LinkSafetyError(
      'ASPG_BRIDGE_SYMLINK_CYCLE',
      `refusing to copy a recursive symlink cycle: ${src}`,
    );
  }
  activeRealDirs.add(realSrc);
  fs.mkdirSync(dst, { recursive: true });
  try {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.name === COPY_MARKER) continue;
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      if (entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(srcPath).isDirectory())) {
        copyDirSync(srcPath, dstPath, activeRealDirs);
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  } finally {
    activeRealDirs.delete(realSrc);
  }
}

function getFileList(
  dir: string,
  opts: { ignoreCopyMarker?: boolean } = {},
  prefix = '',
  activeRealDirs: Set<string> = new Set(),
): string[] {
  if (!lstatIfPresent(dir)) return [];
  const realDir = fs.realpathSync(dir);
  if (activeRealDirs.has(realDir)) {
    throw new LinkSafetyError(
      'ASPG_BRIDGE_SYMLINK_CYCLE',
      `refusing to traverse a recursive symlink cycle: ${dir}`,
    );
  }
  activeRealDirs.add(realDir);
  const entries: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (opts.ignoreCopyMarker && entry.name === COPY_MARKER) continue;
      const fullPath = path.join(dir, entry.name);
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(fullPath).isDirectory())) {
        entries.push(...getFileList(fullPath, opts, relative, activeRealDirs));
      } else {
        entries.push(relative);
      }
    }
  } finally {
    activeRealDirs.delete(realDir);
  }
  return entries.sort();
}

function syncDirContents(src: string, dst: string): void {
  const srcEntries = fs.readdirSync(src, { withFileTypes: true })
    .filter((entry) => entry.name !== COPY_MARKER);
  const srcNames = new Set(srcEntries.map((entry) => entry.name));

  for (const entry of fs.readdirSync(dst, { withFileTypes: true })) {
    if (entry.name === COPY_MARKER) continue;
    if (!srcNames.has(entry.name)) {
      fs.rmSync(path.join(dst, entry.name), { recursive: true, force: true });
    }
  }

  for (const entry of srcEntries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    const sourceIsDirectory = entry.isDirectory()
      || (entry.isSymbolicLink() && fs.statSync(srcPath).isDirectory());
    const dstStat = lstatIfPresent(dstPath);

    if (sourceIsDirectory) {
      if (dstStat && !dstStat.isDirectory()) {
        cleanupTemporary(dstPath);
      }
      fs.mkdirSync(dstPath, { recursive: true });
      syncDirContents(srcPath, dstPath);
    } else {
      if (dstStat?.isDirectory()) {
        fs.rmSync(dstPath, { recursive: true, force: true });
      } else if (dstStat?.isSymbolicLink()) {
        fs.unlinkSync(dstPath);
      }
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}
