import test from 'node:test';
import assert from 'node:assert/strict';
import { chunks } from '../src/core/reports.js';

test('line-aware chunks preserve every byte and Unicode code point, including oversized lines', () => {
  const text = '\n报告🧑‍💻\r\n' + '很长的日志🙂'.repeat(80) + '\n/status event-1\n结尾\n';
  for (const limit of [4, 5, 17, 64, 128]) {
    const parts = chunks(text, limit);
    assert.equal(parts.join(''), text);
    assert.ok(parts.every((part) => part.length > 0 && Buffer.byteLength(part) <= limit));
    assert.ok(parts.every((part) => Buffer.from(part).toString('utf8') === part));
    if (limit >= 17) assert.ok(parts.some((part) => part.includes('/status event-1\n')));
  }
});
