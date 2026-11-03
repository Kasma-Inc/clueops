import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { JsonSchema, JsonValue } from './contracts.js';

export class ContractError extends Error {
  readonly code = 'INVALID_CONTRACT_DATA';
  constructor(readonly contract: string) {
    super(`Invalid ${contract}`);
    this.name = 'ContractError';
  }
}

function checkJson(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null || ancestors.has(value))
    throw new ContractError('JSON value');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    throw new ContractError('JSON value');
  ancestors.add(value);
  for (const item of Object.values(value)) checkJson(item, ancestors);
  ancestors.delete(value);
}

function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const item of Object.values(value)) freeze(item);
  Object.freeze(value);
}

/** Copy first: never freeze caller-owned objects or return a mutable authority object. */
export function snapshot<T>(value: T): T {
  checkJson(value, new Set());
  const copy = structuredClone(value);
  freeze(copy);
  return copy;
}

export interface ContractValidator<T> {
  parse(value: unknown): T;
  accepts(value: unknown): value is T;
}

/** One validator per schema isolates plugin $ids. Validation never coerces/defaults inputs. */
export function compileContract<T>(schema: JsonSchema, label: string): ContractValidator<T> {
  const ajv = new Ajv2020({ strict: true, allErrors: false, addUsedSchema: false, logger: false });
  addFormats.default(ajv);
  const validate = ajv.compile<T>(schema);
  if ('$async' in validate && validate.$async) throw new ContractError('synchronous schema');
  const accepts = (value: unknown): value is T => {
    try {
      checkJson(value, new Set());
      return validate(value) === true;
    } catch {
      return false;
    }
  };
  return Object.freeze({
    accepts,
    parse(value: unknown): T {
      if (!accepts(value)) throw new ContractError(label);
      return snapshot(value);
    },
  });
}

export function jsonValue(value: unknown): JsonValue {
  return snapshot(value) as JsonValue;
}
