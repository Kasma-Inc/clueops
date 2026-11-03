import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { serveAdmin } from '../dist/plugins/rest/management.js';

// The preview serves only public assets. The browser script intercepts every data
// request with synthetic fixtures, so this command needs no model or service credentials.
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'GET' && (await serveAdmin(pathname, response))) return;
    response.writeHead(404);
    response.end();
  } catch {
    response.writeHead(500);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const session = `clueops-ui-${process.pid}`;
function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npx',
      ['--yes', '--package', '@playwright/cli', 'playwright-cli', '--session', session, ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0 || output.includes('### Error')) reject(new Error(output.trim()));
      else resolve(output);
    });
  });
}
try {
  await mkdir('output/playwright', { recursive: true });
  await cli(['open', `http://127.0.0.1:${server.address().port}/admin/`]);
  const result = await cli([
    'run-code',
    '--filename',
    fileURLToPath(new URL('../test/browser/admin-console.js', import.meta.url)),
  ]);
  if (!result.includes('"passed":'))
    throw new Error('Browser checks did not return a result:\n' + result);
  const start = result.indexOf('### Result\n') + '### Result\n'.length;
  const end = result.indexOf('\n###', start);
  const summary = JSON.parse(result.slice(start, end === -1 ? undefined : end).trim());
  process.stdout.write(
    `Admin UI: ${summary.passed} checks passed\n` +
      summary.checks.map((check) => `- ${check}`).join('\n') +
      '\n',
  );
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
} finally {
  await cli(['close']).catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
