import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  generateLifecycleProfileJsonSchema,
  jsonSchemaFromZod,
} from '../src/lifecycle-json-schema.js';
import {
  AdoptionStageSchema,
  DispositionRelationTypeSchema,
  FreshnessStatusSchema,
  LearningLevelSchema,
  LifecycleProfileSchema,
} from '../src/lifecycle-schema.js';

describe('generated lifecycle JSON Schema', () => {
  it('is generated directly from the executable canonical Zod contract', () => {
    const generated = generateLifecycleProfileJsonSchema();
    const canonicalProjection = jsonSchemaFromZod(LifecycleProfileSchema);
    expect(generated).toMatchObject(canonicalProjection);
    expect(JSON.stringify(generated)).toContain('"x-aspg-runtime-refinements":true');
    expect(generated).toMatchObject({
      properties: {
        source_path: {
          type: 'string',
          pattern: expect.any(String),
          'x-aspg-runtime-refinements': true,
        },
      },
    });
    const sourcePath = (generated as {
      properties: { source_path: { pattern: string } };
    }).properties.source_path;
    const pattern = new RegExp(sourcePath.pattern);
    expect(pattern.test('.')).toBe(true);
    expect(pattern.test('skills/example')).toBe(true);
    expect(pattern.test('./skills/example')).toBe(false);
    expect(pattern.test('skills/./example')).toBe(false);
    expect(pattern.test('skills/../example')).toBe(false);
  });

  it('keeps all lifecycle enums in parity with their canonical Zod schemas', () => {
    const generated = generateLifecycleProfileJsonSchema() as {
      properties: Record<string, unknown>;
    };
    const serialized = JSON.stringify(generated);
    for (const values of [
      LearningLevelSchema.options,
      AdoptionStageSchema.options,
      DispositionRelationTypeSchema.options,
      FreshnessStatusSchema.options,
    ]) {
      expect(serialized).toContain(JSON.stringify(values));
    }
  });

  it('is byte-deterministic for machine consumers', () => {
    const first = JSON.stringify(generateLifecycleProfileJsonSchema(), null, 2);
    const second = JSON.stringify(generateLifecycleProfileJsonSchema(), null, 2);
    expect(first).toBe(second);
    expect(createHash('sha256').update(first).digest('hex')).toHaveLength(64);
  });
});
