import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodexOptions } from '@openai/codex-sdk';
import TOML from '@iarna/toml';
import type { PluginContext } from '../../plugin-api/index.js';
import { objectSchema } from '../../plugin-api/index.js';
import { HostError } from '../../core/errors.js';
import { authFilePath } from './auth.js';
import {
  canonicalPath,
  contains,
  systemRuntimeRoots,
  validatePrivatePaths,
} from '../private-paths.js';

export interface FilesystemConfig {
  readonly read?: readonly string[];
  readonly write?: readonly string[];
}
export interface FilesystemAccess {
  readonly read: readonly string[];
  readonly write: readonly string[];
}
const paths = {
  type: 'array',
  uniqueItems: true,
  items: { type: 'string', minLength: 1 },
} as const;
export const filesystemSchema = objectSchema({ read: paths, write: paths }, []);
export async function resolveFilesystem(
  config: FilesystemConfig | undefined,
  context: PluginContext,
  protectedPaths: readonly string[],
): Promise<FilesystemAccess> {
  const protectedRoots = await validatePrivatePaths(protectedPaths, [vendorDirectory()]);
  const systemRoots = systemRuntimeRoots();
  const app = fileURLToPath(new URL('../../../', import.meta.url));
  const runtime = await Promise.all(
    [
      ...['src', 'dist', 'tools', 'node_modules'].map((name) => path.join(app, name)),
      path.dirname(process.execPath),
      ...systemRoots,
      '/opt',
      '/Applications',
      ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    ].map((file) => canonicalPath(file).catch(() => path.resolve(file))),
  );
  async function resolve(values: readonly string[], writable: boolean): Promise<readonly string[]> {
    const result = [];
    for (const value of values) {
      let actual: string;
      try {
        actual = await realpath(authFilePath(value, context));
      } catch {
        throw new HostError('FILESYSTEM_PATH_INVALID', value);
      }
      if (
        protectedRoots.some((root) => contains(actual, root) || contains(root, actual)) ||
        (writable && runtime.some((root) => contains(actual, root) || contains(root, actual)))
      )
        throw new HostError('FILESYSTEM_PATH_PRIVATE', value);
      result.push(actual);
    }
    return Object.freeze([...new Set(result)].sort());
  }
  return Object.freeze({
    read: await resolve(config?.read ?? [], false),
    write: await resolve(config?.write ?? [], true),
  });
}

function vendorDirectory(): string {
  const sdk = createRequire(import.meta.resolve('@openai/codex-sdk'));
  const cli = createRequire(sdk.resolve('@openai/codex/package.json'));
  const root = path.dirname(
    cli.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`),
  );
  const triple = `${process.arch === 'x64' ? 'x86_64' : 'aarch64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
  return path.join(root, 'vendor', triple);
}

/** Native OS enforcement; no command interception, custom sandbox or permissive fallback. */
export async function permissionProfile(options: {
  readonly home: string;
  readonly work: string;
  readonly temporary: string;
  readonly codexHome: string;
  readonly access: FilesystemAccess;
}): Promise<Required<Pick<CodexOptions, 'config' | 'configOverrides'>>> {
  const filesystem: Record<string, string> = {
    ':root': 'deny',
    ':minimal': 'read',
    ...(process.platform === 'darwin' ? { ':slash_tmp': 'deny', '/private/var/tmp': 'deny' } : {}),
  };
  const grant = async (file: string, mode: string) => {
    filesystem[await canonicalPath(file)] = mode;
  };
  // Root denial already covers config/auth/state. Redundant nested denies can
  // prevent bubblewrap from creating mountpoints for narrower allowed paths.
  await grant(vendorDirectory(), 'read');
  await grant(options.work, 'write');
  await grant(options.temporary, 'write');
  await grant(path.join(options.home, '.agents', 'skills'), 'read');
  await grant(path.join(options.codexHome, 'skills', '.system'), 'read');
  for (const file of options.access.read) await grant(file, 'read');
  for (const file of options.access.write) await grant(file, 'write');
  // SDK 0.166 flattens structured keys without quoting dotted paths/IPs.
  // Use its raw override API and the TOML serializer for these path-keyed tables.
  const profiles = {
    investigation: {
      filesystem,
      network: {
        enabled: true,
        proxy_url: 'http://127.0.0.1:0',
        socks_url: 'http://127.0.0.1:0',
        domains: { '*': 'allow' },
        unix_sockets: {},
      },
    },
  };
  return {
    config: { default_permissions: 'investigation' },
    configOverrides: ['permissions=' + TOML.stringify.value(profiles)],
  };
}
