async function checkAdminConsole(page) {
  // Run with playwright-cli against /admin/. All business requests are intercepted;
  // this suite never submits an investigation or uses a real credential.
  const base = new URL(page.url()).origin;
  const passed = [];
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const data = Array.from({ length: 44 }, (_, i) => ({
    investigationId: 'event-' + i,
    targetId: i % 2 ? 'prod' : 'dev',
    title: `问题 ${i} ${i % 2 ? '生产' : '开发'}`,
    status: i % 3 ? 'completed' : 'failed',
    sourceChannel: i % 2 ? 'lark' : 'http',
    canContinue: true,
    turnCount: 1,
    createdAt: '2026-11-03T01:00:00.000Z',
    updatedAt: '2026-11-03T01:01:00.000Z',
  }));
  const scope = {
    instanceId: 'fixture',
    pluginId: 'fixture',
    pluginVersion: '1',
    apiVersion: 1,
    resources: {},
  };
  const targetData = ['dev', 'prod'].map((targetId) => ({
    targetId,
    revision: 'fixture',
    engine: scope,
    tools: [scope],
    knowledgeCount: 0,
    skills: [],
  }));
  let requests = [];
  let mode = '';
  let detailReads = 0;
  let postBodies = [];
  let detailStatus = 'completed';
  let evidenceCount = 1;
  let holdEvidence;
  let releaseEvidence;
  let historySize = 1;
  let canContinue = true;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let targetFailure = false;
  let holdLogin;
  let releaseLogin;
  let holdOldList;
  let releaseOldList;
  const response = (route, value, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  const waitFor = (fn, value) => page.waitForFunction(fn, value, { timeout: 6000 });
  const login = async () => {
    await page.getByRole('textbox', { name: '访问 Token' }).fill('UI_SYNTHETIC_TOKEN');
    await page.getByRole('button', { name: '登录控制台' }).click();
    await waitFor(() => document.querySelector('#connection-state').textContent.includes('已登录'));
  };
  await page.route(base + '/api/**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    if (url.pathname === '/api/targets') {
      if (holdLogin) {
        const wait = holdLogin;
        holdLogin = null;
        await wait;
      }
      if (targetFailure) return response(route, { error: 'UNAUTHORIZED' }, 401);
      return response(route, { targets: targetData });
    }
    if (url.pathname === '/api/investigations') {
      const search = url.searchParams.get('search') || '';
      const target = url.searchParams.get('targetId') || '';
      if (holdOldList && target === 'dev') {
        const wait = holdOldList;
        holdOldList = null;
        await wait;
      }
      let rows = data.filter(
        (item) =>
          (!target || item.targetId === target) &&
          (!url.searchParams.get('status') || item.status === url.searchParams.get('status')) &&
          (!search || item.title.includes(search)),
      );
      const offset = Number((url.searchParams.get('before') || 'cursor-0').replace('cursor-', ''));
      const limit = Number(url.searchParams.get('limit') || 20);
      return response(route, {
        investigations: rows.slice(offset, offset + limit),
        nextBefore: offset + limit < rows.length ? 'cursor-' + (offset + limit) : null,
      });
    }
    if (url.pathname.endsWith('/evidence')) {
      // The second evidence sorts BEFORE the first: additions need not append to offsets.
      const all = evidenceCount > 1 ? ['e-0', 'e-1'] : ['e-1'];
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 20);
      const value = {
        evidence: all.slice(offset, offset + limit).map((id) => ({
          id,
          toolName: 'read_logs',
          status: 'ok',
          observedAt: '2026-11-03T01:00:00.000Z',
          parameters: {},
          resources: [],
          contentPreview: 'fixture ' + id,
          truncated: false,
          previewTruncated: false,
        })),
        nextOffset: offset + limit < all.length ? offset + limit : null,
      };
      if (holdEvidence) {
        const wait = holdEvidence;
        holdEvidence = null;
        await wait;
      }
      return response(route, value);
    }
    if (mode === 'history') {
      const all = Array.from({ length: historySize }, (_, i) => ({
        turnId: 'history-' + (i + 1),
        sequence: i + 1,
        text: '问题内容',
        acceptedAt: '2026-11-03T01:00:00.000Z',
        updatedAt: '2026-11-03T01:01:00.000Z',
        status: 'completed',
        evidenceCount: 0,
        report: { facts: [], hypotheses: [], recommendations: [], missingEvidence: [] },
      }));
      const before = Number(url.searchParams.get('before') || Infinity);
      const matching = all.filter((turn) => turn.sequence < before);
      const turns = matching.slice(-Number(url.searchParams.get('limit') || 20));
      return response(route, {
        investigation: { ...data[0], status: 'completed', turnCount: historySize },
        turns,
        nextBefore: matching.length > turns.length ? turns[0].sequence : null,
      });
    }
    detailReads++;
    if (mode === 'transient-detail' && detailReads === 2)
      return response(route, { error: 'REST_UNAVAILABLE' }, 503);
    const report =
      detailStatus === 'completed'
        ? { facts: [], hypotheses: [], recommendations: ['fixture report'], missingEvidence: [] }
        : undefined;
    return response(route, {
      investigation: { ...data[0], status: detailStatus, canContinue },
      turns: [
        {
          turnId: 'turn-1',
          sequence: 1,
          text: '问题内容',
          acceptedAt: '2026-11-03T01:00:00.000Z',
          updatedAt:
            detailStatus === 'completed' ? '2026-11-03T01:01:00.000Z' : '2026-11-03T01:00:00.000Z',
          status: detailStatus,
          evidenceCount,
          ...(report ? { report } : {}),
        },
      ],
      nextBefore: null,
    });
  });
  await page.route(base + '/messages', async (route) => {
    postBodies.push(route.request().postDataJSON());
    if (mode === 'post-retry' && postBodies.length === 1)
      return response(route, { error: 'REST_UNAVAILABLE' }, 503);
    return response(
      route,
      { status: 'accepted', investigationId: 'event-0', turnId: 'turn-2' },
      202,
    );
  });
  await page.goto(base + '/admin/#investigations');
  await login();
  await waitFor(() => document.querySelectorAll('tbody tr').length === 20);
  check(
    await page
      .locator('tbody tr')
      .evaluateAll((rows) => new Set(rows.map((row) => row.cells[3].textContent)).size === 2),
    '不同来源的调查没有同时展示或来源列缺失',
  );
  passed.push('混合渠道记录同时展示，来源仅作为元数据');
  let countBefore = requests.length;
  await page.getByRole('combobox', { name: '按目标筛选' }).selectOption('prod');
  check(requests.length === countBefore, '切换目标不应自动提交筛选');
  await page.getByRole('status').filter({ hasText: '条件已修改' }).waitFor();
  check((await page.locator('tbody tr').count()) === 20, '未应用条件不应改变记录');
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await waitFor(
    () =>
      document.querySelectorAll('tbody tr').length > 0 &&
      [...document.querySelectorAll('tbody tr')].every(
        (row) => row.cells[1].textContent === 'prod',
      ),
  );
  check(
    await page
      .locator('.applied-filter')
      .textContent()
      .then((text) => text.includes('prod')),
    '没有标明已应用目标',
  );
  passed.push('目标仅点击筛选后生效，并提示未应用条件');
  countBefore = requests.length;
  await page.getByRole('combobox', { name: '按状态筛选' }).selectOption('failed');
  check(requests.length === countBefore, '切换状态不应自动提交筛选');
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await waitFor(
    () =>
      document.querySelectorAll('tbody tr').length > 0 &&
      [...document.querySelectorAll('tbody tr')].every(
        (row) => row.cells[2].textContent === '失败',
      ),
  );
  passed.push('状态筛选仅提交后应用');
  await page.getByRole('combobox', { name: '按状态筛选' }).selectOption('');
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await waitFor(() => document.querySelectorAll('tbody tr').length === 20);
  await page.getByRole('button', { name: '下一页 →' }).click();
  await waitFor(() => document.querySelector('.pager').textContent.includes('第 2 页'));
  await page.getByRole('combobox', { name: '按目标筛选' }).selectOption('dev');
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await waitFor(
    () =>
      document.querySelector('.pager').textContent.includes('第 1 页') &&
      [...document.querySelectorAll('tbody tr')].every((row) => row.cells[1].textContent === 'dev'),
  );
  passed.push('分页后应用新筛选重置到第一页');
  const search = page.getByRole('searchbox', { name: '搜索排障记录' });
  countBefore = requests.length;
  await search.fill('问题 10');
  check(requests.length === countBefore, '输入搜索词不应自动提交');
  await search.press('Enter');
  await waitFor(() => document.querySelectorAll('tbody tr').length === 1);
  check(await search.evaluate((el) => el === document.activeElement), '搜索更新丢失输入焦点');
  await search.fill('不存在的记录');
  await page.getByRole('button', { name: '↻ 刷新记录' }).click();
  await waitFor(() => document.querySelectorAll('tbody tr').length === 1);
  check((await search.inputValue()) === '不存在的记录', '刷新丢弃了未提交的搜索词');
  await page.getByRole('status').filter({ hasText: '条件已修改' }).waitFor();
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await page.getByRole('heading', { name: '没有匹配的调查' }).waitFor();
  passed.push('搜索按回车应用，刷新保留草稿且不隐式应用');
  await page.getByRole('button', { name: '清空筛选' }).click();
  await waitFor(() => document.querySelectorAll('tbody tr').length === 20);
  holdOldList = new Promise((resolve) => {
    releaseOldList = resolve;
  });
  await page.getByRole('combobox', { name: '按目标筛选' }).selectOption('dev');
  const oldRequest = page.waitForRequest((request) => request.url().includes('targetId=dev'));
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await oldRequest;
  await page.getByRole('combobox', { name: '按目标筛选' }).selectOption('prod');
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await waitFor(
    () =>
      document.querySelectorAll('tbody tr').length > 0 &&
      [...document.querySelectorAll('tbody tr')].every(
        (row) => row.cells[1].textContent === 'prod',
      ),
  );
  releaseOldList();
  await page.getByRole('combobox', { name: '按目标筛选' }).selectOption('');
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await waitFor(() => document.querySelectorAll('tbody tr').length === 20);
  passed.push('连续提交筛选忽略延迟旧响应');
  await page.evaluate(() => {
    location.hash = '#targets/missing';
  });
  await page.getByRole('heading', { name: '目标不存在或无权访问' }).waitFor();
  passed.push('失效目标不冒充其他环境');
  detailStatus = 'running';
  await page.evaluate(() => {
    location.hash = '#investigation/event-0';
  });
  await page.getByRole('button', { name: '查看证据 (1)' }).click();
  await page.locator('details[open]').waitFor();
  evidenceCount = 2;
  await page.getByRole('button', { name: '↻ 刷新详情' }).click();
  await waitFor(() => document.querySelector('.metadata .status').textContent === '调查中');
  check((await page.locator('details[open]').count()) === 1, '状态更新重置了已展开证据');
  detailStatus = 'completed';
  await page.getByRole('button', { name: '↻ 刷新详情' }).click();
  await waitFor(() => document.querySelector('.metadata .status').textContent === '已完成');
  check((await page.locator('details[open]').count()) === 1, '调查完成后丢失证据展开状态');
  passed.push('状态变化保留证据展开');
  await page.getByRole('button', { name: /加载更多证据/ }).click();
  await waitFor(() => document.querySelectorAll('.evidence-item').length === 2);
  check(
    await page.getByRole('button', { name: '证据已全部加载' }).isDisabled(),
    '没有正确标记证据读取完成',
  );
  passed.push('新证据插入已读范围之前仍可加载，且不会重复');
  evidenceCount = 1;
  detailStatus = 'running';
  await page.evaluate(() => {
    location.hash = '#investigation/event-race';
  });
  holdEvidence = new Promise((resolve) => {
    releaseEvidence = resolve;
  });
  const evidenceRequest = page.waitForRequest((request) => request.url().includes('/evidence'));
  await page.getByRole('button', { name: '查看证据 (1)' }).click();
  await evidenceRequest;
  evidenceCount = 2;
  detailStatus = 'completed';
  await page.getByRole('button', { name: '↻ 刷新详情' }).click();
  await waitFor(() => document.querySelector('.metadata .status').textContent === '已完成');
  releaseEvidence();
  await page.getByRole('button', { name: /加载更多证据/ }).waitFor();
  await page.getByRole('button', { name: /加载更多证据/ }).click();
  await waitFor(() => document.querySelectorAll('.evidence-item').length === 2);
  passed.push('延迟证据响应与完成状态交错后仍能加载新增证据');
  evidenceCount = 1;
  await page.evaluate(() => {
    location.hash = '#investigation/event-evidence-ahead';
  });
  await page.getByRole('button', { name: '查看证据 (1)' }).waitFor();
  evidenceCount = 2;
  await page.getByRole('button', { name: '查看证据 (1)' }).click();
  await waitFor(() => document.querySelectorAll('.evidence-item').length === 2);
  await page.getByRole('button', { name: '↻ 刷新详情' }).click();
  await page.getByRole('button', { name: '证据已全部加载' }).waitFor();
  check(
    await page.getByRole('button', { name: '证据已全部加载' }).isDisabled(),
    '详情计数追上已读证据后不应显示更多按钮',
  );
  passed.push('证据已提前读完时计数更新不显示零条更多');
  mode = 'post-retry';
  postBodies = [];
  await page.getByRole('textbox', { name: '追问内容' }).fill('保留并重试追问');
  await page.getByRole('button', { name: '提交追问 →' }).click();
  await waitFor(() =>
    document.querySelector('.followup .error-text').textContent.includes('原内容会保留'),
  );
  await page.getByRole('button', { name: '提交追问 →' }).click();
  await waitFor(() => document.querySelector('textarea').value === '');
  check(
    postBodies.length === 2 && postBodies[0].messageId === postBodies[1].messageId,
    '重试追问没有复用幂等编号',
  );
  passed.push('失败追问保留内容与幂等编号');
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.getByRole('link', { name: '目标配置 只读' }).click();
  await page.getByRole('heading', { name: '目标配置', exact: true }).waitFor();
  await waitFor(() => scrollY === 0 && document.activeElement.id === 'main');
  passed.push('路由切换返回页首并管理焦点');
  mode = 'history';
  historySize = 1;
  await page.evaluate(() => {
    location.hash = '#investigation/event-history';
  });
  await waitFor(() => document.querySelectorAll('.turn').length === 1);
  historySize = 45;
  await page.getByRole('button', { name: '↻ 刷新详情' }).click();
  await waitFor(() => document.querySelectorAll('.turn').length === 45);
  check(
    await page
      .locator('.turn-header strong')
      .allTextContents()
      .then((names) => new Set(names).size === 45),
    '补读轮次有缺失或重复',
  );
  passed.push('一次新增超过20轮后补齐中间缺页');
  mode = '';
  canContinue = false;
  await page.evaluate(() => {
    location.hash = '#investigation/event-old-scope';
  });
  await page
    .getByText('目标配置已变化，此调查的历史记录仍可查看。继续排障请使用当前目标发起新调查。')
    .waitFor();
  check(
    await page.getByRole('button', { name: '提交追问 →' }).isDisabled(),
    '配置已变化的历史调查仍允许追问',
  );
  check(
    await page.getByRole('textbox', { name: '追问内容' }).isDisabled(),
    '历史调查没有禁用追问输入',
  );
  passed.push('旧配置调查保留历史报告并明确禁用执行');
  canContinue = true;
  await page.getByRole('link', { name: '排障记录', exact: true }).click();
  mode = 'transient-detail';
  detailReads = 0;
  detailStatus = 'running';
  await page.evaluate(() => {
    location.hash = '#investigation/event-0';
  });
  await waitFor(() => document.querySelector('.metadata .status')?.textContent === '调查中');
  await waitFor(() =>
    document.querySelector('#content .error-text')?.textContent.includes('暂时不可用'),
  );
  detailStatus = 'completed';
  await waitFor(() => document.querySelector('.metadata .status')?.textContent === '已完成');
  check(detailReads >= 3, '暂时失败后没有继续轮询');
  passed.push('网络恢复后继续自动刷新');
  await page.getByRole('button', { name: '退出登录' }).click();
  check((await page.locator('#content').textContent()) === '', '退出后保留了调查内容');
  holdLogin = new Promise((resolve) => {
    releaseLogin = resolve;
  });
  const candidate = page.getByRole('textbox', { name: '访问 Token' });
  await candidate.fill('UI_SYNTHETIC_TOKEN');
  await page.getByRole('button', { name: '登录控制台' }).click();
  // A pending login must not cause navigation to issue data reads or paint protected views.
  const count = requests.length;
  await page.getByRole('link', { name: '目标配置 只读' }).click();
  check(requests.length === count, '登录完成前导航触发了受保护数据请求');
  releaseLogin();
  await waitFor(() => document.querySelector('#connection-state').textContent.includes('已登录'));
  await page.getByRole('heading', { name: '目标配置', exact: true }).waitFor();
  passed.push('登录过程中导航不会提前进入后台');
  targetFailure = true;
  await page.getByRole('button', { name: '↻ 刷新配置' }).click();
  await waitFor(() => document.querySelector('#connect-error').textContent.includes('重新登录'));
  check((await page.locator('#content').textContent()) === '', '认证失效后保留了后台内容');
  passed.push('认证失效清空后台数据');
  await page.setViewportSize({ width: 390, height: 844 });
  check(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    '窄屏出现整页横向溢出',
  );
  check(
    await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0),
    '浏览器存储中保留了凭证',
  );
  passed.push('窄屏与凭证存储检查');
  check(pageErrors.length === 0, '浏览器脚本异常：' + pageErrors.join('; '));
  console.log('ADMIN_UI_CHECKS ' + JSON.stringify(passed));
  return { passed: passed.length, checks: passed };
}
