import type { JsonObject, JsonValue } from '../plugin-api/index.js';
import { jsonValue } from '../plugin-api/index.js';

export class Redactor {
  readonly #secrets = new Set<string>();
  add(values: readonly string[]): void {
    for (const value of values) {
      if (!value) continue;
      this.#secrets.add(value);
      this.#secrets.add(encodeURIComponent(value));
    }
  }
  text(value: string): string {
    let output = value;
    for (const secret of [...this.#secrets].sort((a, b) => b.length - a.length)) {
      // A real credential may itself contain the public marker; redact it as a whole.
      if (secret.includes('[REDACTED]')) {
        output = output.split(secret).join('[REDACTED]');
        continue;
      }
      output = output
        .split('[REDACTED]')
        .map((part) => part.split(secret).join('[REDACTED]'))
        .join('[REDACTED]');
    }
    return output
      .replace(
        /(\b(?:password|passwd|passphrase|secret|access_token|refresh_token|id_token|api_key|authorization)\b["']?\s*[:=]\s*)(\[REDACTED\]|"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
        '$1[REDACTED]',
      )
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/(\w+:\/\/[^\s/:@]+:)[^\s@]+@/g, '$1[REDACTED]@');
  }
  value(value: JsonObject): JsonObject;
  value(value: readonly JsonValue[]): readonly JsonValue[];
  value(value: unknown): JsonValue;
  value(value: unknown): JsonValue {
    const visit = (item: JsonValue): JsonValue => {
      if (typeof item === 'string') return this.text(item);
      if (item === null || typeof item !== 'object') return item;
      if (Array.isArray(item)) return item.map(visit);
      return Object.fromEntries(
        Object.entries(item).map(([key, v]) => [
          key,
          /(?:password|passwd|passphrase|secret|token|authorization|api[_-]?key)/i.test(key) &&
          typeof v === 'string'
            ? '[REDACTED]'
            : visit(v),
        ]),
      );
    };
    return jsonValue(visit(jsonValue(value)));
  }
}
