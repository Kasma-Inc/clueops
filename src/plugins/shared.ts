import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as toml } from '@iarna/toml';
import { objectSchema } from '../plugin-api/index.js';
import type { JsonObject, JsonSchema, JsonValue, PluginContext } from '../plugin-api/index.js';
import { HostError } from '../core/errors.js';
import { Redactor } from '../core/redaction.js';

export const text = { type: 'string', minLength: 1 } as const;
export const positive = { type: 'integer', minimum: 1, maximum: 16777216 } as const;
export const backendSchema = objectSchema(
  { command: text, args: { type: 'array', items: { type: 'string' } } },
  ['command'],
);
export interface Backend {
  readonly command: string;
  readonly args?: readonly string[];
}
export function packagedPath(relative: string): string {
  return fileURLToPath(new URL('../../' + relative, import.meta.url));
}
export async function backend(
  config: Backend | undefined,
  context: PluginContext,
  fallback?: Backend,
): Promise<Backend> {
  const selected = config ?? fallback;
  if (!selected) throw new HostError('BACKEND_CONFIG_REQUIRED');
  const command = context.resolvePath(selected.command);
  try {
    await access(command, constants.X_OK);
    if (config === undefined)
      for (const argument of selected.args ?? [])
        if (path.isAbsolute(argument)) await access(argument, constants.R_OK);
  } catch {
    throw new HostError('BACKEND_EXECUTABLE_MISSING');
  }
  return {
    command,
    args: (selected.args ?? []).map((arg) =>
      arg.startsWith('./') || arg.startsWith('../') ? context.resolvePath(arg) : arg,
    ),
  };
}
export function credentialSchema(
  properties: Record<string, JsonSchema>,
  required: readonly string[],
  value: string,
  file: string,
): JsonSchema {
  return {
    ...(objectSchema(properties, required) as JsonObject),
    oneOf: [
      { properties: { [value]: {} }, required: [value] },
      { properties: { [file]: {} }, required: [file] },
    ],
  };
}
export async function credential(
  value: string | undefined,
  file: string | undefined,
  context: PluginContext,
  whitespace: 'trim' | 'password' = 'trim',
): Promise<string> {
  if ((value !== undefined) === (file !== undefined))
    throw new HostError('CREDENTIAL_CHOICE_INVALID');
  if (file !== undefined) return secretFile(file, context, whitespace);
  if (!value?.length) throw new HostError('CREDENTIAL_VALUE_INVALID');
  return value;
}
export function privateRedactor(values: readonly string[], context: PluginContext): Redactor {
  const redactor = new Redactor();
  redactor.add(values);
  context.registerSecrets?.(values);
  return redactor;
}
export async function secretFile(
  file: string,
  context: PluginContext,
  whitespace: 'trim' | 'password' = 'trim',
): Promise<string> {
  try {
    const raw = await readFile(context.resolvePath(file), 'utf8');
    const value = whitespace === 'password' ? raw.replace(/\r?\n$/, '') : raw.trim();
    if (!value) throw new Error();
    return value;
  } catch {
    throw new HostError('CREDENTIAL_FILE_INVALID');
  }
}
export async function writeToml(
  directory: string,
  value: Record<string, unknown>,
): Promise<string> {
  const file = path.join(directory, 'backend.toml');
  await writeFile(file, toml(value as Parameters<typeof toml>[0]), { mode: 0o600 });
  return file;
}
export function bounded(input: JsonValue | undefined, fallback: number, maximum: number): number {
  if (input === undefined) return Math.min(fallback, maximum);
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1 || input > maximum)
    throw new HostError('QUERY_LIMIT_INVALID');
  return input;
}
export function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
