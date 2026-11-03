import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import type { SkillDescriptor } from '../plugin-api/index.js';
import { HostError } from './errors.js';

const limits = { skills: 128, files: 8192, bytes: 64 * 1024 * 1024, manifest: 262144, depth: 8 };
interface Budget {
  files: number;
  bytes: number;
}
interface PackageFile {
  name: string;
  bytes: Buffer;
  executable: boolean;
}
const emptyBudget = (): Budget => ({ files: 0, bytes: 0 });
const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

async function futurePath(file: string): Promise<string> {
  const absolute = path.resolve(file);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await futurePath(parent), path.basename(absolute));
  }
}
const within = (base: string, file: string): boolean => {
  const relative = path.relative(base, file);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  );
};

/** Reject both overlap directions before creating runtime files or modifying source packages. */
export async function assertSkillSourcesSeparate(
  skills: readonly SkillDescriptor[],
  destinations: readonly string[],
): Promise<void> {
  const roots = await Promise.all(destinations.map(futurePath));
  for (const skill of skills) {
    const source = await futurePath(skill.directory);
    if (roots.some((root) => within(source, root) || within(root, source)))
      throw new HostError('SKILL_SOURCE_OVERLAP', skill.directory);
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readPackage(
  directory: string,
  budget: Budget,
): Promise<{ descriptor: SkillDescriptor; files: PackageFile[] }> {
  const files: PackageFile[] = [];
  async function visit(folder: string, depth: number): Promise<void> {
    if (depth > limits.depth) throw new HostError('SKILL_TOO_DEEP', directory);
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new HostError('SKILL_RESOURCE_UNSUPPORTED', folder);
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort(byName)) {
      const file = path.join(folder, entry.name);
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (entry.name === 'SKILL.md' && folder !== directory)
        throw new HostError('NESTED_SKILL_UNSUPPORTED', file);
      if (entry.isSymbolicLink()) throw new HostError('SKILL_RESOURCE_UNSUPPORTED', file);
      if (entry.isDirectory()) await visit(file, depth + 1);
      else if (entry.isFile()) {
        const info = await lstat(file);
        if (!info.isFile()) throw new HostError('SKILL_RESOURCE_UNSUPPORTED', file);
        if (++budget.files > limits.files || budget.bytes + info.size > limits.bytes)
          throw new HostError('SKILL_TOO_LARGE', directory);
        const bytes = await readFile(file);
        budget.bytes += bytes.length;
        if (budget.bytes > limits.bytes) throw new HostError('SKILL_TOO_LARGE', directory);
        files.push({
          name: path.relative(directory, file).split(path.sep).join('/'),
          bytes,
          executable: !!(info.mode & 0o111),
        });
      } else throw new HostError('SKILL_RESOURCE_UNSUPPORTED', file);
    }
  }
  await visit(directory, 0);
  const manifest = files.find((file) => file.name === 'SKILL.md');
  if (!manifest || manifest.bytes.length > limits.manifest)
    throw new HostError('SKILL_MANIFEST_INVALID', directory);
  let name: string;
  let description: string;
  try {
    const source = new TextDecoder('utf-8', { fatal: true })
      .decode(manifest.bytes)
      .replace(/^\uFEFF/, '');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
    if (!match) throw new Error();
    const document = parseDocument(match[1]!, { uniqueKeys: true, prettyErrors: false });
    if (document.errors.length || document.warnings.length) throw new Error();
    const metadata: unknown = document.toJS({ maxAliasCount: 50 });
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      !('name' in metadata) ||
      !('description' in metadata) ||
      typeof metadata.name !== 'string' ||
      typeof metadata.description !== 'string'
    )
      throw new Error();
    name = metadata.name;
    description = metadata.description.trim();
    if (
      name.length > 64 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
      !description ||
      description.length > 1024
    )
      throw new Error();
  } catch {
    throw new HostError('SKILL_MANIFEST_INVALID', directory);
  }
  const hash = createHash('sha256').update('agent-skill-v1\0');
  for (const file of files.sort(byName))
    hash
      .update(file.name)
      .update('\0' + Number(file.executable) + '\0' + file.bytes.length + '\0')
      .update(file.bytes);
  return { descriptor: { name, description, directory, digest: hash.digest('hex') }, files };
}

export async function loadSkills(
  references: readonly string[],
): Promise<readonly SkillDescriptor[]> {
  const directories = new Set<string>();
  const visited = new Set<string>();
  async function discover(reference: string, depth: number): Promise<void> {
    if (depth > limits.depth) throw new HostError('SKILL_TOO_DEEP', reference);
    const actual = await realpath(reference);
    const info = await lstat(actual);
    if (info.isFile()) {
      if (path.basename(actual) !== 'SKILL.md')
        throw new HostError('SKILL_PATH_INVALID', reference);
      await discover(path.dirname(actual), depth);
      return;
    }
    if (!info.isDirectory()) throw new HostError('SKILL_PATH_INVALID', reference);
    if (visited.has(actual)) return;
    visited.add(actual);
    if (await exists(path.join(actual, 'SKILL.md'))) {
      directories.add(actual);
      if (directories.size > limits.skills) throw new HostError('TOO_MANY_SKILLS');
      return;
    }
    for (const entry of (await readdir(actual, { withFileTypes: true })).sort(byName)) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.isDirectory() || entry.isSymbolicLink())
        await discover(path.join(actual, entry.name), depth + 1);
    }
  }
  const result: SkillDescriptor[] = [];
  const names = new Set<string>();
  const budget = emptyBudget();
  for (const reference of references) {
    try {
      await discover(reference, 0);
    } catch (error) {
      if (error instanceof HostError) throw error;
      throw new HostError('SKILL_PATH_INVALID', reference);
    }
  }
  for (const directory of [...directories].sort()) {
    let descriptor: SkillDescriptor;
    try {
      ({ descriptor } = await readPackage(directory, budget));
    } catch (error) {
      if (error instanceof HostError) throw error;
      throw new HostError('SKILL_PACKAGE_INVALID', directory);
    }
    if (names.has(descriptor.name)) throw new HostError('DUPLICATE_SKILL_NAME', descriptor.name);
    names.add(descriptor.name);
    result.push(Object.freeze(descriptor));
  }
  return Object.freeze(result.sort(byName));
}

/** Stage only validated bytes, then replace the inactive session's complete managed set. */
export async function installSkills(
  skills: readonly SkillDescriptor[],
  directory: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (skills.length > limits.skills) throw new HostError('TOO_MANY_SKILLS');
  await assertSkillSourcesSeparate(skills, [directory]);
  const parent = path.dirname(directory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new HostError('SKILL_DESTINATION_INVALID');
  const stage = path.join(parent, '.skills-stage-' + randomUUID());
  await mkdir(stage, { mode: 0o700 });
  const budget = emptyBudget();
  const names = new Set<string>();
  try {
    for (const selected of skills) {
      signal?.throwIfAborted();
      let pack: Awaited<ReturnType<typeof readPackage>>;
      try {
        pack = await readPackage(selected.directory, budget);
      } catch (error) {
        if (error instanceof HostError) throw error;
        throw new HostError('SKILL_CONTENT_CHANGED', selected.directory);
      }
      if (
        pack.descriptor.digest !== selected.digest ||
        pack.descriptor.name !== selected.name ||
        pack.descriptor.description !== selected.description
      )
        throw new HostError('SKILL_CONTENT_CHANGED', selected.directory);
      if (names.has(selected.name)) throw new HostError('DUPLICATE_SKILL_NAME', selected.name);
      names.add(selected.name);
      for (const file of pack.files) {
        signal?.throwIfAborted();
        const output = path.join(stage, selected.name, file.name);
        await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
        await writeFile(output, file.bytes, { flag: 'wx', mode: file.executable ? 0o700 : 0o600 });
      }
    }
    signal?.throwIfAborted();
    await rm(directory, { recursive: true, force: true });
    await rename(stage, directory);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
