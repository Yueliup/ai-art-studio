/**
 * 端到端冒烟测试。
 *
 * 覆盖五条主链路 + 三类错误路径，用于 CI 与交付前的自检：
 *   1) 提供方健康检查        2) 批量生成（含自动质检）
 *   3) 格式转换（消费上一步产物）  4) 资产检查（工作区样本）
 *   5) 打包交付              6) 一键全链路交付
 *   E) 错误路径：未知提供方 / 空提示词 / 超批次上限
 *
 * 用法：node scripts/smoke.js [baseUrl]
 * 退出码 0 表示全部通过。
 */

const BASE = process.argv[2] || 'http://127.0.0.1:8848';
let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, label, detail) {
  if (cond) {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function waitJob(id, { timeoutMs = 180000, quiet = false } = {}) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    const { json } = await api('GET', `/api/jobs/${id}`);
    const job = json?.data?.job;
    if (!job) throw new Error(`任务 ${id} 查询失败`);
    const line = `${job.status} ${job.progress}% ${job.stage}`;
    if (line !== last && !quiet) {
      last = line;
      process.stdout.write(`      · ${line}\n`);
    }
    if (['succeeded', 'failed', 'partial', 'canceled'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`任务 ${id} 等待超时`);
}

/** 订阅 SSE，收集事件名直到收到 finish 或超时。 */
async function collectSse(path, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const names = [];
  try {
    const res = await fetch(`${BASE}${path}`, { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const m = part.match(/^event: (.+)$/m);
        if (m) names.push(m[1]);
        if (m && m[1] === 'finished') {
          controller.abort();
          return names;
        }
      }
    }
  } catch {
    /* 超时或中断都按已收集到的事件判定 */
  } finally {
    clearTimeout(timer);
  }
  return names;
}

async function main() {
  console.log(`\n=== AI Art Studio 冒烟测试 @ ${BASE} ===\n`);

  console.log('[0] 服务与元信息');
  const meta = await api('GET', '/api/system/meta');
  assert(meta.json?.success, '元信息接口可用');
  assert((meta.json?.data?.providers || []).length >= 6, `提供方已注册（${meta.json?.data?.providers?.length} 个）`);
  assert((meta.json?.data?.errorCodes || []).length > 30, `错误码注册表已加载（${meta.json?.data?.errorCodes?.length} 个）`);
  assert((meta.json?.data?.namingPresets || []).length >= 4, `命名规范集已加载（${meta.json?.data?.namingPresets?.length} 套）`);

  console.log('\n[1] 提供方健康检查');
  const health = await api('POST', '/api/providers/health', {});
  const results = health.json?.data?.results || [];
  const mockHealth = results.find((r) => r.id === 'local-mock');
  assert(mockHealth?.ok === true, 'local-mock 健康', mockHealth?.detail);
  const cloudDisabled = results.filter((r) => ['openai-images', 'dashscope', 'volcengine'].includes(r.id));
  assert(cloudDisabled.every((r) => r.ok === false), '未配置密钥的云端提供方被正确判定为不可用');

  console.log('\n[2] 批量生成（3 提示词 × 2 尺寸 × 2 张 = 12 张，含自动质检）');
  const gen = await api('POST', '/api/generate', {
    providerId: 'local-mock',
    prompts: ['ui icon fire spell', 'ui icon ice shield', 'ui icon arcane rune'],
    base: { height: 512, steps: 20 },
    matrix: { width: [512, 768] },
    countPerPrompt: 2,
    naming: { preset: 'game-ui', tokens: { category: 'icon', state: 'normal' } },
    postProcess: { inspect: { namingPreset: 'game-ui' } },
  });
  assert(gen.json?.success === true, '生成任务已受理', JSON.stringify(gen.json?.error));
  const genJob = await waitJob(gen.json.data.job.id);
  assert(genJob.status === 'succeeded', `生成任务终态 success（实际 ${genJob.status}）`, JSON.stringify(genJob.error));
  assert(genJob.artifacts.length === 12, `产出 12 张（3 提示词 × 2 尺寸 × 2 张，实际 ${genJob.artifacts.length}）`);
  assert(genJob.artifacts.every((a) => a.width > 0 && a.bytes > 0), '所有产物均有有效尺寸与体积');
  assert(
    genJob.artifacts.every((a) => /^[a-z]{2,12}_[a-z0-9]{2,24}_[a-z]{2,12}_\d{2,5}x\d{2,5}\.png$/.test(a.file)),
    `产物命名符合 game-ui 规范模板：${genJob.artifacts[0]?.file}`
  );
  assert(genJob.artifacts.filter((a) => a.qaOk === false).length === 0, '自动质检未发现阻断级问题');
  assert(genJob.result?.summary?.avgScore > 0, `自动质检产出健康分（均分 ${genJob.result?.summary?.avgScore}）`);
  assert(genJob.result?.summary?.totalBytesText, `体积统计：${genJob.result?.summary?.totalBytesText}`);

  console.log('\n[3] 格式转换（消费上一步产物 → WebP @512 + @256）');
  const conv = await api('POST', '/api/convert', {
    source: 'job',
    jobIds: [genJob.id],
    format: 'webp',
    quality: 82,
    resize: { mode: 'maxEdge', maxEdge: 512 },
    variants: [{ suffix: '_1x', scale: 1 }, { suffix: '_half', scale: 0.5 }],
    namingPreset: 'game-ui',
  });
  assert(conv.json?.success === true, '转换任务已受理', JSON.stringify(conv.json?.error));
  const convJob = await waitJob(conv.json.data.job.id);
  assert(convJob.status === 'succeeded', `转换任务终态 success（实际 ${convJob.status}）`);
  assert(convJob.artifacts.length >= 12, `产出 ≥12 个 WebP（实际 ${convJob.artifacts.length}）`);
  assert(convJob.artifacts.every((a) => a.format === 'webp'), '全部输出为 webp 格式');
  assert(typeof convJob.result?.savings?.ratio === 'number', `体积变化已统计（节省 ${convJob.result?.savings?.ratio}%）`);

  console.log('\n[4] 资产检查（工作区样例资产，含刻意构造的问题样本）');
  const insp = await api('POST', '/api/assets/inspect', {
    source: 'workspace',
    subdir: 'uploads/sample-assets',
    namingPreset: 'game-ui',
    rules: { alphaPolicy: 'require', checkBlank: true, detectDuplicates: true },
  });
  assert(insp.json?.success === true, '检查任务已受理', JSON.stringify(insp.json?.error));
  const inspJob = insp.json?.success ? await waitJob(insp.json.data.job.id) : null;
  if (inspJob) {
    const summary = inspJob.result?.summary;
    assert(inspJob.status === 'partial' || inspJob.status === 'succeeded', `检查任务完成（${inspJob.status}）`);
    assert(summary?.total >= 10, `检查了 ≥10 个资产（实际 ${summary?.total}）`);
    assert(summary?.byLevel?.error > 0, `检出阻断级问题 ${summary?.byLevel?.error} 处`);
    const rules = new Set((summary?.byRule || []).map((r) => r.rule));
    assert(rules.has('word.forbidden'), '检出禁用词（test/最终版）');
    assert(rules.has('content.blank'), '检出空白图');
    assert(rules.has('size.tooSmall'), '检出尺寸过小');
    assert(rules.has('duplicate.detected'), '检出重复资产');
    console.log(`      规则命中：${(summary?.byRule || []).map((r) => `${r.rule}×${r.count}`).join(', ')}`);
  }

  console.log('\n[5] 打包交付（消费生成任务产物，严格前置校验关闭）');
  const pack = await api('POST', '/api/packages', {
    source: 'job',
    jobIds: [genJob.id],
    packageName: 'smoke-delivery',
    version: 'v1.0.0',
    structure: 'byCategory',
    precheck: { enabled: true, strict: false, rules: { namingPreset: 'game-ui' } },
  });
  assert(pack.json?.success === true, '打包任务已受理', JSON.stringify(pack.json?.error));
  const packJob = await waitJob(pack.json.data.job.id);
  assert(['succeeded', 'partial'].includes(packJob.status), `打包任务完成（${packJob.status}）`);
  const pkg = packJob.result?.package;
  assert(pkg?.assetCount === 12, `包内资产 12 个（实际 ${pkg?.assetCount}）`);
  assert(Boolean(pkg?.sha256), `产物包已计算 sha256（${pkg?.sha256?.slice(0, 12)}…）`);
  assert(pkg?.entries?.some((e) => e.name === 'manifest.json'), '包含 manifest.json');
  assert(pkg?.entries?.some((e) => e.name === 'report.html'), '包含质检报告 report.html');
  assert(pkg?.entries?.some((e) => e.name === 'checksums.sha256'), '包含校验清单 checksums.sha256');
  const dl = await fetch(`${BASE}/api/packages/${encodeURIComponent(pkg.file)}/download`);
  const dlBuf = Buffer.from(await dl.arrayBuffer());
  assert(dl.status === 200 && dlBuf.length === pkg.bytes, `产物包可下载且字节数一致（${dlBuf.length} B）`);
  assert(dlBuf.subarray(0, 2).toString() === 'PK', '下载内容是合法 ZIP（PK 魔数）');

  console.log('\n[6] 一键全链路交付（生成→转换→质检→打包）');
  const delivery = await api('POST', '/api/pipeline/delivery', {
    generate: {
      providerId: 'local-mock',
      prompts: ['ui icon lightning bolt', 'ui icon poison cloud'],
      base: { width: 512, height: 512, steps: 20 },
      countPerPrompt: 2,
      naming: { preset: 'game-ui', tokens: { category: 'icon', state: 'normal' } },
    },
    convert: { format: 'webp', quality: 85, resize: { mode: 'keep' } },
    inspect: { alphaPolicy: 'any', checkBlank: true },
    pack: { packageName: 'fullchain-delivery', version: 'v2.1.0', structure: 'flat', precheck: { enabled: true, strict: false } },
  });
  assert(delivery.json?.success === true, '全链路任务已受理', JSON.stringify(delivery.json?.error));
  const deliveryJob = await waitJob(delivery.json.data.job.id, { timeoutMs: 240000 });
  assert(['succeeded', 'partial'].includes(deliveryJob.status), `全链路完成（${deliveryJob.status}）`);
  const stages = deliveryJob.result?.stages || [];
  assert(stages.length === 4, `四阶段均执行（${stages.map((s) => s.stage).join(' → ')}）`);
  assert(Boolean(deliveryJob.result?.package?.file), `交付包已生成：${deliveryJob.result?.package?.file}`);
  assert(deliveryJob.artifacts.filter((a) => a.type === 'package').length === 1, '任务产物中含 1 个交付包');

  console.log('\n[7] 错误路径（统一错误结构）');
  const e1 = await api('POST', '/api/generate', { providerId: 'not-exist', prompts: ['x'] });
  assert(e1.json?.code === 'E_PROVIDER_NOT_FOUND', `未知提供方 → E_PROVIDER_NOT_FOUND（实际 ${e1.json?.code}）`);
  assert(e1.json?.error?.domain === 'NOT_FOUND' && e1.json?.error?.retryable === false, '错误体含 domain 与 retryable 字段');

  const e2 = await api('POST', '/api/generate/plan', { prompts: ['   '] });
  assert(e2.json?.code === 'E_VALIDATION_MISSING_FIELD', `空提示词 → E_VALIDATION_MISSING_FIELD（实际 ${e2.json?.code}）`);

  const e3 = await api('POST', '/api/generate/plan', { prompts: Array.from({ length: 90 }, (_, i) => `p${i}`), matrix: { width: [512, 768, 1024] } });
  assert(e3.json?.code === 'E_LIMIT_BATCH_TOO_LARGE', `超批次上限 → E_LIMIT_BATCH_TOO_LARGE（实际 ${e3.json?.code}，计划 ${e3.json?.error?.details?.planned} 项）`);

  const e4 = await api('GET', '/api/jobs/job_not_exist');
  assert(e4.json?.code === 'E_JOB_NOT_FOUND', `不存在任务 → E_JOB_NOT_FOUND（实际 ${e4.json?.code}）`);

  const e5 = await api('POST', '/api/convert', { source: 'upload' });
  assert(e5.json?.code === 'E_VALIDATION_MISSING_FIELD', `无上传文件 → E_VALIDATION_MISSING_FIELD（实际 ${e5.json?.code}）`);

  const e6 = await api('GET', '/api/nope');
  assert(e6.json?.code === 'E_ROUTE_NOT_FOUND', `未知路由 → E_ROUTE_NOT_FOUND（实际 ${e6.json?.code}）`);

  const e7 = await api('PATCH', '/api/providers/config', { providerId: 'openai-images', patch: { enabled: true } });
  const e7health = e7.json?.data?.provider?.health;
  assert(e7health?.ok === false && /API Key/.test(e7health?.detail || ''), `启用无密钥提供方 → 健康检查如实报缺失（${e7health?.detail}）`);
  const e8 = await api('PATCH', '/api/providers/config', { providerId: 'openai-images', patch: { enabled: false } });
  assert(e8.json?.data?.provider?.enabled === false, '提供方配置可热更新并落盘');

  console.log('\n[8] 命名规范试算');
  const naming = await api('POST', '/api/naming/validate', {
    preset: 'game-ui',
    filenames: ['icon_fire_normal_512x512.png', 'ICON_Fire_512x512.png', '图标_最终版.png'],
  });
  const nr = naming.json?.data?.results || [];
  assert(nr[0]?.valid === true, '合规文件名判定为通过');
  assert(nr[1]?.valid === false, '大写文件名判定为不通过');
  assert(Boolean(nr[2]?.canonical), `给出修复建议名：${nr[2]?.canonical}`);

  console.log('\n[9] SSE 实时进度流');
  const sseSubmit = await api('POST', '/api/convert', { source: 'job', jobIds: [genJob.id], format: 'avif', quality: 60, resize: { mode: 'maxEdge', maxEdge: 256 } });
  const sseJobId = sseSubmit.json?.data?.job?.id;
  const names = sseJobId ? await collectSse(`/api/jobs/${sseJobId}/events`, 25000) : [];
  assert(names.includes('snapshot'), 'SSE 首帧推送任务快照');
  assert(names.includes('progress'), `SSE 推送进度帧（${names.filter((n) => n === 'progress').length} 次）`);
  assert(names.includes('artifact'), 'SSE 逐产物推送 artifact 事件');
  assert(names.includes('finished'), 'SSE 在任务终态推送 finished 事件');

  console.log('\n[10] 任务控制（取消 / 重跑）');
  const ctl = await api('POST', '/api/generate', {
    providerId: 'local-mock',
    prompts: Array.from({ length: 6 }, (_, i) => `ui icon bulk item${i}`),
    base: { width: 1024, height: 1024 },
    countPerPrompt: 3,
  });
  const ctlId = ctl.json?.data?.job?.id;
  await new Promise((r) => setTimeout(r, 600));
  const cancel = await api('POST', `/api/jobs/${ctlId}/cancel`, {});
  assert(cancel.json?.data?.canceled === true, `排队中的任务可被取消（${cancel.json?.data?.was}）`);
  const canceledJob = await waitJob(ctlId, { timeoutMs: 30000, quiet: true });
  assert(canceledJob.status === 'canceled', `取消后终态为 canceled（实际 ${canceledJob.status}）`);
  const retry = await api('POST', `/api/jobs/${genJob.id}/retry`, {});
  assert(retry.json?.success === true, '已完成的失败可重跑（复用原参数）');
  if (retry.json?.success) await api('POST', `/api/jobs/${genJob.id}/cancel`, {}).catch(() => {});

  console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===`);
  if (fail) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('');
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\n冒烟测试异常终止：', err);
  process.exit(1);
});
