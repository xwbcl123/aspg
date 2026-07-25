/**
 * Deterministic JSON Schema projection generated from the executable Zod
 * contract. Zod remains canonical; this projection is for editors and other
 * machine readers. Cross-field refinements remain enforced by Zod.
 */
import {
  z,
  ZodArray,
  ZodDefault,
  ZodEffects,
  ZodEnum,
  ZodLiteral,
  ZodNumber,
  ZodObject,
  ZodOptional,
  ZodString,
  type ZodTypeAny,
} from 'zod';
import { LifecycleProfileSchema } from './lifecycle-schema.js';

export type JsonSchema = Record<string, unknown>;

function isOptional(schema: ZodTypeAny): boolean {
  if (schema instanceof ZodOptional || schema instanceof ZodDefault) return true;
  if (schema instanceof ZodEffects) return isOptional(schema._def.schema);
  return false;
}

export function jsonSchemaFromZod(schema: ZodTypeAny): JsonSchema {
  if (schema instanceof ZodEffects) {
    return {
      ...jsonSchemaFromZod(schema._def.schema),
      'x-aspg-runtime-refinements': true,
    };
  }
  if (schema instanceof ZodOptional) return jsonSchemaFromZod(schema._def.innerType);
  if (schema instanceof ZodDefault) {
    return {
      ...jsonSchemaFromZod(schema._def.innerType),
      default: schema._def.defaultValue(),
    };
  }
  if (schema instanceof ZodString) {
    const output: JsonSchema = { type: 'string' };
    for (const check of schema._def.checks) {
      if (check.kind === 'min') output.minLength = check.value;
      else if (check.kind === 'max') output.maxLength = check.value;
      else if (check.kind === 'regex') output.pattern = check.regex.source;
    }
    return output;
  }
  if (schema instanceof ZodNumber) {
    const integer = schema._def.checks.some((check: { kind: string }) => check.kind === 'int');
    return { type: integer ? 'integer' : 'number' };
  }
  if (schema instanceof ZodLiteral) return { const: schema._def.value };
  if (schema instanceof ZodEnum) return { type: 'string', enum: [...schema._def.values] };
  if (schema instanceof ZodArray) {
    return {
      type: 'array',
      items: jsonSchemaFromZod(schema._def.type),
    };
  }
  if (schema instanceof ZodObject) {
    const shape = schema._def.shape() as Record<string, ZodTypeAny>;
    const properties = Object.fromEntries(
      Object.entries(shape).map(([key, value]) => [key, jsonSchemaFromZod(value)]),
    );
    const required = Object.entries(shape)
      .filter(([, value]) => !isOptional(value))
      .map(([key]) => key);
    return {
      type: 'object',
      properties,
      required,
      additionalProperties: schema._def.unknownKeys !== 'strict',
    };
  }
  if (schema instanceof z.ZodRecord) {
    return {
      type: 'object',
      additionalProperties: jsonSchemaFromZod(schema._def.valueType),
    };
  }
  throw new Error(`Unsupported Zod node in lifecycle JSON Schema projection: ${schema._def.typeName}`);
}

export function generateLifecycleProfileJsonSchema(): JsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/xwbcl123/aspg/schema/lifecycle-profile-v1.json',
    title: 'ASPG Lifecycle Profile v1',
    description: 'Generated from ASPG LifecycleProfileSchema; executable Zod refinements are canonical.',
    ...jsonSchemaFromZod(LifecycleProfileSchema),
  };
}
