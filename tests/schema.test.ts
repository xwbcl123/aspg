import { describe, it, expect } from 'vitest';
import { SkillFrontmatterSchema, isVendorField } from '../src/schema.js';

describe('SkillFrontmatterSchema', () => {
  it('should accept valid minimal frontmatter', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'test_skill',
      description: 'A test skill',
    });
    expect(result.success).toBe(true);
  });

  it('should accept full frontmatter with aspg namespace', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'deep_research',
      description: 'Deep research skill',
      version: '1.0.0',
      author: 'Martin',
      tags: ['research', 'web'],
      aspg: {
        requirements: {
          tools: ['bash', 'node'],
          env: ['API_KEY'],
        },
        origin: {
          vendor: 'claude',
          imported_at: '2026-03-03',
          source_version: '1.2.0',
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('should reject missing name', () => {
    const result = SkillFrontmatterSchema.safeParse({
      description: 'A test skill',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing description', () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: 'test',
    });
    expect(result.success).toBe(false);
  });
});

describe('isVendorField', () => {
  it('should detect claude-prefixed fields', () => {
    expect(isVendorField('claude_model')).toBe(true);
    expect(isVendorField('claude_config')).toBe(true);
    expect(isVendorField('claude-settings')).toBe(true);
  });

  it('should detect gemini/codex fields', () => {
    expect(isVendorField('gemini_mode')).toBe(true);
    expect(isVendorField('codex_runtime')).toBe(true);
  });

  it('should detect model_config', () => {
    expect(isVendorField('model_config')).toBe(true);
  });

  it('should not flag standard fields', () => {
    expect(isVendorField('name')).toBe(false);
    expect(isVendorField('description')).toBe(false);
    expect(isVendorField('version')).toBe(false);
    expect(isVendorField('custom_user_field')).toBe(false);
  });
});
