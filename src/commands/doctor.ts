/**
 * aspg doctor — Topology & link health check
 * Only checks filesystem structure. Does NOT check env/deps (that's compat's job).
 */
import fs from 'node:fs';
import path from 'node:path';
import { getLinkMethod, isValidLink, isCopyInSync } from '../platform.js';

const SSOT_DIR = '.agents/skills';
const VENDOR_LINKS: Record<string, string> = {
  claude: '.claude/skills',
  opencode: '.opencode/skills',
  codex: '.codex/skills',
};

export async function doctorCommand(): Promise<void> {
  const root = process.cwd();
  const ssotPath = path.join(root, SSOT_DIR);
  let hasIssues = false;

  console.log('ASPG Doctor — Topology Health Check\n');

  // 1. Check SSOT directory
  if (!fs.existsSync(ssotPath)) {
    console.error(`✗ ${SSOT_DIR}/ not found`);
    process.exitCode = 1;
    return;
  }
  const skills = fs.readdirSync(ssotPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  console.log(`✓ ${SSOT_DIR}/ exists (${skills.length} skill(s))`);

  // 2. Check vendor links
  for (const [vendor, linkDir] of Object.entries(VENDOR_LINKS)) {
    const linkPath = path.join(root, linkDir);

    if (!fs.existsSync(linkPath) && !isStaleLink(linkPath)) {
      console.log(`· ${linkDir} — not created (${vendor})`);
      continue;
    }

    const method = getLinkMethod(linkPath);
    if (!method) {
      console.error(`✗ ${linkDir} — exists but not ASPG-managed (${vendor})`);
      hasIssues = true;
      continue;
    }

    if (method === 'copy') {
      // Check copy is in sync
      if (isCopyInSync(linkPath, ssotPath)) {
        console.log(`✓ ${linkDir} — copy fallback, in sync (${vendor})`);
      } else {
        console.error(`✗ ${linkDir} — copy fallback, OUT OF SYNC (${vendor})`);
        console.error(`  Run "aspg apply" to refresh`);
        hasIssues = true;
      }
      continue;
    }

    // Symlink/junction — check it's valid
    if (isValidLink(linkPath, ssotPath)) {
      console.log(`✓ ${linkDir} → valid [${method}] (${vendor})`);
    } else {
      console.error(`✗ ${linkDir} — broken link (${vendor})`);
      console.error(`  Run "aspg apply" to fix`);
      hasIssues = true;
    }
  }

  // 3. Check for orphan vendor skills
  console.log('');
  for (const [vendor, linkDir] of Object.entries(VENDOR_LINKS)) {
    const linkPath = path.join(root, linkDir);
    if (!fs.existsSync(linkPath)) continue;

    // For symlinks, orphans are impossible (same directory)
    const method = getLinkMethod(linkPath);
    if (method === 'symlink') continue;

    // For copies, check for extra files
    if (method === 'copy') {
      const copyFiles = fs.readdirSync(linkPath)
        .filter((f) => f !== '.aspg-copy-fallback');
      const ssotSkills = new Set(skills);
      for (const item of copyFiles) {
        if (!ssotSkills.has(item)) {
          console.warn(`⚠ ${linkDir}/${item} — orphan (not in SSOT) [${vendor}]`);
          hasIssues = true;
        }
      }
    }
  }

  // Summary
  console.log('');
  if (hasIssues) {
    console.error('✗ Issues found — run "aspg apply" to fix');
    process.exitCode = 1;
  } else {
    console.log('✓ Topology is healthy');
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
