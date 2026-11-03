import { readFile, mkdir, writeFile, chmod, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(new URL('./backends.lock.json', import.meta.url), 'utf8'));
const output = path.join(root, '.clueops', 'bin');
await mkdir(output, { recursive: true, mode: 0o700 });
if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch))
  throw new Error('Supported backend deployment: macOS/Linux arm64/x64');
for (const [name, backend] of Object.entries(lock)) {
  const asset = backend.assets.find((a) =>
    name.startsWith('kubernetes')
      ? a.name ===
        `kubernetes-mcp-server-${process.platform}-${process.arch === 'x64' ? 'amd64' : 'arm64'}`
      : a.name ===
        `github-mcp-server_${process.platform === 'darwin' ? 'Darwin' : 'Linux'}_${process.arch === 'x64' ? 'x86_64' : 'arm64'}.tar.gz`,
  );
  if (!asset?.digest?.startsWith('sha256:')) throw new Error(`Missing pinned digest: ${name}`);
  const response = await fetch(asset.browser_download_url);
  if (!response.ok) throw new Error(`Download failed: ${name} ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if ('sha256:' + createHash('sha256').update(bytes).digest('hex') !== asset.digest)
    throw new Error(`Checksum mismatch: ${name}`);
  const temp = await mkdtemp(path.join(output, '.install-'));
  try {
    let binary = bytes;
    if (asset.name.endsWith('.tar.gz')) {
      const archive = path.join(temp, 'backend.tar.gz');
      await writeFile(archive, bytes);
      execFileSync('tar', ['-xzf', archive, '-C', temp, name]);
      binary = await readFile(path.join(temp, name));
    }
    const target = path.join(output, name);
    await writeFile(target, binary, { mode: 0o700 });
    await chmod(target, 0o700);
    process.stdout.write(`${name} ${backend.version} installed (SHA-256 verified)\n`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
execFileSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['ci', '--prefix', path.join(root, 'tools/dbhub'), '--ignore-scripts', '--omit=dev'],
  { stdio: 'inherit' },
);
// Redis official MCP is Python-only. Install a separate, hash-locked environment
// at deployment time; investigations never run pip/uv or inherit personal config.
const redisVenv = path.join(root, '.clueops', 'redis-venv');
execFileSync('python3', ['-m', 'venv', redisVenv], { stdio: 'inherit' });
execFileSync(
  path.join(redisVenv, 'bin', 'python3'),
  [
    '-m',
    'pip',
    'install',
    '--require-hashes',
    '--only-binary=:all:',
    '-r',
    path.join(root, 'tools/redis/requirements.txt'),
  ],
  { stdio: 'inherit' },
);
