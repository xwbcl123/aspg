/**
 * aspg apply — Rescan SSOT and refresh all vendor bridges (idempotent)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLink, isValidLink, removeLink } from '../platform.js';

const SSOT_DIR = '.agents/skills';
const VENDOR_LINKS: Record<string, string> = {
  claude: '.claude/skills',
  opencode: '.opencode/skills',
  codex: '.codex/skills',
};

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

  // Scan skills
  const skills = fs.readdirSync(ssotPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  console.log(`Found ${skills.length} skill(s) in SSOT: ${skills.join(', ') || '(none)'}`);

  // Refresh vendor bridges
  for (const [vendor, linkDir] of Object.entries(VENDOR_LINKS)) {
    const linkPath = path.join(root, linkDir);

    if (isValidLink(linkPath, ssotPath)) {
      console.log(`· ${linkDir} → valid (${vendor})`);
      continue;
    }

    // Remove stale link if exists
    if (fs.existsSync(linkPath) || isStaleLink(linkPath)) {
      if (dryRun) {
        console.log(`[dry-run] Would remove stale ${linkDir}`);
      } else {
        removeLink(linkPath);
        console.log(`↻ Removed stale ${linkDir}`);
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

function isStaleLink(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
