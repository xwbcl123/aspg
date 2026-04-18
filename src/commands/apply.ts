/**
 * aspg apply — Rescan SSOT and refresh bridge vendor links (idempotent)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLink, getLinkMethod, isCopyInSync, isValidLink, removeLink, isStaleLink, removeCopyMarker, syncCopyFallback } from '../platform.js';
import { SSOT_DIR, getBridgeVendors } from '../vendors.js';

interface ApplyOptions {
  dryRun?: boolean;
}

export async function applyCommand(opts: ApplyOptions = {}): Promise<void> {
  const { dryRun = false } = opts;
  const root = process.cwd();
  const ssotPath = path.join(root, SSOT_DIR);

  if (dryRun) console.log('[dry-run] No changes will be made.\n');

  // Check SSOT exists
  if (!fs.existsSync(ssotPath)) {
    console.error(`✗ ${SSOT_DIR}/ not found. Run "aspg init" first.`);
    process.exitCode = 2;
    return;
  }

  if (removeCopyMarker(ssotPath, dryRun)) {
    if (dryRun) {
      console.log(`[dry-run] Would remove ${SSOT_DIR}/.aspg-copy-fallback (SSOT marker pollution)`);
    } else {
      console.log(`↻ Removed ${SSOT_DIR}/.aspg-copy-fallback (SSOT marker pollution)`);
    }
  }

  // Scan skills
  const skills = fs.readdirSync(ssotPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  console.log(`Found ${skills.length} skill(s) in SSOT: ${skills.join(', ') || '(none)'}`);

  // Refresh bridge vendor links only
  for (const [vendor, linkDir] of Object.entries(getBridgeVendors())) {
    const linkPath = path.join(root, linkDir);
    const method = getLinkMethod(linkPath);

    if (method === 'copy' && isCopyInSync(linkPath, ssotPath)) {
      console.log(`· ${linkDir} — copy fallback, in sync (${vendor})`);
      continue;
    }

    if (method === 'copy') {
      if (dryRun) {
        console.log(`[dry-run] Would refresh ${linkDir} from ${SSOT_DIR}/ [copy] (${vendor})`);
      } else {
        try {
          syncCopyFallback(ssotPath, linkPath);
          console.log(`↻ Refreshed ${linkDir} from ${SSOT_DIR}/ [copy] (${vendor})`);
        } catch (err) {
          console.error(`✗ Failed to refresh ${linkDir} (${vendor}): ${(err as Error).message}`);
          process.exitCode = 2;
          return;
        }
      }
      continue;
    }

    if (isValidLink(linkPath, ssotPath)) {
      console.log(`· ${linkDir} → valid (${vendor})`);
      continue;
    }

    // Remove stale link if exists
    if (fs.existsSync(linkPath) || isStaleLink(linkPath)) {
      if (dryRun) {
        console.log(`[dry-run] Would remove stale ${linkDir}`);
      } else {
        try {
          removeLink(linkPath);
          console.log(`↻ Removed stale ${linkDir}`);
        } catch (err) {
          console.error(`✗ Failed to remove stale ${linkDir} (${vendor}): ${(err as Error).message}`);
          process.exitCode = 2;
          return;
        }
      }
    }

    // Create fresh link
    if (dryRun) {
      console.log(`[dry-run] Would create ${linkDir} → ${SSOT_DIR}/`);
    } else {
      try {
        const result = await createLink(ssotPath, linkPath);
        console.log(`✓ Created ${linkDir} → ${SSOT_DIR}/ [${result.method}] (${vendor})`);
      } catch (err) {
        console.error(`✗ Failed to create ${linkDir} (${vendor}): ${(err as Error).message}`);
        process.exitCode = 2;
        return;
      }
    }
  }

  // Gemini hint
  console.log('');
  console.log('💡 Gemini: Run manually → gemini skills link .agents/skills');
}
