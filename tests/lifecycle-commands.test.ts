import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  lifecycleListCommand,
  lifecycleNextCommand,
  lifecycleShowCommand,
  lifecycleStatusCommand,
  lifecycleValidateCommand,
} from '../src/commands/lifecycle.js';

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'lifecycle-valid',
);

let tmpDir: string;
let output: string[];
let errors: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalWarn: typeof console.warn;

function addFixtureIdentityDeclarations(root: string): void {
  const declarations = [
    ['registry/lifecycle/kepano/defuddle/profile.yaml', 'skills/defuddle'],
    [
      'registry/lifecycle/mattpocock/grill-with-docs/profile.yaml',
      'skills/grill-with-docs',
    ],
  ] as const;
  for (const [relativePath, sourcePath] of declarations) {
    const profilePath = path.join(root, relativePath);
    const profile = parseYaml(fs.readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
    profile.source_path = sourcePath;
    fs.writeFileSync(profilePath, stringifyYaml(profile));
  }
}

beforeEach(() => {
  process.exitCode = undefined as unknown as number;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-lifecycle-cli-'));
  fs.cpSync(fixtureRoot, tmpDir, { recursive: true });
  addFixtureIdentityDeclarations(tmpDir);
  output = [];
  errors = [];
  originalLog = console.log;
  originalError = console.error;
  originalWarn = console.warn;
  console.log = (...args: unknown[]) => output.push(args.join(' '));
  console.error = (...args: unknown[]) => errors.push(args.join(' '));
  console.warn = (...args: unknown[]) => errors.push(args.join(' '));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;
  process.exitCode = undefined as unknown as number;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('lifecycle read-only commands', () => {
  it('emits stable JSON for validate, list, show, status and next', async () => {
    const calls = [
      () => lifecycleValidateCommand({ registry: [tmpDir], json: true }),
      () => lifecycleListCommand({ registry: [tmpDir], json: true }),
      () => lifecycleShowCommand('kepano/defuddle', { registry: [tmpDir], json: true }),
      () => lifecycleStatusCommand({ registry: [tmpDir], asOf: '2026-09-01', json: true }),
      () => lifecycleNextCommand({ registry: [tmpDir], asOf: '2026-09-01', json: true }),
    ];
    for (const call of calls) {
      output = [];
      await call();
      const first = output.join('\n');
      output = [];
      await call();
      expect(output.join('\n')).toBe(first);
      expect(JSON.parse(first).writes_performed).toBe(0);
    }
    expect(process.exitCode).toBeUndefined();
  });

  it('returns exit 1 and a null dossier for an unknown Skill', async () => {
    await lifecycleShowCommand('missing/skill', { registry: [tmpDir], json: true });
    expect(JSON.parse(output.join('\n')).skill).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  it('returns exit 1 with actionable diagnostics for an invalid registry root', async () => {
    await lifecycleValidateCommand({
      registry: [path.join(tmpDir, 'does-not-exist')],
      json: false,
    });
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('[registry-root-missing]');
    expect(output.join('\n')).toContain('Validation: invalid');
  });

  it('surfaces explicit as-of dates and rejects impossible dates', async () => {
    await lifecycleNextCommand({
      registry: [tmpDir],
      asOf: '2026-09-01',
      json: true,
    });
    expect(JSON.parse(output.join('\n')).as_of).toBe('2026-09-01');

    output = [];
    await lifecycleStatusCommand({
      registry: [tmpDir],
      asOf: '2026-99-99',
      json: true,
    });
    expect(output).toEqual([]);
    expect(errors.join('\n')).toContain('--as-of');
    expect(process.exitCode).toBe(2);
  });

  it('reports declared canonical Profiles separately from materialized trees', async () => {
    const sourcesPath = path.join(tmpDir, 'registry', 'sources.yaml');
    const sources = parseYaml(fs.readFileSync(sourcesPath, 'utf8')) as {
      sources: Array<Record<string, unknown>>;
    };
    const projectSource = sources.sources.find((source) => source.id === 'project-source')!;
    projectSource.source_type = 'private-canonical';
    projectSource.path = '.';
    fs.writeFileSync(sourcesPath, stringifyYaml(sources));

    const profilePath = path.join(
      tmpDir,
      'registry',
      'lifecycle',
      'martin',
      'visual-mail',
      'profile.yaml',
    );
    const profile = parseYaml(fs.readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
    profile.owner_class = 'private-canonical';
    profile.source_path = 'skills/visual-mail';
    fs.writeFileSync(profilePath, stringifyYaml(profile));

    await lifecycleValidateCommand({ registry: [tmpDir], json: true });
    expect(JSON.parse(output.join('\n')).canonical_inventory).toEqual({
      declared_profile_count: 1,
      declared_source_path_count: 1,
      canonical_tree_count: 0,
    });

    fs.mkdirSync(path.join(tmpDir, 'skills', 'visual-mail'), { recursive: true });
    output = [];
    await lifecycleStatusCommand({
      registry: [tmpDir],
      asOf: '2026-09-01',
      json: true,
    });
    expect(JSON.parse(output.join('\n')).canonical_inventory).toEqual({
      declared_profile_count: 1,
      declared_source_path_count: 1,
      canonical_tree_count: 1,
    });
  });

  it('keeps unavailable Life-OS mapping non-fatal but fails a mapped missing note', async () => {
    await lifecycleValidateCommand({
      registry: [tmpDir],
      lifeosRoot: path.join(tmpDir, 'not-mounted'),
      json: true,
    });
    const unavailable = JSON.parse(output.join('\n'));
    expect(unavailable.valid).toBe(true);
    expect(unavailable.diagnostics.some((item: { code: string }) =>
      item.code === 'evidence-unresolved')).toBe(true);
    expect(unavailable.evidence_resolution.flatMap(
      (item: { evidence: Array<{ resolution: string }> }) => item.evidence,
    ).some((item: { resolution: string }) => item.resolution === 'unresolved')).toBe(true);
    expect(process.exitCode).toBeUndefined();

    output = [];
    const mounted = path.join(tmpDir, 'mounted-empty');
    fs.mkdirSync(mounted);
    await lifecycleValidateCommand({
      registry: [tmpDir],
      lifeosRoot: mounted,
      json: true,
    });
    const missing = JSON.parse(output.join('\n'));
    expect(missing.valid).toBe(false);
    expect(missing.diagnostics.some((item: { code: string }) =>
      item.code === 'evidence-reference-missing')).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});
