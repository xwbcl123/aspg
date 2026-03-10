/**
 * aspg clean — Remove all ASPG-generated artifacts
 * GUARANTEE: .agents/skills/ is NEVER deleted.
 * Traverses all vendors (including native) to clean up legacy bridges.
 */
import fs from 'node:fs';
import path from 'node:path';
import { removeLink, isStaleLink, isAspgManaged } from '../platform.js';
import { SSOT_DIR, VENDOR_REGISTRY } from '../vendors.js';

interface CleanOptions {
  dryRun?: boolean;
}

export async function cleanCommand(opts: CleanOptions = {}): Promise<void> {
  const { dryRun = false } = opts;
  const root = process.cwd();

  if (dryRun) console.log('[dry-run] No changes will be made.\n');

  let removed = 0;

  // Iterate all vendors — native vendors may have legacy bridges to clean
  for (const [vendor, def] of Object.entries(VENDOR_REGISTRY)) {
    const linkPath = path.join(root, def.linkDir);

    if (!fs.existsSync(linkPath) && !isStaleLink(linkPath)) {
      continue;
    }

    if (dryRun) {
      if (isAspgManaged(linkPath)) {
        console.log(`[dry-run] Would remove ${def.linkDir} (${vendor})`);
        removed++;
      } else {
        console.log(`[dry-run] Would skip ${def.linkDir} — not ASPG-managed (${vendor})`);
      }
      continue;
    }

    const didRemove = removeLink(linkPath);
    if (didRemove) {
      console.log(`✓ Removed ${def.linkDir} (${vendor})`);
      removed++;
    } else {
      console.log(`⚠ ${def.linkDir} exists but is not ASPG-managed — skipped (${vendor})`);
    }
  }

  if (removed === 0 && !dryRun) {
    console.log('Nothing to clean.');
  }

  // Gemini hint
  console.log('');
  console.log('💡 Gemini: Run manually → gemini skills unlink');

  // Confirm SSOT safety
  const ssotPath = path.join(root, SSOT_DIR);
  if (fs.existsSync(ssotPath)) {
    console.log(`\n✓ ${SSOT_DIR}/ preserved (${fs.readdirSync(ssotPath).length} items)`);
  }
}
