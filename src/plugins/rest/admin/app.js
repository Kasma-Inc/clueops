const $ = (selector) => document.querySelector(selector);
const content = $('#content');
const statusNames = {
  queued: '等待中',
  running: '调查中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  handled: '已处理',
};
const actionNames = {
  status: '状态查询',
  cancel: '取消操作',
  'retry-delivery': '重试投递',
  continue: '继续调查',
};
const errors = {
  ACCESS_DENIED: '当前入口无权访问该调查，或目标配置已变化。请返回记录列表。',
  INVALID_QUERY: '查询条件无效，请调整后重试。',
  REST_UNAVAILABLE: '服务暂时不可用，请稍后重试。',
  QUEUE_FULL: '调查队列已满，请稍后重试。',
  TARGET_SCOPE_CHANGED: '目标配置已变化，请重新发起调查。',
  INPUT_TOO_LARGE: '内容过长，请缩短后再提交。',
  UNAUTHORIZED: 'Token 无效，请重新登录。',
};
let token = '';
let authenticated = false;
let routeAbort = new AbortController();
let cleanupView = () => {};
let currentRoute = '';
let sessionAbort = new AbortController();
let routeVersion = 0;
let pollTimer;
let toastTimer;
let targets = [];
let listQuery = { search: '', targetId: '', status: '' };
let pageStack = [null];

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('aria-')) element.setAttribute(key, value);
    else element[key] = value;
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false)
      element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}
const button = (text, onclick, className = 'button') =>
  h('button', { type: 'button', className, onclick }, text);
const badge = (status) =>
  h('span', { className: `status ${status}` }, statusNames[status] || status);
const time = (value) =>
  new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
const fullTime = (value) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const targetLabel = (id) => h('span', { className: 'target-label' }, id);
const smallLabel = (text) => h('div', { className: 'section-label' }, text);
const loading = () => h('div', { className: 'loading', role: 'status' }, '正在读取…');
const json = (value) => JSON.stringify(value, null, 2);
const readableError = (error) =>
  errors[error.code] ||
  (error.name === 'TimeoutError' ? '请求超时，请重试。' : '连接失败，请检查服务后重试。');
const heading = (title, subtitle, action) =>
  h(
    'div',
    { className: 'page-heading' },
    h(
      'div',
      {},
      h('span', { className: 'eyebrow' }, 'WORKSPACE / clueops'),
      h('h1', {}, title),
      h('p', { className: 'subtitle' }, subtitle),
    ),
    action,
  );
function empty(title, description, action) {
  return h(
    'div',
    { className: 'empty' },
    h('span', { className: 'empty-mark', 'aria-hidden': 'true' }, '◎'),
    h('h2', {}, title),
    h('p', {}, description),
    action,
  );
}
function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true;
  }, 4500);
}
function resetView() {
  cleanupView();
  cleanupView = () => {};
  routeAbort.abort();
  routeAbort = new AbortController();
  clearTimeout(pollTimer);
}
function disconnect(message = '') {
  resetView();
  sessionAbort.abort();
  sessionAbort = new AbortController();
  routeVersion++;
  clearTimeout(toastTimer);
  token = '';
  authenticated = false;
  currentRoute = '';
  targets = [];
  listQuery = { search: '', targetId: '', status: '' };
  pageStack = [null];
  content.replaceChildren();
  content.hidden = true;
  $('#connect-view').hidden = false;
  $('#disconnect').hidden = true;
  $('#connection-state').replaceChildren(h('span', { className: 'small-dot muted-dot' }), '未登录');
  $('#location-label').textContent = '登录';
  for (const nav of [$('#nav-investigations'), $('#nav-targets')]) {
    nav.classList.remove('active');
    nav.setAttribute('aria-current', 'false');
  }
  $('#connect-error').textContent = message;
  $('#token').value = '';
  $('#token').disabled = false;
  $('#connect-submit').disabled = false;
  $('#connect-submit').replaceChildren('登录控制台 ', h('span', { 'aria-hidden': 'true' }, '→'));
  $('#toast').hidden = true;
}
async function api(path, options = {}) {
  const session = sessionAbort;
  const viewSignal = authenticated && options.method !== 'POST' ? routeAbort.signal : undefined;
  const stale = () => session !== sessionAbort || session.signal.aborted || viewSignal?.aborted;
  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    cache: 'no-store',
    signal: AbortSignal.any([
      session.signal,
      AbortSignal.timeout(15000),
      ...(viewSignal ? [viewSignal] : []),
      ...(options.signal ? [options.signal] : []),
    ]),
  });
  if (stale()) throw new DOMException('Session changed', 'AbortError');
  if (response.status === 401) {
    disconnect(errors.UNAUTHORIZED);
    throw Object.assign(new Error(), { code: 'UNAUTHORIZED' });
  }
  const body = await response.json();
  if (stale()) throw new DOMException('Session changed', 'AbortError');
  if (!response.ok) throw Object.assign(new Error(), { code: body.error || body.reason });
  return body;
}

$('#disconnect').onclick = () => {
  disconnect();
  $('#token').focus();
};
$('#token').oninput = () => $('#token').setCustomValidity('');
$('#connect-form').onsubmit = async (event) => {
  event.preventDefault();
  const input = $('#token');
  const submit = $('#connect-submit');
  if (submit.disabled) return;
  const candidate = input.value.trim();
  if (!candidate) {
    input.setCustomValidity('请输入访问 Token');
    input.reportValidity();
    return;
  }
  sessionAbort.abort();
  sessionAbort = new AbortController();
  const session = sessionAbort;
  token = candidate;
  submit.disabled = true;
  input.disabled = true;
  submit.textContent = '正在登录…';
  $('#connect-error').textContent = '';
  try {
    const result = await api('/api/targets');
    if (session !== sessionAbort) return;
    targets = result.targets;
    authenticated = true;
    input.value = '';
    $('#connect-view').hidden = true;
    content.hidden = false;
    $('#disconnect').hidden = false;
    $('#connection-state').replaceChildren(h('span', { className: 'small-dot' }), '已登录');
    await navigate();
  } catch (error) {
    if (session === sessionAbort) disconnect(readableError(error));
  } finally {
    if (session === sessionAbort) {
      submit.disabled = false;
      input.disabled = false;
      submit.replaceChildren('登录控制台 ', h('span', { 'aria-hidden': 'true' }, '→'));
    }
  }
};

async function navigate() {
  if (!authenticated) return;
  const nextRoute = location.hash.slice(1) || 'investigations';
  const changed = nextRoute !== currentRoute;
  currentRoute = nextRoute;
  resetView();
  const version = ++routeVersion;
  const [route, id] = nextRoute.split('/');
  const isTargets = route === 'targets';
  $('#nav-investigations').classList.toggle('active', !isTargets);
  $('#nav-targets').classList.toggle('active', isTargets);
  $('#nav-investigations').setAttribute('aria-current', !isTargets ? 'page' : 'false');
  $('#nav-targets').setAttribute('aria-current', isTargets ? 'page' : 'false');
  $('#location-label').textContent = isTargets
    ? '目标配置'
    : route === 'investigation'
      ? '调查详情'
      : '排障记录';
  content.replaceChildren(loading());
  try {
    if (/^targets(?:\/[A-Za-z][A-Za-z0-9_-]{0,127})?$/.test(nextRoute))
      await showTargets(id, version);
    else if (/^investigation\/[A-Za-z0-9_-]{1,128}$/.test(nextRoute)) await showDetail(id, version);
    else if (nextRoute === 'investigations') await showList(version);
    else
      content.replaceChildren(
        h(
          'div',
          { className: 'panel' },
          empty(
            '页面不存在',
            '请从左侧导航选择页面。',
            h('a', { className: 'button', href: '#investigations' }, '返回排障记录'),
          ),
        ),
      );
  } catch (error) {
    if (version !== routeVersion || !authenticated) return;
    content.replaceChildren(
      h(
        'div',
        { className: 'panel' },
        empty('暂时无法读取', readableError(error), button('重新加载', navigate)),
      ),
    );
  }
  if (changed && version === routeVersion && authenticated) {
    window.scrollTo(0, 0);
    if (!content.contains(document.activeElement)) $('#main').focus({ preventScroll: true });
  }
}
window.addEventListener('hashchange', navigate);

async function showList(version) {
  // Keep filter controls mounted while results change: draft inputs and applied queries
  // have different meanings until the user explicitly submits the form.
  let requestVersion = 0;
  let listAbort;
  let nextCursor = null;
  let fetching = false;
  cleanupView = () => listAbort?.abort();
  const search = h('input', {
    className: 'search-input',
    type: 'search',
    placeholder: '搜索问题、调查编号或目标…',
    value: listQuery.search,
    maxLength: 200,
    'aria-label': '搜索排障记录',
  });
  const target = h(
    'select',
    { 'aria-label': '按目标筛选' },
    h('option', { value: '' }, '全部目标'),
    targets.map((item) => h('option', { value: item.targetId }, item.targetId)),
  );
  target.value = listQuery.targetId;
  const status = h(
    'select',
    { 'aria-label': '按状态筛选' },
    h('option', { value: '' }, '全部状态'),
    Object.entries(statusNames)
      .filter(([key]) => key !== 'handled')
      .map(([value, text]) => h('option', { value }, text)),
  );
  status.value = listQuery.status;
  const draft = () => ({
    search: search.value.trim(),
    targetId: target.value,
    status: status.value,
  });
  const dirty = () => json(draft()) !== json(listQuery);
  const pendingHint = h(
    'p',
    { className: 'filter-pending', role: 'status', hidden: true },
    '条件已修改，点击“筛选”后生效。',
  );
  const appliedHint = h('span', { className: 'help applied-filter' });
  const count = h('span', { className: 'count' });
  const results = h('div', { 'aria-live': 'polite', 'aria-busy': 'false' });
  const pageNumber = h('span');
  const previous = button('上一页', () => loadPage(pageStack.slice(0, -1)), 'button small');
  const next = button('下一页 →', () => loadPage([...pageStack, nextCursor]), 'button small');
  function controls() {
    pendingHint.hidden = !dirty();
    previous.disabled = fetching || pageStack.length < 2;
    next.disabled = fetching || nextCursor === null;
  }
  search.oninput = target.onchange = status.onchange = controls;
  function apply() {
    listQuery = draft();
    return loadPage([null]);
  }
  const filter = h(
    'form',
    {
      className: 'filter-form',
      onsubmit: (event) => {
        event.preventDefault();
        apply();
      },
    },
    search,
    target,
    status,
    h('button', { type: 'submit', className: 'button' }, '筛选'),
  );
  const reset = () => {
    search.value = target.value = status.value = '';
    return apply();
  };
  const refresh = button('↻ 刷新记录', () => loadPage([null]));
  content.replaceChildren(
    heading('排障记录', '回看调查过程，让判断有证据可依。', refresh),
    h(
      'section',
      { className: 'panel', 'aria-label': '排障记录列表' },
      h('div', { className: 'panel-heading' }, h('h2', {}, '调查列表', count), appliedHint),
      filter,
      pendingHint,
      results,
      h(
        'div',
        { className: 'pager' },
        pageNumber,
        h('div', { className: 'button-group' }, previous, next),
      ),
    ),
  );
  async function loadPage(stack = pageStack) {
    listAbort?.abort();
    listAbort = new AbortController();
    const request = ++requestVersion;
    const query = { ...listQuery };
    const selectedStack = [...stack];
    const params = new URLSearchParams({ limit: '20' });
    for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
    const cursor = selectedStack.at(-1);
    if (cursor !== null) params.set('before', cursor);
    fetching = true;
    controls();
    results.setAttribute('aria-busy', 'true');
    results.replaceChildren(loading());
    count.textContent = '读取中';
    appliedHint.textContent = [
      '已应用：' + (query.targetId || '全部目标'),
      statusNames[query.status] || '全部状态',
      query.search ? '搜索：' + query.search : '',
    ]
      .filter(Boolean)
      .join(' · ');
    try {
      const result = await api('/api/investigations?' + params, { signal: listAbort.signal });
      if (version !== routeVersion || request !== requestVersion) return;
      pageStack = selectedStack;
      nextCursor = result.nextBefore;
      pageNumber.textContent = `第 ${pageStack.length} 页`;
      count.textContent = `本页 ${result.investigations.length} 条`;
      const rows = result.investigations.map((item) =>
        h(
          'tr',
          {},
          h(
            'td',
            {},
            h(
              'a',
              {
                className: 'record-title',
                href: '#investigation/' + item.investigationId,
                title: item.title,
              },
              item.title,
            ),
            h('span', { className: 'record-id' }, item.investigationId),
          ),
          h('td', {}, targetLabel(item.targetId)),
          h('td', {}, badge(item.status)),
          h('td', {}, String(item.turnCount).padStart(2, '0')),
          h('td', { title: fullTime(item.updatedAt) }, time(item.updatedAt)),
          h(
            'td',
            {},
            h(
              'a',
              {
                href: '#investigation/' + item.investigationId,
                className: 'text-button',
                'aria-label': '查看调查：' + item.title,
              },
              '查看 →',
            ),
          ),
        ),
      );
      const filtered = Object.values(query).some(Boolean);
      results.replaceChildren(
        rows.length
          ? h(
              'div',
              { className: 'table-scroll' },
              h(
                'table',
                {},
                h(
                  'thead',
                  {},
                  h(
                    'tr',
                    {},
                    ['问题 / 调查编号', '排障目标', '状态', '轮次', '最近更新', '操作'].map(
                      (text) => h('th', { scope: 'col' }, text),
                    ),
                  ),
                ),
                h('tbody', {}, rows),
              ),
            )
          : empty(
              filtered ? '没有匹配的调查' : '还没有排障记录',
              filtered
                ? '尝试更换目标、状态，或清空搜索条件。'
                : '通过当前 REST 入口提交问题后，调查会出现在这里。',
              filtered ? button('清空筛选', reset) : null,
            ),
      );
    } catch (error) {
      if (version !== routeVersion || request !== requestVersion || !authenticated) return;
      count.textContent = '读取失败';
      nextCursor = null;
      results.replaceChildren(
        empty(
          '暂时无法读取',
          readableError(error),
          button('重新加载', () => loadPage(selectedStack)),
        ),
      );
    } finally {
      if (version === routeVersion && request === requestVersion) {
        fetching = false;
        results.setAttribute('aria-busy', 'false');
        controls();
      }
    }
  }
  await loadPage();
}

function renderReport(report) {
  const section = (title, items, claims = false) =>
    h(
      'section',
      { className: 'report-section' },
      h('h3', {}, title),
      items.length
        ? h(
            'ul',
            { className: 'claim-list' },
            items.map((item) =>
              h(
                'li',
                {},
                claims ? item.text : item,
                claims
                  ? h(
                      'div',
                      {},
                      item.evidenceIds.map((id) =>
                        h('span', { className: 'evidence-ref', title: '证据编号' }, id),
                      ),
                    )
                  : null,
              ),
            ),
          )
        : h('p', { className: 'help' }, '本轮未记录'),
    );
  return h(
    'div',
    {},
    section('已确认的事实', report.facts, true),
    section('可能原因', report.hypotheses, true),
    section('建议下一步', report.recommendations),
    section('待补充的证据', report.missingEvidence),
  );
}
function createEvidenceView(turnId, investigationId, version, initialCount) {
  const list = h('div', { className: 'evidence-list' });
  const loaded = new Set();
  let total = initialCount;
  let offset = 0;
  let busy = false;
  const control = button(
    '',
    async () => {
      if (busy || offset === null) return;
      busy = true;
      sync();
      try {
        const totalAtStart = total;
        let cursor = offset;
        let fresh;
        do {
          const page = await api(
            `/api/investigations/${investigationId}/evidence?turnId=${turnId}&offset=${cursor}&limit=20`,
          );
          fresh = 0;
          if (version !== routeVersion) return;
          for (const evidence of page.evidence) {
            if (loaded.has(evidence.id)) continue;
            loaded.add(evidence.id);
            fresh++;
            const note = evidence.previewTruncated
              ? '内容较长，仅显示前 12,000 个字符。'
              : evidence.truncated
                ? '此证据由采集工具截断。'
                : '';
            list.append(
              h(
                'details',
                { className: 'evidence-item', open: page.evidence.length === 1 },
                h(
                  'summary',
                  {},
                  `${evidence.toolName} · ${evidence.status === 'ok' ? '成功' : evidence.status === 'error' ? '错误' : '不可用'} · ${time(evidence.observedAt)}`,
                ),
                h(
                  'div',
                  { className: 'evidence-body' },
                  h('div', { className: 'mono' }, evidence.id),
                  smallLabel('查询参数'),
                  h('pre', {}, json(evidence.parameters)),
                  evidence.resources.length
                    ? h('div', {}, smallLabel('资源范围'), h('pre', {}, json(evidence.resources)))
                    : null,
                  smallLabel('采集结果'),
                  h('pre', {}, evidence.contentPreview),
                  evidence.failure
                    ? h('p', { className: 'error-text' }, evidence.failure.message)
                    : null,
                  note ? h('p', { className: 'evidence-notice' }, note) : null,
                ),
              ),
            );
          }
          const next = page.nextOffset;
          if (next !== null && next <= cursor)
            throw Object.assign(new Error(), { code: 'REST_UNAVAILABLE' });
          cursor = next;
        } while (fresh === 0 && cursor !== null && total === totalAtStart);
        offset = total > totalAtStart ? 0 : cursor;
      } catch (error) {
        if (version === routeVersion && authenticated) toast(readableError(error));
      } finally {
        busy = false;
        sync();
      }
    },
    'button small',
  );
  const noEvidence = h('span', { className: 'usage' }, '本轮没有采集证据');
  const footer = h('span', {}, control, noEvidence);
  function sync() {
    if (offset === null && total > loaded.size) offset = 0;
    control.hidden = total === 0;
    noEvidence.hidden = total !== 0;
    control.disabled = busy || offset === null;
    control.textContent = busy
      ? '正在读取…'
      : offset === null
        ? '证据已全部加载'
        : loaded.size
          ? `加载更多证据 (${Math.max(0, total - loaded.size)})`
          : `查看证据 (${total})`;
  }
  sync();
  return {
    list,
    footer,
    update(count) {
      if (count > total && count > loaded.size) offset = 0;
      total = count;
      sync();
    },
  };
}

function renderTurn(turn, investigationId, version) {
  const evidence = createEvidenceView(turn.turnId, investigationId, version, turn.evidenceCount);
  const status = h('span', {}, badge(turn.status));
  const report = h('div');
  const usage = h('span', { className: 'usage' });
  const node = h(
    'article',
    { className: 'turn' },
    h(
      'header',
      { className: 'turn-header' },
      h(
        'div',
        {},
        h('strong', {}, actionNames[turn.action] || `调查轮次 ${turn.sequence}`),
        h('div', { className: 'turn-time', title: turn.turnId }, fullTime(turn.acceptedAt)),
      ),
      status,
    ),
    h(
      'div',
      { className: 'turn-body' },
      h(
        'div',
        { className: 'input-block' },
        smallLabel('提交的问题'),
        h('p', { className: 'prose' }, turn.text),
      ),
      report,
    ),
    h('div', { className: 'turn-foot' }, usage, evidence.footer),
    evidence.list,
  );
  let reportSignature;
  function update(next) {
    status.replaceChildren(badge(next.status));
    const signature = json([next.status, next.report, next.failure]);
    if (signature !== reportSignature) {
      reportSignature = signature;
      report.replaceChildren(
        next.report
          ? renderReport(next.report)
          : h(
              'p',
              { className: 'help' },
              ['running', 'queued'].includes(next.status)
                ? '调查正在进行，报告生成后将自动更新。'
                : '本轮没有生成分析报告。',
            ),
      );
      if (next.failure)
        report.append(h('p', { className: 'error-text', role: 'alert' }, next.failure));
    }
    const measured = next.usage;
    usage.textContent =
      measured && (measured.complete || measured.inputTokens || measured.outputTokens)
        ? `${measured.inputTokens.toLocaleString()} 输入 / ${measured.outputTokens.toLocaleString()} 输出 Token${measured.complete ? '' : '（统计不完整）'}`
        : '暂无完整用量统计';
    evidence.update(next.evidenceCount);
  }
  update(turn);
  return { node, update };
}

async function showDetail(id, version) {
  const initial = await api(`/api/investigations/${id}?limit=20`);
  if (version !== routeVersion) return;
  let detail = initial;
  const turns = new Map(detail.turns.map((turn) => [turn.turnId, turn]));
  const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'handled']);
  function mergeTurns(incoming) {
    for (const turn of incoming) {
      const previous = turns.get(turn.turnId);
      if (
        previous &&
        (previous.updatedAt > turn.updatedAt ||
          (terminal.has(previous.status) && !terminal.has(turn.status)) ||
          (previous.status === 'running' && turn.status === 'queued'))
      )
        continue;
      turns.set(turn.turnId, {
        ...turn,
        evidenceCount: Math.max(previous?.evidenceCount ?? 0, turn.evidenceCount),
      });
    }
  }
  let before = detail.nextBefore;
  const timeline = h('div', { className: 'timeline' });
  const statusHolder = h('span', {}, badge(detail.investigation.status));
  const updated = h('span', {}, time(detail.investigation.updatedAt));
  const roundCount = h('span', {}, detail.investigation.turnCount);
  const refreshError = h('p', { className: 'error-text', role: 'alert' });
  const older = button(
    '加载更早的轮次',
    async () => {
      older.disabled = true;
      try {
        const result = await api(`/api/investigations/${id}?limit=20&before=${before}`);
        if (version !== routeVersion) return;
        const firstVisible = timeline.firstElementChild;
        const anchor = firstVisible?.getBoundingClientRect().top;
        mergeTurns(result.turns);
        before = result.nextBefore;
        older.hidden = before === null;
        drawTurns();
        schedulePoll();
        if (firstVisible && anchor !== undefined)
          window.scrollBy(0, firstVisible.getBoundingClientRect().top - anchor);
      } catch (error) {
        if (version === routeVersion && token) toast(readableError(error));
      } finally {
        older.disabled = false;
      }
    },
    'button full',
  );
  older.hidden = before === null;
  // A turn owns its evidence nodes for the lifetime of this detail view.
  const rendered = new Map();
  function drawTurns() {
    const sorted = [...turns.values()].sort((a, b) => a.sequence - b.sequence);
    for (let i = 0; i < sorted.length; i++) {
      const turn = sorted[i];
      const existing = rendered.get(turn.turnId);
      if (existing) existing.update(turn);
      else rendered.set(turn.turnId, renderTurn(turn, id, version));
      const node = rendered.get(turn.turnId).node;
      const at = timeline.children[i];
      if (at !== node) timeline.insertBefore(node, at || null);
    }
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (
      version === routeVersion &&
      authenticated &&
      (['running', 'queued'].includes(detail.investigation.status) ||
        [...turns.values()].some((turn) => ['running', 'queued'].includes(turn.status)))
    )
      pollTimer = setTimeout(() => refresh(), 3000);
  }
  let refreshVersion = 0;
  async function refresh() {
    clearTimeout(pollTimer);
    const requestVersion = ++refreshVersion;
    refreshButton.disabled = true;
    try {
      const result = await api(`/api/investigations/${id}?limit=20`);
      const newestKnown = Math.max(...[...turns.values()].map((turn) => turn.sequence));
      let page = result;
      const gapUpdates = [];
      while (page.nextBefore !== null && page.turns[0]?.sequence > newestKnown + 1) {
        if (version !== routeVersion || requestVersion !== refreshVersion) return;
        page = await api(`/api/investigations/${id}?limit=50&before=${page.nextBefore}`);
        gapUpdates.push(...page.turns);
      }
      const latestIds = new Set([...result.turns, ...gapUpdates].map((turn) => turn.turnId));
      const oldActive = [...turns.values()].filter(
        (turn) => !latestIds.has(turn.turnId) && ['queued', 'running'].includes(turn.status),
      );
      const olderUpdates = [];
      // Recheck previously loaded active turns outside the latest page, in bounded batches.
      for (let i = 0; i < oldActive.length; i += 5) {
        if (version !== routeVersion || requestVersion !== refreshVersion) return;
        const pages = await Promise.all(
          oldActive
            .slice(i, i + 5)
            .map((turn) => api(`/api/investigations/${id}?limit=1&before=${turn.sequence + 1}`)),
        );
        olderUpdates.push(...pages.flatMap((page) => page.turns));
      }
      if (version !== routeVersion || requestVersion !== refreshVersion) return;
      mergeTurns([...olderUpdates, ...gapUpdates]);
      detail = result;
      mergeTurns(result.turns);
      drawTurns();
      statusHolder.replaceChildren(badge(result.investigation.status));
      updated.textContent = time(result.investigation.updatedAt);
      roundCount.textContent = result.investigation.turnCount;
      refreshError.textContent = '';
    } catch (error) {
      if (version === routeVersion && requestVersion === refreshVersion && token)
        refreshError.textContent = readableError(error);
    } finally {
      if (version === routeVersion && requestVersion === refreshVersion) {
        refreshButton.disabled = false;
        schedulePoll();
      }
    }
  }
  const refreshButton = button('↻ 刷新详情', refresh);
  const textarea = h('textarea', {
    id: 'followup-input',
    required: true,
    maxLength: 16000,
    placeholder: '例如：请进一步核对这个错误与数据库连接是否有关。',
  });
  const sendError = h('p', { className: 'error-text', role: 'alert' });
  const submit = h('button', { type: 'submit', className: 'button primary' }, '提交追问 →');
  let pending;
  const followup = h(
    'form',
    {
      className: 'panel followup',
      onsubmit: async (event) => {
        event.preventDefault();
        if (submit.disabled) return;
        const text = textarea.value.trim();
        if (!text) {
          textarea.setCustomValidity('请输入追问内容');
          textarea.reportValidity();
          return;
        }
        if (!pending || pending.text !== text)
          pending = {
            messageId:
              crypto.randomUUID?.() ||
              Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
                n.toString(16).padStart(2, '0'),
              ).join(''),
            investigationId: id,
            text,
          };
        submit.disabled = true;
        textarea.disabled = true;
        sendError.textContent = '';
        try {
          await api('/messages', { method: 'POST', body: json(pending) });
          if (version !== routeVersion) return;
          pending = undefined;
          textarea.value = '';
          toast('追问已受理，正在更新调查。');
          await refresh();
        } catch (error) {
          if (version === routeVersion && token)
            sendError.textContent = readableError(error) + ' 原内容会保留，可再次提交。';
        } finally {
          submit.disabled = false;
          textarea.disabled = false;
        }
      },
    },
    h('h2', {}, '继续追问'),
    h('p', { className: 'help' }, '补充线索或提出新问题，继续当前目标的调查。'),
    h('label', { htmlFor: 'followup-input' }, '追问内容'),
    textarea,
    sendError,
    h(
      'div',
      { className: 'followup-actions' },
      h('span', { className: 'help' }, '追问始终关联此调查与排障目标'),
      submit,
    ),
  );
  textarea.oninput = () => textarea.setCustomValidity('');
  const info = (label, value) =>
    h(
      'div',
      { className: 'info-row' },
      h('span', {}, label),
      value instanceof Node ? value : h('span', {}, value),
    );
  content.replaceChildren(
    h('a', { className: 'back-link', href: '#investigations' }, '← 返回排障记录'),
    h(
      'div',
      { className: 'page-heading detail-heading' },
      h(
        'div',
        {},
        h('span', { className: 'eyebrow' }, 'INVESTIGATION'),
        h('h1', {}, detail.investigation.title),
        h(
          'div',
          { className: 'metadata' },
          statusHolder,
          targetLabel(detail.investigation.targetId),
          h('span', {}, '最近更新 ', updated),
        ),
      ),
      refreshButton,
    ),
    h(
      'div',
      { className: 'detail-grid' },
      h('div', {}, older, refreshError, timeline, followup),
      h(
        'aside',
        { className: 'detail-side', 'aria-label': '调查概要' },
        h(
          'section',
          { className: 'panel' },
          h('h2', {}, '调查信息'),
          info('排障目标', detail.investigation.targetId),
          info('调查轮次', roundCount),
          info('创建时间', fullTime(detail.investigation.createdAt)),
          smallLabel('调查编号'),
          h('div', { className: 'mono' }, id),
        ),
        h(
          'section',
          { className: 'panel' },
          h('h2', {}, '从结论回到证据'),
          h(
            'p',
            { className: 'help' },
            '报告中的证据编号对应本轮采集结果。展开「查看证据」，核对查询参数与原始结果。',
          ),
          h('div', { className: 'connect-rule' }),
          h(
            'a',
            { className: 'text-button', href: '#targets/' + detail.investigation.targetId },
            '查看目标配置 →',
          ),
        ),
      ),
    ),
  );
  drawTurns();
  schedulePoll();
}

async function showTargets(selected, version) {
  const result = await api('/api/targets');
  if (version !== routeVersion) return;
  targets = result.targets;
  const target = selected ? targets.find((item) => item.targetId === selected) : targets[0];
  const refresh = button('↻ 刷新配置', navigate);
  if (!target) {
    content.replaceChildren(
      heading('目标配置', '查看当前生效的目标与工具访问范围。', refresh),
      h(
        'section',
        { className: 'panel' },
        empty(
          selected ? '目标不存在或无权访问' : '没有可查看的目标',
          selected
            ? '无法读取此目标的配置，请选择当前入口有权访问的目标。'
            : '当前入口尚未获得目标访问权限，请联系服务管理员。',
          selected ? h('a', { className: 'button', href: '#targets' }, '返回目标列表') : null,
        ),
      ),
    );
    return;
  }
  const nav = h(
    'nav',
    { className: 'panel target-nav', 'aria-label': '选择排障目标' },
    targets.map((item) =>
      h(
        'a',
        {
          href: '#targets/' + item.targetId,
          className: `target-option${item.targetId === target.targetId ? ' active' : ''}`,
          'aria-current': item.targetId === target.targetId ? 'page' : 'false',
        },
        h('strong', {}, item.targetId),
        h('small', {}, `${item.tools.length} 个工具 · ${item.knowledgeCount} 项知识`),
      ),
    ),
  );
  const configItem = (label, value) =>
    h(
      'div',
      { className: 'config-item' },
      smallLabel(label),
      h('div', { className: 'value' }, value),
    );
  const tool = (scope) =>
    h(
      'div',
      { className: 'tool-item' },
      h(
        'div',
        { className: 'tool-title' },
        h('strong', {}, scope.pluginId),
        h('small', {}, 'v' + scope.pluginVersion),
      ),
      h('p', { className: 'mono help' }, scope.instanceId),
      h('pre', { className: 'resource-code' }, json(scope.resources)),
    );
  const panel = (title, ...children) =>
    h(
      'section',
      { className: 'panel' },
      h('div', { className: 'panel-heading' }, h('h2', {}, title)),
      ...children,
    );
  content.replaceChildren(
    heading('目标配置', '查看当前生效的引擎、工具与访问范围。', refresh),
    h(
      'div',
      { className: 'notice' },
      '只读展示运行时配置概要。凭证和原始配置文件不会返回；修改配置后需重启服务生效。',
    ),
    h(
      'div',
      { className: 'target-layout' },
      nav,
      h(
        'div',
        { className: 'target-main' },
        h(
          'section',
          { className: 'panel' },
          h(
            'div',
            { className: 'target-title' },
            h('h2', {}, target.targetId),
            h('span', { className: 'read-only' }, '只读配置'),
          ),
          h(
            'div',
            { className: 'target-content config-grid' },
            configItem('排障引擎', target.engine.pluginId),
            configItem('工具实例', `${target.tools.length} 个`),
            configItem('知识条目', `${target.knowledgeCount} 项`),
            configItem('原生技能', `${target.skills.length} 项`),
            configItem('范围版本', h('span', { className: 'mono' }, target.revision)),
          ),
        ),
        panel('引擎范围', tool(target.engine)),
        panel(
          `工具与资源范围 · ${target.tools.length}`,
          target.tools.length
            ? target.tools.map(tool)
            : h('div', { className: 'target-content help' }, '此目标未配置工具。'),
        ),
        panel(
          '排障技能',
          h(
            'div',
            { className: 'target-content' },
            target.skills.length
              ? h(
                  'ul',
                  { className: 'skill-list' },
                  target.skills.map((skill) =>
                    h('li', {}, h('strong', {}, skill.name), h('p', {}, skill.description)),
                  ),
                )
              : h('p', { className: 'help' }, '此目标未配置原生技能。'),
          ),
        ),
      ),
    ),
  );
}
