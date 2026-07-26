import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import {
  PortfolioDeviceRegistrySchema,
  PortfolioDeviceRegistryV2Schema,
  PortfolioLockSchema,
  PortfolioManifestSchema,
  PortfolioSkillPathSchema,
  ProjectBindingSchema,
} from '../src/portfolio-schema.js';
import {
  migrateDeviceRegistryV1ToV2,
  migratePortfolioDocument,
} from '../src/portfolio-migrations.js';

const docsPath = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'docs',
  'portfolio-contract.md',
);

function example(markdown: string, heading: string): unknown {
  const marker = `## Example: ${heading}`;
  const start = markdown.indexOf(marker);
  if (start < 0) throw new Error(`missing docs example ${heading}`);
  const fence = markdown.indexOf('```yaml', start);
  const end = markdown.indexOf('```', fence + '```yaml'.length);
  if (fence < 0 || end < 0) throw new Error(`invalid docs example ${heading}`);
  return parse(markdown.slice(fence + '```yaml'.length, end));
}

describe('Portfolio schemas', () => {
  it('loads and validates every documented YAML example', () => {
    const markdown = fs.readFileSync(docsPath, 'utf-8');
    expect(
      PortfolioManifestSchema.parse(example(markdown, 'Portfolio Manifest')).version,
    ).toBe(1);
    expect(PortfolioLockSchema.parse(example(markdown, 'Portfolio Lock')).version).toBe(1);
    expect(ProjectBindingSchema.parse(example(markdown, 'Project Binding')).version).toBe(1);
    expect(
      PortfolioDeviceRegistrySchema.parse(example(markdown, 'Device Registry')).version,
    ).toBe(1);
    expect(
      PortfolioDeviceRegistryV2Schema.parse(
        example(markdown, 'Device Registry v2'),
      ).version,
    ).toBe(2);
  });

  it('keeps v1 as the active Device Registry reader while adding v2', () => {
    const markdown = fs.readFileSync(docsPath, 'utf-8');
    const v1 = example(markdown, 'Device Registry');
    const v2 = example(markdown, 'Device Registry v2');
    expect(PortfolioDeviceRegistrySchema.parse(v1).version).toBe(1);
    expect(PortfolioDeviceRegistryV2Schema.parse(v2).version).toBe(2);
    expect(() => PortfolioDeviceRegistrySchema.parse(v2)).toThrow();
    expect(() => PortfolioDeviceRegistryV2Schema.parse(v1)).toThrow();
  });

  it('rejects unsupported future versions for all contracts', () => {
    const markdown = fs.readFileSync(docsPath, 'utf-8');
    const cases = [
      [PortfolioManifestSchema, example(markdown, 'Portfolio Manifest')],
      [PortfolioLockSchema, example(markdown, 'Portfolio Lock')],
      [ProjectBindingSchema, example(markdown, 'Project Binding')],
      [PortfolioDeviceRegistrySchema, example(markdown, 'Device Registry')],
    ] as const;
    for (const [schema, value] of cases) {
      expect(() => schema.parse({ ...(value as Record<string, unknown>), version: 2 }))
        .toThrow();
    }
    const v2 = example(markdown, 'Device Registry v2') as Record<string, unknown>;
    expect(() => PortfolioDeviceRegistryV2Schema.parse({ ...v2, version: 3 }))
      .toThrow();
  });

  it('rejects absolute paths outside the device-local registry', () => {
    const markdown = fs.readFileSync(docsPath, 'utf-8');
    const manifest = example(markdown, 'Portfolio Manifest') as {
      skills: Record<string, { path: string }>;
    };
    manifest.skills['martin/audio-transcriber'].path = '/private/skill';
    expect(() => PortfolioManifestSchema.parse(manifest)).toThrow(/portable relative path/);

    const binding = example(markdown, 'Project Binding') as {
      portfolio: { repository: string };
    };
    binding.portfolio.repository = '/private/portfolio';
    expect(() => ProjectBindingSchema.parse(binding)).toThrow(
      /absolute paths are allowed only/,
    );
  });

  it('accepts an exact repository-root Skill path without weakening traversal checks', () => {
    expect(PortfolioSkillPathSchema.parse('.')).toBe('.');
    expect(PortfolioSkillPathSchema.parse('skills/example')).toBe('skills/example');

    for (const invalid of [
      '',
      '..',
      '../skills/example',
      './skills/example',
      'skills/./example',
      'skills/../example',
      '/skills/example',
      'C:/skills/example',
      '~/skills/example',
      'skills\\example',
      'skills//example',
    ]) {
      expect(PortfolioSkillPathSchema.safeParse(invalid).success).toBe(false);
    }

    const markdown = fs.readFileSync(docsPath, 'utf-8');
    const manifest = example(markdown, 'Portfolio Manifest') as {
      skills: Record<string, { path: string }>;
    };
    const lock = example(markdown, 'Portfolio Lock') as {
      skills: Record<string, { path: string }>;
    };
    manifest.skills['martin/audio-transcriber'].path = '.';
    lock.skills['martin/audio-transcriber'].path = '.';
    expect(PortfolioManifestSchema.parse(manifest).skills['martin/audio-transcriber'].path)
      .toBe('.');
    expect(PortfolioLockSchema.parse(lock).skills['martin/audio-transcriber'].path)
      .toBe('.');
  });

  it('validates deterministic same-Skill work-private data dependency records', () => {
    const markdown = fs.readFileSync(docsPath, 'utf-8');
    const manifest = example(markdown, 'Portfolio Manifest') as any;
    const lock = example(markdown, 'Portfolio Lock') as any;
    const dependency = PortfolioManifestSchema.parse(manifest)
      .skills['martin/audio-transcriber'].data_dependencies[0];
    expect(dependency).toMatchObject({
      id: 'cstc-eu-rspo-employer-pack',
      privacy: 'work-private',
      deployments: ['work-pkm'],
      required: true,
    });
    expect(
      PortfolioLockSchema.parse(lock)
        .skills['martin/audio-transcriber']
        .data_dependencies['cstc-eu-rspo-employer-pack']
        .path,
    ).toBe('packs/work-private/artifact-template-cstc-eu-rspo-default-deck');

    const traversal = structuredClone(manifest);
    traversal.skills['martin/audio-transcriber']
      .data_dependencies[0].path = '../packs/private';
    expect(() => PortfolioManifestSchema.parse(traversal)).toThrow(
      /must not traverse/,
    );

    const wrongPrivacy = structuredClone(manifest);
    wrongPrivacy.skills['martin/audio-transcriber']
      .data_dependencies[0].privacy = 'private';
    expect(() => PortfolioManifestSchema.parse(wrongPrivacy)).toThrow();

    const duplicateIds = structuredClone(manifest);
    duplicateIds.skills['martin/audio-transcriber'].data_dependencies.push(
      structuredClone(
        duplicateIds.skills['martin/audio-transcriber'].data_dependencies[0],
      ),
    );
    expect(() => PortfolioManifestSchema.parse(duplicateIds)).toThrow(
      /IDs must be unique/,
    );

    const duplicateDeployments = structuredClone(manifest);
    duplicateDeployments.skills['martin/audio-transcriber']
      .data_dependencies[0].deployments = ['work-pkm', 'work-pkm'];
    expect(() => PortfolioManifestSchema.parse(duplicateDeployments)).toThrow(
      /must not contain duplicates/,
    );

    const unsortedExecutables = structuredClone(lock);
    unsortedExecutables.skills['martin/audio-transcriber']
      .data_dependencies['cstc-eu-rspo-employer-pack']
      .executable_files = ['scripts/z.sh', 'scripts/a.sh'];
    expect(() => PortfolioLockSchema.parse(unsortedExecutables)).toThrow(
      /must be sorted/,
    );
  });

  it('requires absolute paths and safe managed-link backends in device registries', () => {
    const markdown = fs.readFileSync(docsPath, 'utf-8');
    const registry = example(markdown, 'Device Registry') as {
      devices: Record<string, {
        state_root: string;
        source_roots: Record<string, string>;
        project_roots: Record<string, string>;
        backends: Record<string, string>;
      }>;
    };
    registry.devices['mac-mini'].source_roots.private = 'relative/source';
    expect(() => PortfolioDeviceRegistrySchema.parse(registry)).toThrow(
      /must be absolute/,
    );

    registry.devices['mac-mini'].source_roots.private = '/srv/source';
    registry.devices['mac-mini'].backends['managed-link'] = 'copy';
    expect(() => PortfolioDeviceRegistrySchema.parse(registry)).toThrow(
      /require symlink/,
    );

    registry.devices['mac-mini'].backends['managed-link'] = 'symlink';
    registry.devices['mac-mini'].state_root = '/srv/vaults/Life-OS/.aspg';
    expect(() => PortfolioDeviceRegistrySchema.parse(registry)).toThrow(
      /state_root must not overlap project_roots/,
    );
  });

  it('requires explicit safe provider/backend policy for every v2 runtime root', () => {
    const markdown = fs.readFileSync(docsPath, 'utf-8');
    const registry = example(markdown, 'Device Registry v2') as {
      devices: Record<string, {
        runtime_roots: Record<string, {
          path: string;
          storage_provider: string;
          deployment_backend: string;
        }>;
      }>;
    };
    registry.devices['mac-mini'].runtime_roots['life-os-agents']
      .deployment_backend = 'managed-link';
    expect(() => PortfolioDeviceRegistryV2Schema.parse(registry)).toThrow(
      /requires managed-materialized/,
    );

    registry.devices['mac-mini'].runtime_roots['life-os-agents']
      .deployment_backend = 'copy';
    expect(() => PortfolioDeviceRegistryV2Schema.parse(registry)).toThrow();

    delete registry.devices['mac-mini'].runtime_roots['life-os-agents']
      .storage_provider;
    expect(() => PortfolioDeviceRegistryV2Schema.parse(registry)).toThrow();
  });

  it('rejects invalid and overlapping v2 device paths', () => {
    const markdown = fs.readFileSync(docsPath, 'utf-8');
    const documented = example(markdown, 'Device Registry v2') as {
      devices: Record<string, {
        state_root: string;
        source_roots: Record<string, string>;
        runtime_roots: Record<string, {
          project_ref: string;
          path: string;
          storage_provider: 'local-filesystem' | 'google-drive-file-provider';
          deployment_backend: 'managed-link' | 'managed-materialized';
        }>;
      }>;
    };

    const nonNormalized = structuredClone(documented);
    nonNormalized.devices['mac-mini'].state_root = '/srv/aspg/../device-state';
    expect(() => PortfolioDeviceRegistryV2Schema.parse(nonNormalized)).toThrow(
      /must be normalized/,
    );

    const filesystemRoot = structuredClone(documented);
    filesystemRoot.devices['mac-mini'].state_root = '/';
    expect(() => PortfolioDeviceRegistryV2Schema.parse(filesystemRoot)).toThrow(
      /must not be a filesystem root/,
    );

    const stateSourceOverlap = structuredClone(documented);
    stateSourceOverlap.devices['mac-mini'].source_roots.private =
      '/srv/aspg/device-state/sources/private';
    expect(() => PortfolioDeviceRegistryV2Schema.parse(stateSourceOverlap)).toThrow(
      /must not overlap state_root/,
    );

    const sourceRuntimeOverlap = structuredClone(documented);
    sourceRuntimeOverlap.devices['mac-mini'].runtime_roots['work-pkm-agents'].path =
      '/srv/aspg/sources/Martin-brew-skills-private/runtime';
    expect(() => PortfolioDeviceRegistryV2Schema.parse(sourceRuntimeOverlap)).toThrow(
      /must not overlap source_roots.private/,
    );

    const runtimeOverlap = structuredClone(documented);
    runtimeOverlap.devices['mac-mini'].runtime_roots.nested = {
      project_ref: 'life-os-cloudstorage',
      path: '/srv/vaults/Life-OS/.agents/skills/nested',
      storage_provider: 'local-filesystem',
      deployment_backend: 'managed-link',
    };
    expect(() => PortfolioDeviceRegistryV2Schema.parse(runtimeOverlap)).toThrow(
      /must not overlap runtime_roots.life-os-agents/,
    );

    const duplicateProject = structuredClone(documented);
    duplicateProject.devices['mac-mini'].runtime_roots.duplicate = {
      project_ref: duplicateProject.devices['mac-mini']
        .runtime_roots['work-pkm-agents'].project_ref,
      path: '/srv/vaults/Work-PKM-Second/.agents/skills',
      storage_provider: 'local-filesystem',
      deployment_backend: 'managed-link',
    };
    expect(() => PortfolioDeviceRegistryV2Schema.parse(duplicateProject)).toThrow(
      /project_ref .* is already owned/,
    );
  });

  it('validates v2 path style against the declared device platform', () => {
    const windowsRegistry = {
      version: 2,
      devices: {
        workstation: {
          platform: 'win32',
          state_root: 'C:\\aspg\\state',
          source_roots: {
            private: 'C:\\aspg\\sources\\private',
          },
          runtime_roots: {
            work: {
              project_ref: 'work-pkm-local',
              path: 'D:\\workspace\\Work-PKM-Vault\\.agents\\skills',
              storage_provider: 'local-filesystem',
              deployment_backend: 'managed-link',
            },
          },
        },
      },
    };
    expect(PortfolioDeviceRegistryV2Schema.parse(windowsRegistry).version).toBe(2);

    const mixedStyle = structuredClone(windowsRegistry);
    mixedStyle.devices.workstation.runtime_roots.work.path =
      '/srv/workspace/Work-PKM-Vault/.agents/skills';
    expect(() => PortfolioDeviceRegistryV2Schema.parse(mixedStyle)).toThrow(
      /path style must match win32/,
    );
  });

  it('requires an explicitly device-local activation lock scope', () => {
    const markdown = fs.readFileSync(docsPath, 'utf-8');
    const manifest = example(markdown, 'Portfolio Manifest') as {
      concurrency: { activation_lock: string };
    };
    expect(PortfolioManifestSchema.parse(manifest).concurrency.activation_lock)
      .toBe('device-local');
    manifest.concurrency.activation_lock = '.aspg/portfolio-activation.lock';
    expect(() => PortfolioManifestSchema.parse(manifest)).toThrow();
  });

  it('requires complete migration exceptions', () => {
    const markdown = fs.readFileSync(docsPath, 'utf-8');
    const lock = example(markdown, 'Portfolio Lock') as {
      exceptions: Array<Record<string, unknown>>;
    };
    delete lock.exceptions[0].owner;
    expect(() => PortfolioLockSchema.parse(lock)).toThrow();
  });

  it('provides a deterministic identity migration and rejects undeclared migrations', () => {
    const value = { version: 1, portfolio: 'example' };
    const first = migratePortfolioDocument('manifest', value, 1, 1);
    const second = migratePortfolioDocument('manifest', value, 1, 1);
    expect(first).toEqual(value);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).not.toBe(value);
    expect(() => migratePortfolioDocument('manifest', value, 1, 2)).toThrow(
      /explicit tested migrator/,
    );
    expect(() => migratePortfolioDocument('manifest', { version: 3 }, 3, 3))
      .toThrow(/explicit tested migrator/);
    expect(() => migratePortfolioDocument('manifest', { version: 2 }, 1, 1))
      .toThrow(/does not match declared source version/);
  });

  it('migrates Device Registry v1 to v2 deterministically without guessing runtime policy', () => {
    const markdown = fs.readFileSync(docsPath, 'utf-8');
    const source = example(markdown, 'Device Registry');
    const before = JSON.stringify(source);

    const first = migrateDeviceRegistryV1ToV2(source);
    const second = migratePortfolioDocument('device-registry', source, 1, 2);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(source)).toBe(before);
    expect(first.version).toBe(2);
    expect(first.devices['mac-mini']).toEqual({
      platform: 'darwin',
      state_root: '/srv/aspg/device-state',
      source_roots: {
        private: '/srv/aspg/Martin-brew-skills-private',
      },
      runtime_roots: {},
    });
    expect(PortfolioDeviceRegistryV2Schema.parse(first)).toEqual(first);

    const identity = migratePortfolioDocument('device-registry', first, 2, 2);
    expect(identity).toEqual(first);
    expect(identity).not.toBe(first);
    expect(() => migratePortfolioDocument('device-registry', first, 2, 3))
      .toThrow(/explicit tested migrator/);
  });
});
