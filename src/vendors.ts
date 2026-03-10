/**
 * vendors.ts — Vendor registry and classification
 * Single source of truth for vendor definitions and SSOT path.
 */

export type VendorMode = 'native' | 'bridge';

export interface VendorDef {
  linkDir: string;
  mode: VendorMode;
}

/** Canonical SSOT directory for all skills */
export const SSOT_DIR = '.agents/skills';

/**
 * Vendor registry — the only place vendor definitions live.
 *
 * - native: vendor already discovers .agents/skills directly
 * - bridge: vendor needs a vendor-local symlink/copy
 */
export const VENDOR_REGISTRY: Readonly<Record<string, VendorDef>> = {
  claude:   { linkDir: '.claude/skills',   mode: 'bridge' },
  opencode: { linkDir: '.opencode/skills', mode: 'native' },
  codex:    { linkDir: '.codex/skills',    mode: 'native' },
};

/** Look up a single vendor definition */
export function getVendor(name: string): VendorDef | undefined {
  return VENDOR_REGISTRY[name];
}

/** Return only bridge vendors as { name: linkDir } */
export function getBridgeVendors(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, def] of Object.entries(VENDOR_REGISTRY)) {
    if (def.mode === 'bridge') {
      result[name] = def.linkDir;
    }
  }
  return result;
}

/** Return only native vendors as { name: linkDir } */
export function getNativeVendors(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, def] of Object.entries(VENDOR_REGISTRY)) {
    if (def.mode === 'native') {
      result[name] = def.linkDir;
    }
  }
  return result;
}

/** Check if a vendor is classified as native */
export function isNativeVendor(name: string): boolean {
  return VENDOR_REGISTRY[name]?.mode === 'native';
}
