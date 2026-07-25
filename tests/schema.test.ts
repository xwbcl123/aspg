import { describe, it, expect } from 'vitest';
import { SkillFrontmatterSchema, isVendorField } from '../src/schema.js';
import {
  DeviceRegistrySchema,
  ProjectLockSchema,
  ProjectManifestSchema,
} from '../src/profile-schema.js';

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

describe('Foundation Profile schemas', () => {
  it('accepts a portable mixed-mode manifest', () => {
    const result = ProjectManifestSchema.safeParse({
      version: 1,
      project: 'demo',
      command_maturity: { profile_plan: 'mvp', profile_apply: 'future' },
      concurrency: {
        mode: 'stable-core-catalog-on-demand',
        hot_switch_shared_runtime: false,
        activation_lock: '.aspg/profile-activation.lock',
      },
      core: ['local-core'],
      sources: {
        project: { kind: 'project-local', path: '.' },
        shared: {
          kind: 'git',
          repository: 'https://example.invalid/shared.git',
          revision: 'abc123',
          privacy: 'third-party',
        },
      },
      skills: {
        'local-core': {
          source: 'project',
          path: '.agents/skills/local-core',
          ownership: 'project-local',
          description_chars: 80,
        },
        shared: {
          source: 'shared',
          path: 'skills/shared',
          ownership: 'managed-link',
          description_chars: 120,
          capabilities: ['research'],
        },
      },
      profiles: {
        research: {
          include: ['shared'],
          budgets: { max_skills: 4, max_description_chars: 500 },
        },
      },
      runtimes: {
        codex: { replacements: { slides: 'presentations-plugin' } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a git source without a repository', () => {
    const result = ProjectManifestSchema.safeParse({
      version: 1,
      project: 'broken',
      command_maturity: { profile_plan: 'mvp', profile_apply: 'future' },
      concurrency: {
        mode: 'stable-core-catalog-on-demand',
        hot_switch_shared_runtime: false,
        activation_lock: '.aspg/profile-activation.lock',
      },
      sources: { shared: { kind: 'git' } },
      skills: {},
      profiles: {},
    });
    expect(result.success).toBe(false);
  });

  it('accepts portable lock and device-local registry contracts', () => {
    expect(ProjectLockSchema.safeParse({
      version: 1,
      sources: { shared: { revision: 'abc123', tree_hash: 'sha256:1234' } },
      managed: {},
    }).success).toBe(true);

    expect(DeviceRegistrySchema.safeParse({
      version: 1,
      devices: {
        macbook: {
          platform: 'darwin',
          source_roots: { shared: '/opt/skills/shared' },
          backends: {
            'managed-link': 'symlink',
            'managed-materialized': 'materialize',
          },
        },
      },
    }).success).toBe(true);
  });
});
