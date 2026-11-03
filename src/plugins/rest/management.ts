import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import type {
  ChannelManagementAccess,
  InvestigationQuery,
  InvestigationTurnStatus,
  Principal,
} from '../../plugin-api/index.js';
import { HostError } from '../../core/errors.js';

const statuses = new Set<InvestigationTurnStatus>([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'handled',
]);
const assets: Record<string, readonly [string, string]> = {
  '/admin': ['index.html', 'text/html; charset=utf-8'],
  '/admin/': ['index.html', 'text/html; charset=utf-8'],
  '/admin/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/admin/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/admin/icon.svg': ['icon.svg', 'image/svg+xml'],
};

export async function serveAdmin(pathname: string, response: ServerResponse): Promise<boolean> {
  const asset = assets[pathname];
  if (!asset) return false;
  const data = await readFile(new URL('./admin/' + asset[0], import.meta.url));
  response.writeHead(200, {
    'Content-Type': asset[1],
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  response.end(data);
  return true;
}

function number(value: string | null, fallback: number, max: number, min = 1): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(+value) || +value < min || +value > max)
    throw new HostError('INVALID_QUERY');
  return +value;
}

/** Query validation stays at the transport boundary; Core owns identity and scope. */
export async function managementResponse(
  url: URL,
  principal: Principal,
  access: ChannelManagementAccess | undefined,
): Promise<unknown> {
  if (!access) throw new HostError('ACCESS_DENIED');
  const match = /^\/api\/investigations\/([A-Za-z0-9_-]{1,128})(\/evidence)?$/.exec(url.pathname);
  const allowed =
    url.pathname === '/api/investigations'
      ? ['before', 'limit', 'search', 'targetId', 'status']
      : match?.[2]
        ? ['turnId', 'offset', 'limit']
        : match
          ? ['before', 'limit']
          : [];
  if (
    [...url.searchParams.keys()].some(
      (key) => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1,
    )
  )
    throw new HostError('INVALID_QUERY');
  const params = url.searchParams;
  if (url.pathname === '/api/targets') return { targets: access.listTargets(principal) };
  const limit = number(params.get('limit'), 20, 50);
  if (match?.[2]) {
    const turnId = params.get('turnId');
    if (!turnId || !/^[A-Za-z0-9_-]{1,128}$/.test(turnId)) throw new HostError('INVALID_QUERY');
    return access.listEvidence(
      principal,
      match[1]!,
      turnId,
      number(params.get('offset'), 0, Number.MAX_SAFE_INTEGER, 0),
      number(params.get('limit'), 20, 20),
    );
  }
  if (match) {
    const before = params.has('before')
      ? { before: number(params.get('before'), 1, Number.MAX_SAFE_INTEGER) }
      : {};
    return access.getInvestigation(principal, match[1]!, { limit, ...before });
  }
  if (url.pathname === '/api/investigations') {
    const cursor = params.get('before');
    if (
      cursor !== null &&
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[A-Za-z0-9_-]{1,128}$/.test(cursor)
    )
      throw new HostError('INVALID_QUERY');
    const search = params.get('search');
    const targetId = params.get('targetId');
    const status = params.get('status') as InvestigationTurnStatus | null;
    if (
      (search !== null && search.length > 200) ||
      (targetId !== null && !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(targetId)) ||
      (status !== null && !statuses.has(status))
    )
      throw new HostError('INVALID_QUERY');
    const query: InvestigationQuery = {
      limit,
      ...(cursor !== null ? { before: cursor } : {}),
      ...(search ? { search } : {}),
      ...(targetId ? { targetId } : {}),
      ...(status ? { status } : {}),
    };
    return access.listInvestigations(principal, query);
  }
  throw new HostError('NOT_FOUND');
}
