import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import {
  PortfolioDeviceRegistrySchema,
  PortfolioLockSchema,
  PortfolioManifestSchema,
  PortfolioSkillPathSchema,
  ProjectBindingSchema,
} from '../src/portfolio-schema.js';
import { migratePortfolioDocument } from '../src/portfolio-migrations.js';

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

describe('Portfolio v1 schemas', () => {
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
  });

  it('rejects unsupported future versions for all four contracts', () => {
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
  });
});
