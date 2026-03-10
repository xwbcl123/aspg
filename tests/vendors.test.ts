import { describe, it, expect } from 'vitest';
import {
  SSOT_DIR,
  VENDOR_REGISTRY,
  getVendor,
  getBridgeVendors,
  getNativeVendors,
  isNativeVendor,
} from '../src/vendors.js';

describe('VENDOR_REGISTRY', () => {
  it('should contain claude, opencode, and codex', () => {
    expect(Object.keys(VENDOR_REGISTRY)).toEqual(
      expect.arrayContaining(['claude', 'opencode', 'codex']),
    );
    expect(Object.keys(VENDOR_REGISTRY)).toHaveLength(3);
  });

  it('should have correct modes', () => {
    expect(VENDOR_REGISTRY.claude.mode).toBe('bridge');
    expect(VENDOR_REGISTRY.opencode.mode).toBe('native');
    expect(VENDOR_REGISTRY.codex.mode).toBe('native');
  });
});

describe('SSOT_DIR', () => {
  it('should be .agents/skills', () => {
    expect(SSOT_DIR).toBe('.agents/skills');
  });
});

describe('getVendor', () => {
  it('should return VendorDef for known vendors', () => {
    const codex = getVendor('codex');
    expect(codex).toEqual({ linkDir: '.codex/skills', mode: 'native' });
  });

  it('should return undefined for unknown vendors', () => {
    expect(getVendor('unknown')).toBeUndefined();
  });
});

describe('getBridgeVendors', () => {
  it('should return only bridge vendors', () => {
    const bridges = getBridgeVendors();
    expect(Object.keys(bridges)).toEqual(['claude']);
    expect(bridges.claude).toBe('.claude/skills');
  });

  it('should return a new object each call (immutability)', () => {
    const a = getBridgeVendors();
    const b = getBridgeVendors();
    expect(a).not.toBe(b);
    // Mutating the result should not affect next call
    a.claude = 'mutated';
    expect(getBridgeVendors().claude).toBe('.claude/skills');
  });
});

describe('getNativeVendors', () => {
  it('should return only native vendors', () => {
    const natives = getNativeVendors();
    expect(Object.keys(natives)).toEqual(
      expect.arrayContaining(['opencode', 'codex']),
    );
    expect(Object.keys(natives)).toHaveLength(2);
  });

  it('should return a new object each call (immutability)', () => {
    const a = getNativeVendors();
    const b = getNativeVendors();
    expect(a).not.toBe(b);
    a.codex = 'mutated';
    expect(getNativeVendors().codex).toBe('.codex/skills');
  });
});

describe('isNativeVendor', () => {
  it('should return true for native vendors', () => {
    expect(isNativeVendor('codex')).toBe(true);
    expect(isNativeVendor('opencode')).toBe(true);
  });

  it('should return false for bridge vendors', () => {
    expect(isNativeVendor('claude')).toBe(false);
  });

  it('should return false for unknown vendors', () => {
    expect(isNativeVendor('unknown')).toBe(false);
  });
});
