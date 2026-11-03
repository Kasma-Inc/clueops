import test from 'node:test';
import assert from 'node:assert/strict';
import { Redactor } from '../src/core/redaction.js';

test('repeated text/value redaction preserves one canonical mask and never expands it', () => {
  const redactor = new Redactor();
  redactor.add(['SYNTHETIC_PRIVATE', 'R']);
  const input =
    'password=x\nsecret="value"\naccess_token=abc\nBearer opaque-token\npostgres://reader:pass@host/db\nSYNTHETIC_PRIVATE\nR';
  const once = redactor.text(input);
  assert.ok(!once.includes('SYNTHETIC_PRIVATE'));
  assert.ok(!once.includes('=x'));
  assert.ok(!once.includes('=abc'));
  for (let pass = 0; pass < 5; pass++) {
    assert.equal(redactor.text(once), once);
    assert.deepEqual(redactor.value({ content: once, password: '[REDACTED]' }), {
      content: once,
      password: '[REDACTED]',
    });
  }
  for (const secret of ['A', 'REDACTED', '[REDACTED]', 'synthetic[REDACTED]credential']) {
    const overlapping = new Redactor();
    overlapping.add([secret]);
    const masked = overlapping.text(secret);
    assert.equal(masked, '[REDACTED]');
    assert.equal(overlapping.text(masked), masked);
  }
});
