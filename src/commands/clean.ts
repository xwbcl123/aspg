/**
 * aspg clean — Remove all ASPG-generated artifacts
 * GUARANTEE: .agents/skills/ is NEVER deleted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { removeLink } from '../platform.js';

const VENDOR_LINKS = ['.claude/skills', '.opencode/skills', '.codex/skills'];

interface CleanOptions {
  dryRun?: boolean;
}

export async function cleanCommand(opts: CleanOptions = {}): Promise<void> {
  const { dryRun = false } = opts;
  const root = process.cwd();

  if (dryRun) console.log('[dry-run] No changes will be made.\n');

  let removed = 0;

  for (const linkDir of VENDOR_LINKS) {
    const linkPath = path.join(root, linkDir);

    if (!fs.existsSync(linkPath) && !isStaleLink(linkPath)) {
      continue;
    }

    if (dryRun) {
      console.log(`[dry-run] Would remove ${linkDir}`);
      removed++;
      continue;
    }

    const didRemove = removeLink(linkPath);
    if (didRemove) {
      console.log(`✓ Removed ${linkDir}`);
      removed++;
    } else {
      console.log(`⚠ ${linkDir} exists but is not ASPG-managed — skipped`);
    }
  }

  if (removed === 0 && !dryRun) {
    console.log('Nothing to clean.');
  }

  // Gemini hint
  console.log('');
  console.log('💡 Gemini: Run manually → gemini skills unlink');

  // Confirm SSOT safety
  const ssotPath = path.join(root, '.agents/skills');
  if (fs.existsSync(ssotPath)) {
    console.log(`\n✓ .agents/skills/ preserved (${fs.readdirSync(ssotPath).length} items)`);
  }
}

function isStaleLink(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
