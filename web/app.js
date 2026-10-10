/**
 * AI Art Studio · 控制台前端。
 *
 * 设计取向：
 *  - 零外部依赖（无 CDN、无框架），断网可用 —— 美术团队常在隔离网段作业；
 *  - 所有枚举（错误码、规范集、提供方能力、转换选项）由 /api/system/meta 自描述，
 *    前端不硬编码，后端加一个提供方无需改前端；
 *  - 错误按统一信封消费：只认 code / message / retryable，不解析文案；
 *  - 长任务一律「提交即返回 + SSE 订阅」，UI 永远可交互，不会卡在转圈。
 */

/* ============================== 基础工具 ============================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.setAttribute('style', v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 2 : 0)} ${u[i]}`;
}

function fmtTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const t = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return sameDay ? t : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${t}`;
}

function fmtDur(ms) {
  if (ms === null || ms === undefined) return '–';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

const RULE_LABELS = {
  'decode.failed': '图像解码失败', 'io.missing': '文件缺失', 'size.tooSmall': '尺寸过小', 'size.tooLarge': '尺寸超限',
  'size.notPowerOfTwo': '尺寸非 2 的幂', 'size.aspectRatio': '长宽比异常', 'size.fileTooLarge': '体积过大',
  'size.fileTooSmall': '体积过小', 'alpha.required': '缺少透明通道', 'alpha.forbidden': '多余透明通道',
  'format.notAllowed': '格式不在白名单', 'content.blank': '疑似空白图', 'content.lowVariance': '内容差异度低',
  'duplicate.detected': '重复资产', 'pattern.mismatch': '不符合命名模板', 'charset.forbidden': '含禁止字符',
  'word.forbidden': '含禁用词', 'ext.notAllowed': '扩展名不合规', 'case.style': '大小写风格不符',
  'token.missing': '缺少必需字段', 'length.max': '文件名超长', 'length.min': '文件名过短',
  'inspect.exception': '检查异常', 'content.statsFailed': '统计失败',
};
const ruleLabel = (r) => RULE_LABELS[r] || r;

const JOB_STATUS_META = {
  queued: { label: '排队中', chip: 'neutral' }, running: { label: '执行中', chip: 'info' },
  succeeded: { label: '成功', chip: 'ok' }, partial: { label: '部分成功', chip: 'warn' },
  failed: { label: '失败', chip: 'err' }, canceled: { label: '已取消', chip: 'neutral' },
};
const KIND_LABELS = { generate: '批量生成', convert: '格式转换', inspect: '资产检查', pack: '打包', delivery: '全链路交付' };

/* ============================== API 客户端 ============================== */

const api = {
  async request(method, path, body, opts = {}) {
    const init = { method, headers: {}, ...opts };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (err) {
      throw { code: 'E_NETWORK', message: `网络不可达：${err.message}`, retryable: true, domain: 'SYS' };
    }
    const json = await res.json().catch(() => null);
    if (!json) throw { code: 'E_BAD_RESPONSE', message: `服务返回非 JSON（HTTP ${res.status}）`, retryable: true, domain: 'SYS' };
    if (!json.success) throw { ...(json.error || {}), code: json.code, message: json.message, requestId: json.requestId };
    return json.data;
  },
  get: (p) => api.request('GET', p),
  post: (p, b) => api.request('POST', p, b),
  patch: (p, b) => api.request('PATCH', p, b),
};

function toast(title, body, kind = 'ok', code) {
  const el = h('div', { class: `toast ${kind}` }, [
    h('div', { class: 'tt', text: title }),
    body ? h('div', { class: 'tb', text: body }) : null,
    code ? h('div', { class: 'code', text: code }) : null,
  ]);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 9000 : 4500);
}

function failToast(err, ctxLabel = '') {
  const retryable = err?.retryable ? '（可重试）' : '';
  toast(`${ctxLabel}失败${retryable}`, err?.message || '未知错误', 'err', [err?.code, err?.requestId].filter(Boolean).join(' · '));
}

/* ============================== 全局状态 ============================== */

const state = { meta: null, providers: [], jobs: [], currentView: 'dashboard', fileBags: { conv: [], ins: [] } };

/* ============================== 复用组件 ============================== */

/** 进度面板：进度条 + 阶段 + 日志。 */
function jobProgressNode() {
  return h('div', {}, [
    h('div', { class: 'progress-head' }, [
      h('span', { class: 'st', text: '排队中' }),
      h('span', { class: 'pc', text: '0%' }),
    ]),
    h('div', { class: 'progress' }, [h('i', { style: 'width:0%' })]),
    h('div', { class: 'job-log', style: 'display:none' }),
  ]);
}

function updateProgressNode(node, job) {
  const meta = JOB_STATUS_META[job.status] || { label: job.status };
  const bar = $('.progress', node);
  const fill = $('.progress i', node);
  $('.st', node).textContent = `${job.stage || meta.label}${job.attempts > 1 ? `（第 ${job.attempts} 次尝试）` : ''}`;
  $('.pc', node).textContent = `${job.progress ?? 0}%`;
  fill.style.width = `${job.progress ?? 0}%`;
  bar.className = `progress ${['succeeded'].includes(job.status) ? 'ok' : ['failed', 'canceled'].includes(job.status) ? 'err' : ''}`;
  if (job.logs?.length) {
    const log = $('.job-log', node);
    log.style.display = '';
    log.innerHTML = job.logs.slice(-40).map((l) => `<div class="lv-${l.level}"><span class="ts">${fmtTime(l.ts)}</span>${esc(l.message)}</div>`).join('');
    log.scrollTop = log.scrollHeight;
  }
}

/** 产物网格。 */
function artifactGrid(artifacts, { empty = '暂无产物' } = {}) {
  if (!artifacts?.length) return h('div', { class: 'empty', text: empty });
  const grid = h('div', { class: 'artifact-grid' });
  for (const a of artifacts) {
    if (a.type === 'package') {
      grid.append(h('div', { class: 'artifact', onclick: () => openPackage(a.file) }, [
        h('div', { class: 'thumb' }, [h('div', { class: 'noimg', style: 'color:#98a2b3;font-size:12px', text: 'ZIP 交付包' })]),
        h('div', { class: 'meta' }, [
          h('div', { class: 'fn', title: a.file, text: a.file }),
          h('div', { class: 'sub' }, [h('span', { text: `${a.assetCount || 0} 项` }), h('span', { text: a.bytesText || '' })]),
        ]),
      ]));
      continue;
    }
    const score = a.score;
    const scoreCls = score === null || score === undefined ? '' : a.qaOk === false ? 'err' : score < 90 ? 'warn' : '';
    const url = a.workspacePath ? `/api/workspace/file?path=${encodeURIComponent(a.workspacePath)}` : '';
    const card = h('div', {
      class: 'artifact',
      onclick: () => url && openLightbox(url, `${a.file}\n${a.width}×${a.height} · ${a.format || ''} · ${a.bytesText || ''}`),
    }, [
      h('div', { class: 'thumb' }, [
        url ? h('img', { src: url, loading: 'lazy', alt: a.file }) : h('div', { class: '', text: '无预览' }),
        score !== null && score !== undefined ? h('span', { class: `score ${scoreCls}`, text: String(score) }) : null,
      ]),
      h('div', { class: 'meta' }, [
        h('div', { class: 'fn', title: a.file, text: a.file }),
        h('div', { class: 'sub' }, [
          h('span', { text: `${a.width || '?'}×${a.height || '?'}` }),
          h('span', { text: a.bytesText || fmtBytes(a.bytes) }),
        ]),
      ]),
    ]);
    grid.append(card);
  }
  return grid;
}

let lightboxNode = null;
function openLightbox(url, caption) {
  $('#lightboxImg').src = url;
  $('#lightboxCap').textContent = caption || '';
  lightboxNode = $('#lightbox');
  lightboxNode.hidden = false;
}

/** 从任务节点收集一个可选任务下拉。 */
function fillJobSelect(sel, filterKinds) {
  const prev = sel.value;
  const items = state.jobs.filter((j) => (filterKinds ? filterKinds.includes(j.kind) : true) && ['succeeded', 'partial'].includes(j.status));
  sel.innerHTML = '';
  if (!items.length) sel.append(h('option', { value: '', text: '（暂无可选任务，请先跑一个任务）' }));
  for (const j of items) {
    sel.append(h('option', { value: j.id, text: `[${KIND_LABELS[j.kind] || j.kind}] ${j.name} · ${j.artifacts} 项` }));
  }
  if (prev && items.some((j) => j.id === prev)) sel.value = prev;
}

/* ============================== 任务监控 ============================== */

/**
 * 订阅任务 SSE，返回 { close }。
 * 事件源在任务终态会自动结束，这里额外做一次兜底轮询，防止代理丢弃 SSE。
 */
function watchJob(jobId, handlers = {}) {
  let closed = false;
  let lastProgress = 0;
  const es = new EventSource(`/api/jobs/${jobId}/events`);
  const close = () => {
    if (closed) return;
    closed = true;
    es.close();
  };

  const emit = (job) => {
    lastProgress = job.progress || 0;
    handlers.onUpdate?.(job);
    if (['succeeded', 'failed', 'partial', 'canceled'].includes(job.status)) {
      close();
      handlers.onFinish?.(job);
    }
  };

  es.addEventListener('snapshot', (e) => emit(JSON.parse(e.data)));
  es.addEventListener('progress', (e) => emit(JSON.parse(e.data)));
  es.addEventListener('finished', (e) => emit(JSON.parse(e.data)));
  es.addEventListener('log', (e) => handlers.onLog?.(JSON.parse(e.data)));
  es.addEventListener('artifact', (e) => handlers.onArtifact?.(JSON.parse(e.data)));
  es.onerror = () => {
    if (closed) return;
    es.close();
    // 兜底：SSE 不可用时退回轮询
    const poll = async () => {
      if (closed) return;
      try {
        const { job } = await api.get(`/api/jobs/${jobId}`);
        emit(job);
        if (!['succeeded', 'failed', 'partial', 'canceled'].includes(job.status)) setTimeout(poll, 1200);
      } catch {
        setTimeout(poll, 2500);
      }
    };
    setTimeout(poll, 800);
  };
  void lastProgress;

  return { close };
}

/** 通用「提交 → 进度 → 结果」面板。 */
function attachJobPanel({ cardId, nodeId, nameId, startLabel }) {
  const card = $(cardId);
  const node = $(nodeId);
  card.hidden = false;
  $(nameId).textContent = startLabel || '';
  return { card, node, progress: renderInto(node) };
}

function renderInto(container) {
  container.innerHTML = '';
  const p = jobProgressNode();
  container.append(p);
  return p;
}

/* ============================== 视图：总览 ============================== */

async function loadDashboard() {
  let data;
  try {
    data = await api.get('/api/stats/overview');
  } catch (err) {
    $('#dashProviders').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  const { jobs, outputs, recent, providers: provs } = data;
  const online = provs.filter((p) => p.ok).length;

  $('#kpiGrid').innerHTML = '';
  const kpis = [
    { k: '任务总数', v: jobs.total, s: `${jobs.counts.running} 执行中 · ${jobs.counts.queued} 排队中`, cls: '' },
    { k: '成功 / 失败', v: `${jobs.counts.succeeded} / ${jobs.counts.failed}`, s: `部分成功 ${jobs.counts.partial}`, cls: jobs.counts.failed ? 'warn' : 'ok' },
    { k: '产出资产', v: outputs.files, s: `${outputs.bytesText} 落盘`, cls: 'brand' },
    { k: '交付包', v: outputs.packs, s: '可直接发给下游', cls: '' },
    { k: '提供方在线', v: `${online}/${provs.length}`, s: online ? '可正常调用' : '全部不可用', cls: online ? 'ok' : 'err' },
    { k: '队列占用', v: `${data.queue.running}`, s: `并发上限 ${data.queue.global.limit} · 等待 ${data.queue.pending}`, cls: data.queue.pending > 5 ? 'warn' : '' },
  ];
  for (const k of kpis) {
    $('#kpiGrid').append(
      h('div', { class: `kpi ${k.cls}` }, [h('div', { class: 'k', text: k.k }), h('div', { class: 'v', text: String(k.v) }), h('div', { class: 's', text: k.s })])
    );
  }

  $('#dashProviders').innerHTML = '';
  for (const p of provs) {
    $('#dashProviders').append(
      h('div', { class: 'bar-row', style: 'grid-template-columns:auto 1fr auto' }, [
        h('span', {}, [h('span', { class: `dot ${p.ok ? 'ok' : 'bad'}` })]),
        h('span', { class: 'lbl' }, [h('strong', { text: p.label })]),
        h('span', { class: 'n', style: 'font-size:11.5px;font-weight:400', text: p.detail || '' }),
      ])
    );
  }

  // 规则命中：从最近检查任务里聚合
  const inspectJobs = recent.filter((j) => j.kind === 'inspect' || j.kind === 'delivery');
  let ruleAgg = null;
  for (const j of inspectJobs) {
    try {
      const { job } = await api.get(`/api/jobs/${j.id}`);
      const sum = j.kind === 'delivery' ? job.result?.inspect?.summary : job.result?.summary;
      if (sum?.byRule?.length) {
        ruleAgg = ruleAgg || {};
        for (const r of sum.byRule) ruleAgg[r.rule] = (ruleAgg[r.rule] || 0) + r.count;
      }
    } catch { /* 忽略 */ }
    if (ruleAgg && Object.keys(ruleAgg).length >= 8) break;
  }
  const rulesBox = $('#dashRules');
  rulesBox.innerHTML = '';
  if (!ruleAgg) {
    rulesBox.append(h('div', { class: 'empty', text: '暂无检查数据，去「命名与资产检查」跑一次' }));
  } else {
    const rows = Object.entries(ruleAgg).sort((a, b) => b[1] - a[1]).slice(0, 9);
    const max = rows[0][1] || 1;
    for (const [rule, count] of rows) {
      rulesBox.append(
        h('div', { class: 'bar-row' }, [
          h('span', { class: 'lbl', title: rule, text: ruleLabel(rule) }),
          h('span', { class: 'track' }, [h('i', { style: `width:${(count / max) * 100}%` })]),
          h('span', { class: 'n', text: String(count) }),
        ])
      );
    }
  }

  $('#dashRecent').innerHTML = '';
  $('#dashRecent').append(jobsTable(recent, { compact: true }));
  fillJobSelect($('#convJob'), ['generate', 'convert']);
  fillJobSelect($('#insJob'), ['generate', 'convert']);
  fillJobSelect($('#pkJob'), ['generate', 'convert', 'inspect']);
}

/* ============================== 视图：任务表 ============================== */

function jobsTable(jobs, { compact = false, onOpen } = {}) {
  if (!jobs?.length) return h('div', { class: 'empty', text: '暂无任务' });
  const wrap = h('div', { class: 'table-wrap' });
  const tbody = h('tbody');
  for (const j of jobs) {
    const sm = JOB_STATUS_META[j.status] || { label: j.status, chip: 'neutral' };
    const tr = h('tr', { class: 'clickable', onclick: () => (onOpen ? onOpen(j) : openJobDrawer(j.id)) }, [
      h('td', {}, [
        h('div', { class: 'name', title: j.name, text: j.name }),
        h('div', { class: 'tiny mono', text: j.id }),
      ]),
      h('td', {}, [h('span', { class: 'chip neutral', text: KIND_LABELS[j.kind] || j.kind })]),
      h('td', {}, [
        h('span', { class: `chip ${sm.chip}`, text: sm.label }),
        j.status === 'running' || j.status === 'queued'
          ? h('div', { class: 'progress', style: 'margin-top:5px;height:4px;width:120px' }, [h('i', { style: `width:${j.progress}%` })])
          : null,
      ]),
      compact ? null : h('td', { class: 'tiny' }, [h('div', { text: j.stage || '–' }), h('div', { text: j.error?.code || '' })]),
      h('td', { class: 'num' }, [h('div', { text: String(j.counts?.succeeded ?? 0) }), h('div', { class: 'tiny', text: j.artifacts ? `${j.artifacts} 产物` : '' })]),
      h('td', { class: 'tiny nowrap' }, [h('div', { text: fmtTime(j.createdAt) }), h('div', { text: fmtDur(j.durationMs) })]),
    ]);
    tbody.append(tr);
  }
  wrap.append(
    h('table', { class: 'table' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', { text: '任务' }), h('th', { text: '类型' }), h('th', { text: '状态' }),
        compact ? null : h('th', { text: '阶段 / 错误' }),
        h('th', { class: 'num', text: '成功数' }), h('th', { text: '时间 / 耗时' }),
      ])]),
      tbody,
    ])
  );
  return wrap;
}

async function loadJobs() {
  const params = new URLSearchParams({ pageSize: '60' });
  if ($('#jobStatusFilter').value) params.set('status', $('#jobStatusFilter').value);
  if ($('#jobKindFilter').value) params.set('kind', $('#jobKindFilter').value);
  if ($('#jobKeyword').value.trim()) params.set('keyword', $('#jobKeyword').value.trim());
  try {
    const data = await api.get(`/api/jobs?${params}`);
    state.jobs = data.items;
    $('#jobsSub').textContent = `共 ${data.pagination.total} 个任务`;
    $('#jobsTable').innerHTML = '';
    $('#jobsTable').append(jobsTable(data.items));
    fillJobSelect($('#convJob'), ['generate', 'convert']);
    fillJobSelect($('#insJob'), ['generate', 'convert']);
    fillJobSelect($('#pkJob'), ['generate', 'convert', 'inspect']);
  } catch (err) {
    $('#jobsTable').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

/* ============================== 任务详情抽屉 ============================== */

async function openJobDrawer(jobId) {
  $('#drawerMask').hidden = false;
  $('#drawer').hidden = false;
  $('#drawerTitle').textContent = '任务详情';
  $('#drawerId').textContent = jobId;
  $('#drawerBody').innerHTML = '<div class="empty">加载中…</div>';
  let job;
  try {
    ({ job } = await api.get(`/api/jobs/${jobId}`));
  } catch (err) {
    $('#drawerBody').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  $('#drawerTitle').textContent = job.name;
  const body = $('#drawerBody');
  body.innerHTML = '';

  const sm = JOB_STATUS_META[job.status] || { label: job.status, chip: 'neutral' };
  body.append(
    h('div', { class: 'card' }, [
      h('div', { class: 'card-body' }, [
        h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px' }, [
          h('span', { class: `chip ${sm.chip}`, text: sm.label }),
          h('span', { class: 'chip neutral', text: KIND_LABELS[job.kind] || job.kind }),
          job.providerId ? h('span', { class: 'chip purple', text: job.providerId }) : null,
          h('span', { class: 'chip mono', text: job.id }),
          h('span', { class: 'hint', text: `尝试 ${job.attempts}/${job.maxRetries + 1}` }),
        ]),
        (() => {
          const box = h('div');
          const p = jobProgressNode();
          updateProgressNode(p, job);
          box.append(p);
          return box;
        })(),
        h('div', { class: 'stage-track' }, [
          statCell('创建', fmtTime(job.createdAt)),
          statCell('开始', fmtTime(job.startedAt)),
          statCell('结束', fmtTime(job.finishedAt)),
          statCell('耗时', fmtDur(job.durationMs)),
          statCell('成功 / 失败', `${job.counts?.succeeded ?? 0} / ${job.counts?.failed ?? 0}`),
        ]),
        h('div', { class: 'action-bar', style: 'margin-top:14px' }, [
          ['queued', 'running'].includes(job.status) ? h('button', { class: 'btn danger sm', onclick: () => doCancel(job.id) }, ['取消任务']) : null,
          ['failed', 'canceled', 'partial', 'succeeded'].includes(job.status) ? h('button', { class: 'btn ghost sm', onclick: () => doRetry(job.id) }, ['按原参数重跑']) : null,
        ]),
      ]),
    ])
  );

  if (job.error) {
    body.append(
      h('div', { class: 'card' }, [
        h('div', { class: 'card-head' }, [h('h2', { text: '错误详情' })]),
        h('div', { class: 'card-body' }, [
          h('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:8px' }, [
            h('span', { class: 'chip err mono', text: job.error.code }),
            h('span', { class: 'chip neutral', text: job.error.domain || '' }),
            h('span', { class: `chip ${job.error.retryable ? 'warn' : 'neutral'}`, text: job.error.retryable ? '可重试' : '不可重试' }),
          ]),
          h('div', { text: job.error.message }),
          job.error.details ? h('div', { class: 'reader', style: 'margin-top:10px', text: JSON.stringify(job.error.details, null, 2) }) : null,
        ]),
      ])
    );
  }

  if (job.result) body.append(resultSection(job));
  if (job.artifacts?.length) {
    body.append(
      h('div', { class: 'card' }, [
        h('div', { class: 'card-head' }, [h('h2', { text: `产物（${job.artifacts.length}）` })]),
        h('div', { class: 'card-body' }, [artifactGrid(job.artifacts)]),
      ])
    );
  }
  if (job.logs?.length) {
    body.append(
      h('div', { class: 'card' }, [
        h('div', { class: 'card-head' }, [h('h2', { text: '执行日志' })]),
        h('div', { class: 'card-body' }, [
          h('div', { class: 'job-log' }, job.logs.map((l) => h('div', { class: `lv-${l.level}` }, [
            h('span', { class: 'ts', text: fmtTime(l.ts) }), document.createTextNode(l.message),
          ]))),
        ]),
      ])
    );
  }
}

function statCell(label, value) {
  return h('div', { class: 'stage' }, [h('div', { class: 'sn', text: label }), h('div', { class: 'sv', text: value })]);
}

/** 把不同任务类型的结果渲染成适合阅读的区块。 */
function resultSection(job) {
  const r = job.result;
  const children = [h('div', { class: 'card-head' }, [h('h2', { text: '结果摘要' })])];
  const blocks = [];

  if (r.summary) {
    const s = r.summary;
    blocks.push(block('生成汇总', [
      ['计划生成项', s.plannedItems], ['计划出图', s.plannedImages], ['实际产出', s.generated],
      ['失败项', s.failedItems], ['总耗时', fmtDur(s.durationMs)], ['平均单张耗时', `${s.avgMsPerImage}ms`],
      ['体积', s.totalBytesText], ['自动质检均分', s.avgScore ?? '未启用'], ['质检未通过', s.qaFailed],
    ]));
    if (Object.keys(s.byCode || {}).length) {
      blocks.push(h('div', { style: 'margin-top:12px' }, [
        h('div', { class: 'hint', style: 'margin-bottom:6px', text: '失败原因分布' }),
        h('div', {}, Object.entries(s.byCode).map(([c, n]) => h('span', { class: 'chip err', style: 'margin:0 6px 6px 0', text: `${c} × ${n}` }))),
      ]));
    }
  }
  if (r.savings) {
    blocks.push(block('转换收益', [
      ['输入体积', r.savings.inputBytesText], ['输出体积', r.savings.outputBytesText],
      ['节省', `${r.savings.ratio}%（${fmtBytes(r.savings.savedBytes)}）`], ['耗时', fmtDur(r.durationMs)],
    ]));
  }
  if (r.inspect?.summary || r.summary?.passRate !== undefined) {
    const s = r.inspect?.summary || r.summary;
    blocks.push(block('质检结果', [
      ['资产数', s.total], ['通过', s.passed], ['未通过', s.failed],
      ['通过率', `${(s.passRate * 100).toFixed(1)}%`], ['平均健康分', s.avgScore],
      ['阻断 / 警告 / 提示', `${s.byLevel.error} / ${s.byLevel.warn} / ${s.byLevel.info}`],
      ['重复对', s.duplicatePairs],
    ]));
  }
  if (r.package) {
    blocks.push(h('div', { style: 'margin-top:12px' }, [
      h('div', { class: 'hint', style: 'margin-bottom:6px', text: '交付包' }),
      h('div', { class: 'reader' }, [
        `文件：${r.package.file}\n体积：${r.package.bytesText}\n资产：${r.package.assetCount} 项\nsha256：${r.package.sha256}\n结构：${r.package.structure === 'byCategory' ? '按品类分目录' : '扁平'}\n\n包内条目：\n` +
          (r.package.entries || []).map((e) => `  ${e.name}  ${fmtBytes(e.bytes)}`).join('\n'),
      ]),
      h('div', { class: 'action-bar', style: 'margin-top:10px' }, [
        h('a', { class: 'btn primary sm', href: `/api/packages/${encodeURIComponent(r.package.file)}/download` }, ['下载交付包']),
        h('a', { class: 'btn ghost sm', href: reportUrl(r.package.file), target: '_blank' }, ['查看质检报告']),
      ]),
    ]));
  }
  if (r.stages) {
    blocks.push(h('div', { class: 'stage-track' }, r.stages.map((s) =>
      h('div', { class: `stage ${s.ok === false ? 'fail' : s.skipped ? '' : 'done'}` }, [
        h('div', { class: 'sn', text: s.stage }),
        h('div', { class: 'sv', text: s.skipped ? '已跳过' : `${s.produced} 项` }),
      ])
    )));
  }
  if (r.failures?.length) {
    blocks.push(h('div', { style: 'margin-top:12px' }, [
      h('div', { class: 'hint', style: 'margin-bottom:6px', text: `失败明细（${r.failures.length}）` }),
      h('div', { class: 'table-wrap' }, [
        h('table', { class: 'table' }, [
          h('thead', {}, [h('tr', {}, [h('th', { text: '文件' }), h('th', { text: '错误码' }), h('th', { text: '原因' })])]),
          h('tbody', {}, r.failures.map((f) => h('tr', {}, [
            h('td', { class: 'mono', text: f.source }), h('td', {}, [h('span', { class: 'chip err mono', text: f.code })]), h('td', { class: 'tiny', text: f.message }),
          ]))),
        ]),
      ]),
    ]));
  }

  children.push(h('div', { class: 'card-body' }, blocks));
  return h('div', { class: 'card' }, children);
}

function block(title, pairs) {
  return h('div', { style: 'margin-bottom:6px' }, [
    h('div', { class: 'hint', style: 'margin-bottom:8px', text: title }),
    h('div', { class: 'grid-3' }, pairs.map(([k, v]) =>
      h('div', { style: 'border:1px solid var(--line);border-radius:8px;padding:9px 12px' }, [
        h('div', { class: 'sn', style: 'font-size:11.5px;color:var(--ink-3)', text: k }),
        h('div', { style: 'font-weight:600;font-variant-numeric:tabular-nums', text: String(v ?? '–') }),
      ])
    )),
  ]);
}

function reportUrl(fileName) {
  // report.html 在 zip 内；服务端另提供 preview 端点用于直接查看包内报告
  return `/api/packages/${encodeURIComponent(fileName)}/preview`;
}

function openPackage(fileName) {
  window.open(`/api/packages/${encodeURIComponent(fileName)}/download`, '_blank');
}

async function doCancel(jobId) {
  try {
    await api.post(`/api/jobs/${jobId}/cancel`, {});
    toast('已发送取消信号', '排队任务立即取消，执行中任务将在当前步骤收尾后停止');
    await loadJobs();
    await openJobDrawer(jobId);
  } catch (err) {
    failToast(err, '取消');
  }
}

async function doRetry(jobId) {
  try {
    await api.post(`/api/jobs/${jobId}/retry`, {});
    toast('已按原参数重新排队', jobId);
    await loadJobs();
    await openJobDrawer(jobId);
  } catch (err) {
    failToast(err, '重跑');
  }
}

/* ============================== 视图：批量生成 ============================== */

function providerOptions(sel, { onlyEnabled = false } = {}) {
  const prev = sel.value;
  sel.innerHTML = '';
  for (const p of state.providers) {
    if (onlyEnabled && !p.enabled) continue;
    sel.append(h('option', { value: p.id, text: `${p.label}${p.enabled ? '' : '（已禁用）'}` }));
  }
  if (prev) sel.value = prev;
  if (state.meta?.activeProvider) sel.value = sel.value || state.meta.activeProvider;
}

function updateModelOptions(sel, providerId) {
  const p = state.providers.find((x) => x.id === providerId);
  sel.innerHTML = '';
  for (const m of p?.models || []) sel.append(h('option', { value: m, text: m }));
}

function parseNumList(str) {
  return String(str || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isFinite(n));
}

function parseVariants(str) {
  const out = [];
  for (const part of String(str || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [suffix, scale] = part.split(':');
    out.push({ suffix: suffix || '', scale: Number(scale) || 1 });
  }
  return out;
}

function genPayload() {
  const providerId = $('#genProvider').value;
  const naming = {
    preset: $('#genNamingPreset').value,
    tokens: {
      category: $('#genCategory').value.trim() || undefined,
      state: $('#genState').value.trim() || undefined,
      name: $('#genName').value.trim() || undefined,
    },
  };
  const postProcess = {};
  if ($('#genAutoInspect').checked) postProcess.inspect = { namingPreset: naming.preset, alphaPolicy: 'any' };
  if ($('#genAutoConvert').checked) {
    postProcess.convert = {
      format: $('#genConvFormat').value,
      quality: Number($('#genConvQuality').value),
      resize: { mode: 'maxEdge', maxEdge: Number($('#genConvEdge').value) },
      namingPreset: naming.preset,
    };
  }
  return {
    providerId,
    prompts: $('#genPrompts').value.split('\n').map((s) => s.trim()).filter(Boolean),
    base: {
      width: Number($('#genWidths').value.split(',')[0]) || 1024,
      height: Number($('#genHeights').value.split(',')[0]) || 1024,
      steps: Number($('#genSteps').value),
      cfgScale: Number($('#genCfg').value),
      model: $('#genModel').value,
      stylePreset: $('#genStyle').value.trim() || 'none',
      negativePrompt: $('#genNegative').value.trim(),
    },
    matrix: { width: parseNumList($('#genWidths').value), height: parseNumList($('#genHeights').value) },
    countPerPrompt: Number($('#genCount').value),
    seedMode: $('#genSeedMode').value,
    seedStart: Number($('#genSeed').value),
    naming,
    postProcess,
    outputSubdir: $('#genSubdir').value.trim(),
  };
}

async function previewPlan() {
  const btn = $('#btnGenPlan');
  btn.disabled = true;
  try {
    const p = await api.post('/api/generate/plan', genPayload());
    const box = $('#genPlanBox');
    box.innerHTML = '';
    box.append(
      h('div', {}, [
        `提示词 ${p.prompts} 条 × 矩阵维度 [${p.matrixDims.join(', ') || '无'}] → 生成项 ${p.items.length} 个`,
        h('br'),
        `合计出图 `, h('span', { class: 'v', text: String(p.totalImages) }), ` 张 · 预计排队耗时约 `, h('span', { class: 'v', text: `${p.estimate.queueSeconds}s` }),
        h('br'),
        `应用规范 `, h('span', { class: 'v', text: p.ruleset?.pattern || '–' }),
        h('br'),
        h('span', { class: 'muted', text: p.estimate.note }),
        h('br'), h('br'),
        h('span', { class: 'k', text: '预计产物命名（每条提示词第 1 张）：' }),
        h('br'),
        ...p.preview.slice(0, 5).flatMap((it) => [
          h('span', { class: 'muted', text: `  · ${it.size} ` }),
          h('span', { class: 'v', text: it.fileName }),
          h('br'),
        ]),
      ])
    );
    $('#genHint').textContent = `已预演：${p.totalImages} 张`;
    toast('计划预演完成', `${p.items.length} 个生成项 / ${p.totalImages} 张图`);
  } catch (err) {
    failToast(err, '预演');
  } finally {
    btn.disabled = false;
  }
}

let genWatch = null;
async function runGenerate() {
  const btn = $('#btnGenRun');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 提交中';
  try {
    const res = await api.post('/api/generate', genPayload());
    toast('生成任务已受理', res.job.name, 'ok', res.job.id);
    $('#genJobName').textContent = res.job.name;
    $('#genResultCard').hidden = true;
    const p = attachJobPanel({ cardId: '#genRunCard', nodeId: '#genRun', nameId: '#genJobName', startLabel: res.job.name });
    updateProgressNode(p.progress, res.job);
    genWatch?.close();
    const arts = [];
    genWatch = watchJob(res.job.id, {
      onUpdate: (job) => {
        updateProgressNode(p.progress, job);
        $('#genJobName').textContent = job.name;
      },
      onArtifact: (a) => {
        if (a.type !== 'package') {
          arts.push(a);
          renderGenGrid(arts);
        }
      },
      onFinish: (job) => {
        updateProgressNode(p.progress, job);
        const s = job.result?.summary;
        $('#genResultSub').textContent = s
          ? `产出 ${s.generated} 张 · 均分 ${s.avgScore ?? '未启用'} · ${s.totalBytesText} · 耗时 ${fmtDur(s.durationMs)}`
          : '';
        if (job.status === 'failed' || job.status === 'partial') {
          const code = job.error?.code || Object.keys(s?.byCode || {})[0];
          toast(`任务${JOB_STATUS_META[job.status].label}`, job.error?.message || `${s?.failedItems} 个生成项失败`, job.status === 'failed' ? 'err' : 'warn', code);
        } else {
          toast('批量生成完成', `${s?.generated} 张资产已落盘，可直接进入格式转换或打包`);
        }
        loadDashboard();
        loadJobs();
      },
    });
    $('#genResultCard').hidden = false;
  } catch (err) {
    failToast(err, '提交生成');
  } finally {
    btn.disabled = false;
    btn.textContent = '提交批量生成';
  }
}

function renderGenGrid(arts) {
  const box = $('#genGrid');
  box.innerHTML = '';
  box.append(artifactGrid(arts, { empty: '等待第一张产物…' }));
  if (!arts.length) return;
  const scored = arts.filter((a) => typeof a.score === 'number');
  if (scored.length) {
    const avg = (scored.reduce((s, a) => s + a.score, 0) / scored.length).toFixed(1);
    $('#genResultSub').textContent = `已产出 ${arts.length} 张 · 实时均分 ${avg}`;
  } else {
    $('#genResultSub').textContent = `已产出 ${arts.length} 张`;
  }
}

/* ============================== 视图：格式转换 ============================== */

function convPayload() {
  const source = currentSource('#convSourceSeg');
  const payload = {
    format: $('#cvFormat').value,
    quality: Number($('#cvQuality').value),
    effort: Number($('#cvEffort').value),
    resize: {
      mode: $('#cvResizeMode').value,
      maxEdge: Number($('#cvW').value),
      width: Number($('#cvW').value),
      height: Number($('#cvH').value),
      scale: 1,
    },
    variants: parseVariants($('#cvVariants').value),
    background: $('#cvBg').value || '#ffffff',
    stripMetadata: $('#cvStrip').checked,
    flattenAlpha: $('#cvFlatten').checked,
    namingPreset: $('#cvNamingPreset').value,
    outputSubdir: $('#cvSubdir').value.trim(),
    source,
    jobIds: source === 'job' ? [$('#convJob').value].filter(Boolean) : undefined,
    subdir: source === 'workspace' ? $('#convSubdir').value.trim() : undefined,
    keyword: source === 'workspace' ? $('#convKeyword').value.trim() : undefined,
  };
  return payload;
}

let cvWatch = null;
async function runConvert() {
  const source = currentSource('#convSourceSeg');
  const btn = $('#btnConvert');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 提交中';
  try {
    let res;
    if (source === 'upload') {
      const files = state.fileBags.conv;
      if (!files.length) throw { code: 'E_VALIDATION_MISSING_FIELD', message: '请先选择要转换的图片文件', retryable: false };
      const fd = new FormData();
      for (const f of files) fd.append('files', f, f.name);
      fd.append('payload', JSON.stringify({ ...convPayload(), source: 'upload' }));
      res = await api.request('POST', '/api/convert', fd);
    } else {
      res = await api.post('/api/convert', convPayload());
    }
    toast('转换任务已受理', res.job.name, 'ok', res.job.id);
    const p = attachJobPanel({ cardId: '#cvRunCard', nodeId: '#cvRun', nameId: '#cvJobName', startLabel: res.job.name });
    updateProgressNode(p.progress, res.job);
    cvWatch?.close();
    cvWatch = watchJob(res.job.id, {
      onUpdate: (job) => {
        updateProgressNode(p.progress, job);
        $('#cvHint').textContent = `${job.progress}% · ${job.stage}`;
      },
      onFinish: (job) => {
        updateProgressNode(p.progress, job);
        const s = job.result?.savings;
        if (job.status === 'failed') toast('转换失败', job.error?.message, 'err', job.error?.code);
        else toast('格式转换完成', s ? `产出 ${job.counts.succeeded} 个文件，体积变化 ${s.ratio}%` : `产出 ${job.counts.succeeded} 个文件`);
        $('#cvHint').textContent = `完成：${job.artifacts.length} 个产物`;
        loadDashboard();
        loadJobs();
      },
    });
  } catch (err) {
    failToast(err, '提交转换');
  } finally {
    btn.disabled = false;
    btn.textContent = '提交转换';
  }
}

/* ============================== 视图：资产检查 ============================== */

function insPayload() {
  const source = currentSource('#insSourceSeg');
  return {
    source,
    jobIds: source === 'job' ? [$('#insJob').value].filter(Boolean) : undefined,
    subdir: source === 'workspace' ? $('#insSubdir').value.trim() : undefined,
    namingPreset: $('#insPreset').value,
    rules: {
      namingPreset: $('#insPreset').value,
      alphaPolicy: $('#insAlpha').value,
      minEdge: Number($('#insMinEdge').value),
      maxEdge: Number($('#insMaxEdge').value),
      maxFileSizeKB: Number($('#insMaxKB').value),
      checkBlank: $('#insCheckBlank').checked,
      blankStdDevThreshold: Number($('#insBlank').value),
      detectDuplicates: $('#insDupOn').checked,
      duplicateMeanDiff: 1,
      similarMeanDiff: Number($('#insDup').value),
      maxAspectRatio: Number($('#insRatio').value),
      requirePowerOfTwo: $('#insPow2').checked,
    },
  };
}

let insWatch = null;
let lastInspectResult = null;

async function runInspect() {
  const source = currentSource('#insSourceSeg');
  const btn = $('#btnInspect');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 提交中';
  try {
    let res;
    if (source === 'upload') {
      const files = state.fileBags.ins;
      if (!files.length) throw { code: 'E_VALIDATION_MISSING_FIELD', message: '请先选择要检查的图片文件', retryable: false };
      const fd = new FormData();
      for (const f of files) fd.append('files', f, f.name);
      fd.append('payload', JSON.stringify({ ...insPayload(), source: 'upload' }));
      res = await api.request('POST', '/api/assets/inspect', fd);
    } else {
      res = await api.post('/api/assets/inspect', insPayload());
    }
    toast('检查任务已受理', res.job.name, 'ok', res.job.id);
    const p = attachJobPanel({ cardId: '#insRunCard', nodeId: '#insRun', nameId: '#insJobName', startLabel: res.job.name });
    updateProgressNode(p.progress, res.job);
    $('#insReport').hidden = true;
    insWatch?.close();
    insWatch = watchJob(res.job.id, {
      onUpdate: (job) => updateProgressNode(p.progress, job),
      onFinish: (job) => {
        updateProgressNode(p.progress, job);
        if (job.status === 'failed') {
          toast('检查失败', job.error?.message, 'err', job.error?.code);
          return;
        }
        lastInspectResult = { jobId: job.id, result: job.result, artifacts: job.artifacts };
        renderInspectReport(job.result);
        toast('资产检查完成', `通过率 ${(job.result.summary.passRate * 100).toFixed(1)}%，检出 ${job.result.summary.byLevel.error} 处阻断问题`,
          job.result.summary.byLevel.error ? 'warn' : 'ok');
        loadDashboard();
        loadJobs();
      },
    });
  } catch (err) {
    failToast(err, '提交检查');
  } finally {
    btn.disabled = false;
    btn.textContent = '提交检查';
  }
}

function renderInspectReport(result) {
  const s = result.summary;
  $('#insReport').hidden = false;

  $('#insKpi').innerHTML = '';
  for (const k of [
    { k: '资产总数', v: s.total, cls: '' },
    { k: '通过 / 未通过', v: `${s.passed} / ${s.failed}`, cls: s.failed ? 'warn' : 'ok' },
    { k: '通过率', v: `${(s.passRate * 100).toFixed(1)}%`, cls: s.passRate >= 0.95 ? 'ok' : s.passRate >= 0.8 ? 'warn' : 'err' },
    { k: '平均健康分', v: s.avgScore, cls: s.avgScore >= 90 ? 'ok' : s.avgScore >= 70 ? 'warn' : 'err' },
    { k: '阻断', v: s.byLevel.error, cls: s.byLevel.error ? 'err' : 'ok' },
    { k: '警告', v: s.byLevel.warn, cls: s.byLevel.warn ? 'warn' : '' },
    { k: '重复对', v: s.duplicatePairs, cls: s.duplicatePairs ? 'warn' : 'ok' },
    { k: '总体积', v: fmtBytes(s.totalBytes), cls: '' },
  ]) {
    $('#insKpi').append(h('div', { class: `kpi ${k.cls}` }, [
      h('div', { class: 'k', text: k.k }), h('div', { class: 'v', text: String(k.v) }),
    ]));
  }

  // 通过率环形
  const rate = s.passRate;
  const R = 52, C = 2 * Math.PI * R;
  const color = rate >= 0.95 ? '#12b76a' : rate >= 0.8 ? '#f79009' : '#f04438';
  $('#insRing').innerHTML = `
    <svg viewBox="0 0 140 140" width="150" height="150">
      <circle cx="70" cy="70" r="${R}" fill="none" stroke="#f2f4f7" stroke-width="14"/>
      <circle cx="70" cy="70" r="${R}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"
        stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - rate)}" transform="rotate(-90 70 70)"/>
      <text x="70" y="66" text-anchor="middle" font-size="26" font-weight="700" fill="#101828">${(rate * 100).toFixed(0)}%</text>
      <text x="70" y="86" text-anchor="middle" font-size="11" fill="#667085">${s.passed}/${s.total} 通过</text>
    </svg>`;

  // 级别分布
  const levels = [
    { key: 'error', label: '阻断', color: '#d92d20' },
    { key: 'warn', label: '警告', color: '#f79009' },
    { key: 'info', label: '提示', color: '#2b6cb0' },
  ];
  const totalF = Math.max(1, levels.reduce((a, l) => a + s.byLevel[l.key], 0));
  $('#insDonut').innerHTML = '';
  $('#insDonut').append(h('div', { class: 'legend' }, levels.map((l) =>
    h('div', { class: 'lg' }, [
      h('span', { class: 'sw', style: `background:${l.color}` }),
      h('span', { text: l.label }),
      h('span', { class: 'n', text: `${s.byLevel[l.key]}（${((s.byLevel[l.key] / totalF) * 100).toFixed(0)}%）` }),
    ])
  )));

  // 规则 Top
  $('#insBars').innerHTML = '';
  const rows = s.byRule.slice(0, 8);
  if (!rows.length) $('#insBars').append(h('div', { class: 'empty', text: '未命中任何规则，资产全部合规' }));
  const max = rows[0]?.count || 1;
  for (const r of rows) {
    $('#insBars').append(h('div', { class: 'bar-row' }, [
      h('span', { class: 'lbl', title: r.rule, text: ruleLabel(r.rule) }),
      h('span', { class: 'track' }, [h('i', { style: `width:${(r.count / max) * 100}%` })]),
      h('span', { class: 'n', text: String(r.count) }),
    ]));
  }

  // 明细表
  const results = [...(result.results || [])].sort((a, b) => {
    const rank = (r) => (r.findings.some((f) => f.level === 'error') ? 0 : r.findings.some((f) => f.level === 'warn') ? 1 : 2);
    return rank(a) - rank(b) || a.score - b.score;
  });
  const wrap = h('div', { class: 'table-wrap' });
  const tbody = h('tbody');
  for (const r of results) {
    const lvl = r.findings.some((f) => f.level === 'error') ? 'err' : r.findings.some((f) => f.level === 'warn') ? 'warn' : 'ok';
    const thumbPath = resolveArtifactPath(r);
    tbody.append(
      h('tr', {}, [
        h('td', { style: 'width:56px' }, [
          thumbPath
            ? h('img', { src: `/api/workspace/file?path=${encodeURIComponent(thumbPath)}`, style: 'width:44px;height:44px;object-fit:contain;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:zoom-in', onclick: () => openLightbox(`/api/workspace/file?path=${encodeURIComponent(thumbPath)}`, r.relPath) })
            : h('div', { style: 'width:44px;height:44px;border-radius:6px;background:var(--line-2)' }),
        ]),
        h('td', {}, [h('div', { class: 'name mono', title: r.relPath, text: r.relPath }), h('div', { class: 'tiny', text: r.meta ? `${r.meta.width}×${r.meta.height} · ${r.meta.format} · ${r.meta.bytesText} · alpha:${r.meta.hasAlpha ? '有' : '无'}` : '无法解码' })]),
        h('td', {}, [h('span', { class: `chip ${lvl}`, text: String(r.score) })]),
        h('td', {}, r.findings.length
          ? h('div', {}, r.findings.slice(0, 3).map((f) => h('div', { class: `chip ${f.level === 'error' ? 'err' : f.level === 'warn' ? 'warn' : 'info'}`, style: 'margin:0 4px 4px 0', title: f.message, text: ruleLabel(f.rule) })).concat(
              r.findings.length > 3 ? [h('span', { class: 'tiny', text: `+${r.findings.length - 3}` })] : []
            ))
          : h('span', { class: 'chip ok', text: '全部通过' })),
        h('td', { class: 'tiny', text: r.meta?.namingCanonical && r.meta.namingCanonical !== r.fileName ? r.meta.namingCanonical : '–' }),
      ])
    );
  }
  wrap.append(h('table', { class: 'table' }, [
    h('thead', {}, [h('tr', {}, [h('th', { text: '预览' }), h('th', { text: '资产' }), h('th', { text: '健康分' }), h('th', { text: '问题' }), h('th', { text: '建议命名' })])]),
    tbody,
  ]));
  $('#insTable').innerHTML = '';
  $('#insTable').append(wrap);
}

function resolveArtifactPath(r) {
  // 后端已把绝对路径转成「相对工作区根」的路径，此处直接使用，避免泄漏服务器目录结构
  return r.workspacePath || null;
}

/** 仅打包本次检查中「通过」的资产。 */
async function packPassed() {
  const res = lastInspectResult?.result;
  if (!res?.results?.length) return toast('请先执行一次资产检查', '', 'warn');
  const passed = res.results.filter((r) => r.ok).map((r) => r.relPath);
  if (!passed.length) return toast('本次没有被判定为通过的资产', '可放宽规则后重试，或使用「提交打包」整体交付', 'warn');
  try {
    const spec = insPayload();
    const submitted = await api.post('/api/packages', {
      inputSpec: { source: spec.source, jobIds: spec.jobIds, subdir: spec.subdir },
      onlyPassed: true,
      passedRelPaths: passed,
      packageName: 'ai-art-passed-only',
      version: 'v1.0.0',
      structure: 'byCategory',
      includeReport: true,
      includeChecksums: true,
      precheck: { enabled: true, strict: false, rules: { namingPreset: spec.namingPreset } },
    });
    toast('已提交打包（仅通过项）', `${passed.length} 项资产`, 'ok', submitted.job.id);
    renderSwitch('jobs');
  } catch (err) {
    failToast(err, '打包');
  }
}

async function runRenamePlan() {
  const btn = $('#btnRenamePlan');
  btn.disabled = true;
  try {
    const source = currentSource('#insSourceSeg');
    const body = { preset: $('#insPreset').value };
    if (lastInspectResult?.result?.results?.length) {
      body.filenames = lastInspectResult.result.results.map((r) => r.fileName);
    } else if (source === 'workspace') {
      body.source = 'workspace';
      body.subdir = $('#insSubdir').value.trim();
    } else {
      body.filenames = state.fileBags.ins.map((f) => f.name);
    }
    const data = await api.post('/api/assets/rename-plan', body);
    $('#insRenameCard').hidden = false;
    const wrap = h('div', { class: 'table-wrap' });
    wrap.append(h('table', { class: 'table' }, [
      h('thead', {}, [h('tr', {}, [h('th', { text: '当前文件名' }), h('th', { text: '规范文件名' }), h('th', { text: '是否需改' }), h('th', { text: '原因' })])]),
      h('tbody', {}, data.plan.map((p) => h('tr', {}, [
        h('td', { class: 'mono', text: p.from }),
        h('td', { class: 'mono', style: p.changed ? 'color:#067647' : '', text: p.to }),
        h('td', {}, [h('span', { class: `chip ${p.changed ? 'warn' : 'ok'}`, text: p.changed ? '需重命名' : '已合规' })]),
        h('td', { class: 'tiny', text: p.findings.slice(0, 2).map((f) => ruleLabel(f.rule)).join('、') || '–' }),
      ]))),
    ]));
    $('#insRename').innerHTML = '';
    $('#insRename').append(
      h('div', { class: 'card-body', style: 'padding-bottom:0' }, [
        h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
          h('span', { class: 'chip neutral', text: `规范集：${data.preset.label}` }),
          h('span', { class: 'chip neutral mono', text: data.preset.pattern }),
          h('span', { class: 'chip warn', text: `需重命名 ${data.summary.needRename}` }),
          h('span', { class: 'chip ok', text: `已合规 ${data.summary.valid}` }),
        ]),
        h('p', { class: 'hint', style: 'margin-top:8px', text: '预演不改动任何文件。落地重命名建议通过 CI 或版本库操作，避免绕过审批。' }),
      ])
    );
    $('#insRename').append(wrap);
    toast('命名预演完成', `${data.summary.needRename} 个文件需要重命名`);
  } catch (err) {
    failToast(err, '命名预演');
  } finally {
    btn.disabled = false;
  }
}

/* ============================== 视图：交付包 ============================== */

async function runPack() {
  const jobId = $('#pkJob').value;
  const btn = $('#btnPack');
  if (!jobId) return toast('请先选择来源任务', '', 'warn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 打包中';
  try {
    const precheckMode = $('#pkPrecheck').value;
    const res = await api.post('/api/packages', {
      source: 'job',
      jobIds: [jobId],
      packageName: $('#pkName').value.trim() || 'ai-art-delivery',
      version: $('#pkVersion').value.trim() || 'v1.0.0',
      structure: $('#pkStructure').value,
      includeManifest: true,
      includeReport: $('#pkInclude').value === 'all',
      includeChecksums: $('#pkInclude').value === 'all',
      precheck: { enabled: precheckMode !== 'off', strict: precheckMode === 'strict' },
    });
    toast('打包任务已受理', res.job.name, 'ok', res.job.id);
    renderSwitch('jobs');
    watchJob(res.job.id, {
      onFinish: async (job) => {
        if (job.status === 'failed') toast('打包失败', job.error?.message, 'err', job.error?.code);
        else toast('打包完成', `交付包 ${job.result.package.file}`);
        await loadPackages();
        await loadJobs();
      },
    });
  } catch (err) {
    failToast(err, '打包');
  } finally {
    btn.disabled = false;
    btn.textContent = '提交打包';
  }
}

async function loadPackages() {
  try {
    const tree = await api.get('/api/workspace/tree?subdir=packages&limit=200');
    $('#pkgSub').textContent = `${tree.total} 个交付包 · ${tree.totalBytesText}`;
    const box = $('#pkgList');
    box.innerHTML = '';
    if (!tree.entries.length) {
      box.append(h('div', { class: 'empty', text: '还没有交付包。可在「一键全链路交付」或上方手动打包生成。' }));
      return;
    }
    box.append(h('div', { class: 'table-wrap' }, [
      h('table', { class: 'table' }, [
        h('thead', {}, [h('tr', {}, [h('th', { text: '包名' }), h('th', { class: 'num', text: '体积' }), h('th', { text: '生成时间' }), h('th', { text: '操作' })])]),
        h('tbody', {}, tree.entries.map((e) => h('tr', {}, [
          h('td', { class: 'mono name', title: e.name, text: e.name }),
          h('td', { class: 'num', text: e.bytesText }),
          h('td', { class: 'tiny', text: fmtTime(e.mtime) }),
          h('td', {}, [
            h('a', { class: 'btn ghost sm', href: `/api/packages/${encodeURIComponent(e.name)}/download` }, ['下载']),
            ' ',
            h('a', { class: 'btn ghost sm', href: `/api/packages/${encodeURIComponent(e.name)}/preview`, target: '_blank' }, ['报告']),
          ]),
        ]))),
      ]),
    ]));
  } catch (err) {
    $('#pkgList').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

/* ============================== 视图：资产库 ============================== */

async function loadAssets() {
  const subdir = $('#assetsSubdir').value;
  try {
    const tree = await api.get(`/api/workspace/tree?subdir=${encodeURIComponent(subdir)}&limit=200`);
    $('#assetsSub').textContent = `${tree.total} 个文件 · ${tree.totalBytesText}`;
    const box = $('#assetsGrid');
    box.innerHTML = '';
    if (!tree.entries.length) {
      box.append(h('div', { class: 'empty', text: '该目录下暂无文件' }));
      return;
    }
    const arts = tree.entries
      .filter((e) => ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp', 'tiff'].includes(e.ext))
      .map((e) => ({
        file: e.name,
        relPath: `${subdir}/${e.relPath}`,
        width: '', height: '',
        bytesText: e.bytesText,
        format: e.ext,
        workspacePath: `${subdir}/${e.relPath}`,
        type: 'image',
      }));
    if (!arts.length) box.append(h('div', { class: 'empty', text: '该目录下没有可预览的图像文件' }));
    else box.append(artifactGrid(arts));
  } catch (err) {
    $('#assetsGrid').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

/* ============================== 视图：提供方 ============================== */

async function loadProviders() {
  try {
    const data = await api.get('/api/providers');
    state.providers = data.providers;
    const box = $('#providerGrid');
    box.innerHTML = '';
    for (const p of data.providers) {
      const health = p.health || {};
      const card = h('div', { class: `provider ${p.id === data.active ? 'active' : ''}` });
      card.append(
        h('header', {}, [
          h('span', { class: `dot ${health.ok ? 'ok' : 'bad'}` }),
          h('span', { class: 'title', text: p.label }),
          p.id === data.active ? h('span', { class: 'chip info', text: '当前生效' }) : null,
          h('span', { class: 'kind mono', text: p.kind }),
        ]),
        h('p', { class: 'desc', text: health.detail || (health.ok ? '可用' : '不可用') }),
        h('div', { class: 'kv' }, [
          h('span', { class: 'k', text: 'baseUrl' }), h('span', { class: 'v', text: p.baseUrl || '（本地）' }),
          h('span', { class: 'k', text: '鉴权' }), h('span', { class: 'v', text: p.requiresKey ? (p.hasKey ? '已配置密钥' : '缺少密钥') : '不需要' }),
          h('span', { class: 'k', text: '并发上限' }), h('span', { class: 'v', text: String(p.maxConcurrency) }),
          h('span', { class: 'k', text: '超时' }), h('span', { class: 'v', text: `${p.timeoutMs / 1000}s` }),
          h('span', { class: 'k', text: '模型' }), h('span', { class: 'v', text: (p.models || []).join(', ') || '–' }),
        ]),
        h('div', { class: 'caps' }, [
          p.capabilities.async ? h('span', { class: 'chip purple', text: '异步任务' }) : h('span', { class: 'chip neutral', text: '同步返回' }),
          p.capabilities.negativePrompt ? h('span', { class: 'chip neutral', text: '支持负向词' }) : null,
          p.capabilities.seedControl ? h('span', { class: 'chip neutral', text: '可控种子' }) : null,
          h('span', { class: 'chip neutral', text: `单批 ≤ ${p.capabilities.maxBatchSize}` }),
          p.capabilities.note ? h('span', { class: 'chip neutral', title: p.capabilities.note, text: '有备注' }) : null,
        ]),
        h('footer', {}, [
          h('button', { class: 'btn ghost sm', onclick: () => testProvider(p.id) }, ['连通测试']),
          h('button', { class: 'btn ghost sm', onclick: () => toggleProvider(p.id, !p.enabled) }, [p.enabled ? '禁用' : '启用']),
          p.id !== data.active ? h('button', { class: 'btn primary sm', onclick: () => activateProvider(p.id) }, ['设为当前']) : null,
          h('button', { class: 'btn ghost sm', onclick: () => editProvider(p) }, ['编辑配置']),
        ])
      );
      box.append(card);
    }
  } catch (err) {
    $('#providerGrid').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

async function testProvider(id) {
  try {
    const r = await api.post('/api/providers/test', { providerId: id });
    toast(`连通测试：${id}`, r.detail, r.ok ? 'ok' : 'err', r.code);
    await loadProviders();
  } catch (err) {
    failToast(err, '连通测试');
  }
}

async function toggleProvider(id, enabled) {
  try {
    const r = await api.patch('/api/providers/config', { providerId: id, patch: { enabled } });
    toast(enabled ? '已启用' : '已禁用', r.provider.label, 'ok', r.provider.health?.detail);
    await loadProviders();
    await refreshPills();
  } catch (err) {
    failToast(err, '更新配置');
  }
}

async function activateProvider(id) {
  try {
    const r = await api.post('/api/providers/activate', { providerId: id });
    toast('已切换当前提供方', r.active);
    await loadProviders();
    await refreshPills();
    await loadDashboard();
  } catch (err) {
    failToast(err, '切换提供方');
  }
}

async function editProvider(p) {
  const baseUrl = prompt(`编辑 ${p.label} 的 baseUrl：`, p.baseUrl || '');
  if (baseUrl === null) return;
  const apiKey = prompt(`编辑 API Key（留空保持不变；支持 env:VAR_NAME 引用环境变量）：`, '');
  const patch = { baseUrl: baseUrl.trim() };
  if (apiKey && apiKey.trim()) patch.apiKey = apiKey.trim();
  try {
    const r = await api.patch('/api/providers/config', { providerId: p.id, patch });
    toast('配置已热更新', r.provider.health?.detail || '', r.provider.health?.ok ? 'ok' : 'warn');
    await loadProviders();
  } catch (err) {
    failToast(err, '更新配置');
  }
}

/* ============================== 视图：系统 ============================== */

async function loadSystem() {
  try {
    const [health, paths, meta] = await Promise.all([api.get('/api/system/health'), api.get('/api/config/paths'), api.get('/api/system/meta')]);
    const rows = [
      ['服务状态', health.status], ['运行时长', `${Math.floor(health.uptimeSec / 60)} 分 ${health.uptimeSec % 60} 秒`],
      ['Node', health.node], ['平台', health.platform],
      ['内存 RSS', health.memory.rss], ['堆占用', health.memory.heapUsed],
      ['队列 执行/等待', `${health.queue.running} / ${health.queue.pending}`],
      ['全局并发上限', health.queue.global.limit],
      ['当前提供方', health.activeProvider],
      ['任务总数', health.jobs.total],
      ['产物累计体积', fmtBytes(health.jobs.assetBytes)],
    ];
    $('#sysRuntime').innerHTML = '';
    $('#sysRuntime').append(h('table', { class: 'table' }, [h('tbody', {}, rows.map(([k, v]) => h('tr', {}, [
      h('td', { style: 'color:var(--ink-3);width:150px', text: k }), h('td', { class: 'mono', text: String(v) }),
    ])))]));

    $('#sysPaths').innerHTML = '';
    $('#sysPaths').append(h('table', { class: 'table' }, [h('tbody', {}, Object.entries(paths).map(([k, v]) => h('tr', {}, [
      h('td', { style: 'color:var(--ink-3);width:110px', text: k }), h('td', { class: 'mono', style: 'word-break:break-all', text: v }),
    ])))]));
    $('#sysPaths').append(h('div', { class: 'hint', style: 'margin-top:10px', text: `请求体上限 ${meta.limits.bodyLimitMB}MB · 单批上限 ${meta.limits.maxBatchItems} 项 · 单次上传上限 ${meta.limits.maxUploadFiles} 个文件` }));

    const routes = await api.get('/api/system/routes');
    $('#sysRoutes').innerHTML = '';
    $('#sysRoutes').append(h('div', { class: 'table-wrap' }, [
      h('table', { class: 'table' }, [
        h('thead', {}, [h('tr', {}, [h('th', { text: '方法' }), h('th', { text: '路径' }), h('th', { text: '说明' })])]),
        h('tbody', {}, routes.routes.filter((r) => r.path.startsWith('/api')).map((r) => h('tr', {}, [
          h('td', {}, [h('span', { class: `chip mono ${r.method === 'GET' ? 'info' : r.method === 'DELETE' ? 'err' : 'ok'}`, text: r.method })]),
          h('td', { class: 'mono', text: r.path }),
          h('td', { class: 'tiny', text: r.description || '' }),
        ]))),
      ]),
    ]));

    $('#sysErrSub').textContent = `共 ${meta.errorCodes.length} 个错误码，按域分组`;
    const byDomain = {};
    for (const e of meta.errorCodes) (byDomain[e.domain] = byDomain[e.domain] || []).push(e);
    $('#sysErrors').innerHTML = '';
    const box = h('div', { class: 'card-body' });
    for (const [domain, codes] of Object.entries(byDomain)) {
      box.append(h('div', { style: 'margin-bottom:14px' }, [
        h('div', { class: 'hint', style: 'margin-bottom:6px', text: `${domain}（${codes.length}）` }),
        h('div', {}, codes.map((c) => h('span', { class: `chip mono ${c.retryable ? 'warn' : 'neutral'}`, style: 'margin:0 6px 6px 0', title: `${c.message}｜HTTP ${c.httpStatus}｜${c.retryable ? '可重试' : '不可重试'}`, text: c.code }))),
      ]));
    }
    $('#sysErrors').append(box);
  } catch (err) {
    $('#sysRuntime').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

/* ============================== 视图：一键交付 ============================== */

let dlWatch = null;
async function runDelivery() {
  const btn = $('#btnDelivery');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 提交中';
  try {
    const widths = parseNumList($('#dlWidths').value);
    const naming = {
      preset: $('#dlNamingPreset').value,
      tokens: { category: $('#dlCategory').value.trim() || undefined, state: $('#dlState').value.trim() || undefined },
    };
    const body = {
      generate: {
        providerId: $('#dlProvider').value,
        prompts: $('#dlPrompts').value.split('\n').map((s) => s.trim()).filter(Boolean),
        base: { height: Number($('#dlHeight').value), steps: Number($('#dlSteps').value) },
        matrix: { width: widths },
        countPerPrompt: Number($('#dlCount').value),
        seedMode: $('#dlSeedMode').value,
        naming,
      },
      convert: $('#dlConvertOn').checked
        ? {
            format: $('#dlFormat').value,
            quality: Number($('#dlQuality').value),
            resize: { mode: 'maxEdge', maxEdge: Number($('#dlMaxEdge').value) },
            namingPreset: naming.preset,
          }
        : null,
      inspect: $('#dlInspectOn').checked
        ? { namingPreset: naming.preset, alphaPolicy: $('#dlAlpha').value, minEdge: Number($('#dlMinEdge').value) }
        : null,
      pack: {
        packageName: $('#dlPackName').value.trim() || 'ai-art-delivery',
        version: $('#dlPackVersion').value.trim() || 'v1.0.0',
        structure: $('#dlByCategory').checked ? 'byCategory' : 'flat',
        includeReport: true,
        includeChecksums: true,
        precheck: { enabled: true, strict: $('#dlStrict').checked },
      },
    };
    const res = await api.post('/api/pipeline/delivery', body);
    toast('全链路交付已启动', res.job.name, 'ok', res.job.id);
    $('#dlJobName').textContent = res.job.name;
    $('#dlRunCard').hidden = false;
    const container = $('#dlRun');
    container.innerHTML = '';
    const p = jobProgressNode();
    container.append(p);
    const stages = h('div', { class: 'stage-track' });
    container.append(stages);
    updateProgressNode(p, res.job);

    // 四阶段进度可视化
    const stageDefs = ['生成', '格式转换', '资产检查', '打包'];
    const paintStages = (job) => {
      const cur = job.stage || '';
      const idx = stageDefs.findIndex((s) => cur.includes(s));
      stages.innerHTML = '';
      stageDefs.forEach((s, i) => {
        const done = idx === -1 ? job.status === 'succeeded' : i < idx || job.status === 'succeeded';
        const run = i === idx && ['running', 'queued'].includes(job.status);
        stages.append(h('div', { class: `stage ${done ? 'done' : run ? 'run' : ''}` }, [
          h('div', { class: 'sn', text: `第 ${i + 1} 步` }),
          h('div', { class: 'sv', text: s }),
        ]));
      });
    };
    paintStages(res.job);

    dlWatch?.close();
    dlWatch = watchJob(res.job.id, {
      onUpdate: (job) => {
        updateProgressNode(p, job);
        paintStages(job);
        $('#dlJobName').textContent = job.name;
      },
      onFinish: (job) => {
        updateProgressNode(p, job);
        paintStages(job);
        renderInto($('#dlRun'));
        const r = job.result;
        const box = $('#dlRun');
        box.innerHTML = '';
        if (job.status === 'failed') {
          box.append(h('div', { class: 'reader', text: `${job.error?.code}\n${job.error?.message}\n\n${JSON.stringify(job.error?.details || {}, null, 2)}` }));
          toast('全链路交付失败', job.error?.message, 'err', job.error?.code);
        } else {
          box.append(
            h('div', { class: 'grid-3' }, [
              kpiMini('产出资产', r.package?.assetCount ?? 0, 'ok'),
              kpiMini('交付包体积', r.package?.bytesText ?? '–', 'brand'),
              kpiMini('质检通过率', r.inspect ? `${(r.inspect.summary.passRate * 100).toFixed(1)}%` : '未启用', r.inspect?.summary.failed ? 'warn' : 'ok'),
              kpiMini('质量问题', r.totalIssues ?? 0, r.totalIssues ? 'warn' : 'ok'),
              kpiMini('转换节省', r.convert ? `${r.convert.savings.ratio}%` : '未启用', 'brand'),
              kpiMini('总耗时', fmtDur(job.durationMs), ''),
            ])
          );
          box.append(h('div', { class: 'stage-track' }, (r.stages || []).map((s) =>
            h('div', { class: `stage ${s.ok === false ? 'fail' : 'done'}` }, [
              h('div', { class: 'sn', text: s.stage }),
              h('div', { class: 'sv', text: s.skipped ? '已跳过' : `${s.produced} 项` }),
            ])
          )));
          if (r.package) {
            box.append(h('div', { class: 'action-bar', style: 'margin-top:16px' }, [
              h('a', { class: 'btn primary', href: `/api/packages/${encodeURIComponent(r.package.file)}/download` }, ['下载交付包']),
              h('a', { class: 'btn ghost', href: `/api/packages/${encodeURIComponent(r.package.file)}/preview`, target: '_blank' }, ['查看质检报告']),
              h('button', { class: 'btn ghost', onclick: () => openJobDrawer(job.id) }, ['查看完整详情']),
            ]));
            box.append(h('div', { class: 'reader', style: 'margin-top:14px' }, [
              `交付包：${r.package.file}\nsha256：${r.package.sha256}\n包内条目：\n` +
                (r.package.entries || []).map((e) => `  ${e.name}  ${fmtBytes(e.bytes)}`).join('\n'),
            ]));
          }
          toast('全链路交付完成', `${r.package?.assetCount} 项资产已打包，可下载交付`, 'ok');
        }
        loadDashboard();
        loadJobs();
        loadPackages();
      },
    });
  } catch (err) {
    failToast(err, '启动交付');
  } finally {
    btn.disabled = false;
    btn.textContent = '启动全链路交付';
  }
}

function kpiMini(k, v, cls) {
  return h('div', { class: `kpi ${cls}` }, [h('div', { class: 'k', text: k }), h('div', { class: 'v', text: String(v) })]);
}

/* ============================== 视图切换 ============================== */

const VIEW_META = {
  dashboard: ['总览看板', '生产、治理与交付的实时状态'],
  delivery: ['一键全链路交付', '生成 → 格式转换 → 资产检查 → 打包，一条链路产出可交付包'],
  generate: ['批量生成', '提示词矩阵展开、规范化命名落盘、自动质检'],
  convert: ['格式转换', '格式 / 尺寸 / 倍率多档转换，统一命名与体积统计'],
  inspect: ['命名与资产检查', '命名规范校验、完整性检查、重复检测与修复建议'],
  packages: ['交付包', '打包清单、校验清单、质检报告一体化交付'],
  assets: ['资产库', '浏览工作区内已落盘的资产'],
  providers: ['AI 提供方', '统一请求 / 响应 / 错误契约，热更新配置'],
  jobs: ['任务中心', '全量任务审计：进度、日志、产物、错误码'],
  system: ['系统与接口', '运行时状态、自描述接口清单、统一错误码注册表'],
};

const VIEW_LOADERS = {
  dashboard: loadDashboard, delivery: () => {}, generate: () => {}, convert: () => {},
  inspect: () => {}, packages: loadPackages, assets: loadAssets, providers: loadProviders,
  jobs: loadJobs, system: loadSystem,
};

function renderSwitch(view) {
  state.currentView = view;
  $$('.nav-item').forEach((el) => el.classList.toggle('on', el.dataset.view === view));
  $$('.view').forEach((el) => el.classList.toggle('on', el.id === `view-${view}`));
  const [title, desc] = VIEW_META[view] || ['', ''];
  $('#viewTitle').textContent = title;
  $('#viewDesc').textContent = desc;
  location.hash = view;
  VIEW_LOADERS[view]?.();
  $('#scroll').scrollTop = 0;
}

function currentSource(segSel) {
  return $(`${segSel} button.on`)?.dataset.src || 'upload';
}

/** 输入源切换：三处（转换/检查）共用同一套交互。 */
function bindSourceSeg(segSel, bagKey, listSel, dropSel, inputSel) {
  $$(`${segSel} button`).forEach((b) => {
    b.addEventListener('click', () => {
      $$(`${segSel} button`).forEach((x) => x.classList.toggle('on', x === b));
      $$('.src-block').forEach((blk) => {
        if (blk.closest('.view')?.id !== $(segSel).closest('.view').id) return;
        blk.hidden = blk.dataset.src !== b.dataset.src;
      });
    });
  });
  bindDrop(dropSel, inputSel, (files) => {
    state.fileBags[bagKey] = files;
    renderFileList(listSel, files);
  });
}

function bindDrop(dropSel, inputSel, onFiles) {
  const dz = $(dropSel);
  const input = $(inputSel);
  dz.addEventListener('click', () => input.click());
  input.addEventListener('change', () => onFiles([...input.files]));
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|avif|tiff?|gif|bmp)$/i.test(f.name));
    onFiles(files);
  });
}

function renderFileList(sel, files) {
  const box = $(sel);
  box.innerHTML = '';
  if (!files.length) return;
  box.append(h('div', { class: 'hint', text: `已选择 ${files.length} 个文件，合计 ${fmtBytes(files.reduce((s, f) => s + f.size, 0))}` }));
  for (const f of files.slice(0, 40)) {
    box.append(h('div', { class: 'fi' }, [h('span', { text: '▪' }), h('span', { class: 'n', text: f.name }), h('span', { class: 'tiny', text: fmtBytes(f.size) })]));
  }
  if (files.length > 40) box.append(h('div', { class: 'hint', text: `…还有 ${files.length - 40} 个` }));
}

/* ============================== 顶栏与轮询 ============================== */

async function refreshPills() {
  try {
    const h = await api.get('/api/system/health');
    const online = h.providers.filter((p) => p.ok).length;
    $('#pillProvider').textContent = `提供方：${h.activeProvider}`;
    $('#pillQueue').textContent = `队列 ${h.queue.running}/${h.queue.global.limit} · 等待 ${h.queue.pending}`;
    $('#healthText').textContent = `${online}/${h.providers.length} 提供方可用 · 任务 ${h.jobs.total}`;
    $('#healthRow .dot').className = `dot ${online ? 'ok' : 'bad'}`;
    const load = (h.queue.running / h.queue.global.limit) * 100;
    $('#qmBar').style.width = `${Math.min(100, load)}%`;
    $('#qmText').textContent = `${h.queue.running}/${h.queue.global.limit}`;
    const active = h.queue.running + h.queue.pending;
    const badge = $('#navJobBadge');
    badge.textContent = String(active);
    badge.classList.toggle('hot', active > 0);
    state.prevActive = active;
    return h;
  } catch {
    $('#healthText').textContent = '服务不可达';
    $('#healthRow .dot').className = 'dot bad';
    return null;
  }
}

/* ============================== 初始化 ============================== */

async function boot() {
  try {
    state.meta = await api.get('/api/system/meta');
  } catch (err) {
    toast('无法连接服务', err.message, 'err', err.code);
    return;
  }

  // 命名规范集下拉
  for (const sel of ['#genNamingPreset', '#cvNamingPreset', '#insPreset', '#dlNamingPreset']) {
    const el = $(sel);
    for (const p of state.meta.namingPresets) el.append(h('option', { value: p.id, text: `${p.label}` }));
  }
  const updatePatternBox = (presetSel, boxSel) => {
    const p = state.meta.namingPresetsFull.find((x) => x.id === $(presetSel).value);
    if (!p) return;
    const box = $(boxSel);
    box.innerHTML = '';
    box.append(
      h('div', {}, [
        h('span', { class: 'k', text: '当前规范模板：' }), h('span', { class: 'v', text: p.pattern }), h('br'),
        h('span', { class: 'k', text: '分隔符 ' }), h('span', { class: 'v', text: p.separator }),
        h('span', { class: 'k', text: '  大小写 ' }), h('span', { class: 'v', text: p.case }),
        h('span', { class: 'k', text: '  长度 ' }), h('span', { class: 'v', text: `${p.minLength}-${p.maxLength}` }), h('br'),
        h('span', { class: 'muted', text: p.description }),
      ])
    );
  };
  for (const [sel, box] of [['#genNamingPreset', '#genPatternBox'], ['#insPreset', '#insPatternBox']]) {
    updatePatternBox(sel, box);
    $(sel).addEventListener('change', () => updatePatternBox(sel, box));
  }

  await loadProviders();
  providerOptions($('#genProvider'));
  providerOptions($('#dlProvider'));
  updateModelOptions($('#genModel'), $('#genProvider').value);
  $('#genProvider').addEventListener('change', () => updateModelOptions($('#genModel'), $('#genProvider').value));
  if (state.meta.activeProvider) {
    $('#genProvider').value = state.meta.activeProvider;
    $('#dlProvider').value = state.meta.activeProvider;
    updateModelOptions($('#genModel'), $('#genProvider').value);
  }

  // 事件绑定
  $$('.nav-item').forEach((el) => el.addEventListener('click', () => renderSwitch(el.dataset.view)));
  $$('[data-goto]').forEach((el) => el.addEventListener('click', () => renderSwitch(el.dataset.goto)));
  $('#btnRefresh').addEventListener('click', async () => { await refreshPills(); VIEW_LOADERS[state.currentView]?.(); toast('已刷新', ''); });
  $('#btnHealthAll').addEventListener('click', async () => { await api.post('/api/providers/health', {}); await loadProviders(); await loadDashboard(); toast('健康检查完成', ''); });
  $('#btnProviderHealth').addEventListener('click', async () => { await api.post('/api/providers/health', {}); await loadProviders(); toast('健康检查完成', ''); });

  $('#btnDelivery').addEventListener('click', runDelivery);
  $('#btnGenPlan').addEventListener('click', previewPlan);
  $('#btnGenRun').addEventListener('click', runGenerate);
  $('#btnGenCancel').addEventListener('click', () => { genWatch?.close(); toast('已停止前端订阅', '服务端任务仍在执行，可在任务中心取消'); });
  $('#btnConvert').addEventListener('click', runConvert);
  $('#btnInspect').addEventListener('click', runInspect);
  $('#btnRenamePlan').addEventListener('click', runRenamePlan);
  $('#btnPack').addEventListener('click', runPack);
  $('#btnPackPassed').addEventListener('click', packPassed);
  $('#assetsSubdir').addEventListener('change', loadAssets);

  bindSourceSeg('#convSourceSeg', 'conv', '#convFileList', '#convDrop', '#convFiles');
  bindSourceSeg('#insSourceSeg', 'ins', '#insFileList', '#insDrop', '#insFiles');

  $('#jobStatusFilter').addEventListener('change', loadJobs);
  $('#jobKindFilter').addEventListener('change', loadJobs);
  let kwTimer;
  $('#jobKeyword').addEventListener('input', () => { clearTimeout(kwTimer); kwTimer = setTimeout(loadJobs, 300); });

  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerMask').addEventListener('click', closeDrawer);
  $('#lightbox').addEventListener('click', () => { $('#lightbox').hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeDrawer(); $('#lightbox').hidden = true; }
  });

  // 首屏
  const hash = location.hash.replace('#', '');
  renderSwitch(VIEW_META[hash] ? hash : 'dashboard');

  // 支持深链与浏览器前进/后退：地址栏 hash 变化时同步视图
  let lastHash = location.hash;
  window.addEventListener('hashchange', () => {
    if (location.hash === lastHash) return;
    lastHash = location.hash;
    const v = location.hash.replace('#', '');
    if (VIEW_META[v] && v !== state.currentView) renderSwitch(v);
  });

  await refreshPills();
  setInterval(refreshPills, 5000);
  setInterval(() => {
    if (state.currentView === 'jobs') loadJobs();
    if (state.currentView === 'dashboard') loadDashboard();
  }, 12000);
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#drawerMask').hidden = true;
}

boot();
