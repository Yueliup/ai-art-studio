/**
 * 泄漏自检：扫描全部只读接口的响应，确认没有把服务器绝对路径带出去。
 *
 * 为什么需要它：工具集内部到处用绝对路径（产物落盘位置、输出目录、产物包位置），
 * 只要有一个新路由忘了脱敏，部署到公网就是明确的信息泄漏。这种问题靠人眼 review 一定会漏，
 * 所以在发布前用一次真实的端到端扫描把它变成可回归的性质。
 *
 * 判定方式：**先 JSON.parse，再只对字符串值做锚定匹配**。
 * 直接对原始文本正则搜索会产生大量误报 —— 例如 `http://127.0.0.1:7860` 里的 `p://`
 * 会被当成 Windows 盘符路径，JSON 转义出来的 `\\u4e00` 会被当成 UNC 路径。
 *
 * 用法：node scripts/privacy-check.mjs [baseUrl]
 * 退出码 0 表示未发现泄漏。
 */

const BASE = process.argv[2] || 'http://127.0.0.1:8848';

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 只测「值本身」的绝对路径特征，全部锚定，避免误伤 /api/... 这类相对路径。 */
const VALUE_PATTERNS = [
  { name: 'Windows 盘符路径', re: /^[A-Za-z]:[\\/]/ },
  { name: 'UNC 路径', re: /^\\\\[^\\/]+[\\/]/ },
  { name: 'POSIX 系统目录', re: /^\/(?:home|Users|root|var|opt|srv|mnt|app|workspace)\// },
  { name: '家目录/用户名痕迹', re: /Administrator/i },
];

let failures = 0;
const leaks = [];
let scannedEndpoints = 0;
let scannedValues = 0;

function collectStrings(value, path, out) {
  if (typeof value === 'string') {
    out.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectStrings(v, `${path}[${i}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectStrings(v, path ? `${path}.${k}` : k, out);
  }
}

async function scan(label, path) {
  scannedEndpoints += 1;
  let json;
  let text = '';
  try {
    const res = await fetch(`${BASE}${path}`);
    text = await res.text();
    json = JSON.parse(text);
  } catch (err) {
    console.log(`  \x1b[33m!\x1b[0m ${label} 无法解析为 JSON（${err.message}）`);
    return null;
  }

  const strings = [];
  collectStrings(json, '', strings);
  scannedValues += strings.length;

  for (const s of strings) {
    if (URL_LIKE.test(s.value)) continue; // http(s):// 不是文件系统路径
    for (const { name, re } of VALUE_PATTERNS) {
      if (re.test(s.value)) {
        leaks.push({ label, pattern: name, field: s.path, value: s.value.slice(0, 160) });
      }
    }
  }
  return json;
}

const main = async () => {
  console.log(`\n=== 泄漏自检 @ ${BASE} ===\n`);

  await scan('GET /api/system/meta', '/api/system/meta');
  await scan('GET /api/system/health', '/api/system/health');
  await scan('GET /api/stats/overview', '/api/stats/overview');
  await scan('GET /api/config/paths', '/api/config/paths');
  await scan('GET /api/config/raw', '/api/config/raw');
  await scan('GET /api/providers', '/api/providers');
  await scan('GET /api/workspace/tree', '/api/workspace/tree?subdir=outputs');
  await scan('GET /api/system/routes', '/api/system/routes');

  // 任务详情是最容易漏的地方：result.outDir / package.path / artifact.path 都可能是绝对路径
  const jobs = await scan('GET /api/jobs', '/api/jobs?pageSize=20');
  const items = jobs?.data?.items || [];
  let detailCount = 0;
  for (const item of items.slice(0, 15)) {
    await scan(`GET /api/jobs/${item.id}`, `/api/jobs/${item.id}`);
    detailCount += 1;
  }

  const withArtifacts = items.find((j) => j.artifacts > 0);
  if (withArtifacts) await scan('GET /api/jobs/:id/artifacts', `/api/jobs/${withArtifacts.id}/artifacts`);

  // SSE 的 artifact 事件同样要检查（它绕过 HTTP 序列化层直接推送）
  if (withArtifacts) {
    scannedEndpoints += 1;
    try {
      const res = await fetch(`${BASE}/api/jobs/${withArtifacts.id}/events`, { headers: { Accept: 'text/event-stream' } });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let stopped = false;
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          const m = part.match(/^data: (.+)$/m);
          if (!m || !m[1].startsWith('{')) continue;
          try {
            const payload = JSON.parse(m[1]);
            const strings = [];
            collectStrings(payload, 'sse', strings);
            scannedValues += strings.length;
            for (const s of strings) {
              if (URL_LIKE.test(s.value)) continue;
              for (const { name, re } of VALUE_PATTERNS) {
                if (re.test(s.value)) leaks.push({ label: 'SSE /api/jobs/:id/events', pattern: name, field: s.path, value: s.value.slice(0, 160) });
              }
            }
            if (payload.status && ['succeeded', 'failed', 'partial', 'canceled'].includes(payload.status)) {
              stopped = true;
            }
          } catch {
            /* 忽略非 JSON 事件 */
          }
        }
        if (stopped) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    } catch (err) {
      console.log(`  \x1b[33m!\x1b[0m SSE 检查跳过：${err.message}`);
    }
  }

  console.log(`扫描：${scannedEndpoints} 个接口（含 ${detailCount} 个任务详情 + SSE），${scannedValues} 个字符串值\n`);

  if (!leaks.length) {
    console.log('  \x1b[32m✓\x1b[0m 未发现绝对路径泄漏');
  } else {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m 发现 ${leaks.length} 处泄漏：`);
    for (const l of leaks) console.log(`      [${l.pattern}] ${l.label}\n        ${l.field} = ${l.value}`);
  }

  console.log(`\n=== 结果：${failures ? '失败' : '通过'} ===\n`);
  process.exit(failures ? 1 : 0);
};

main().catch((err) => {
  console.error('自检异常终止：', err.message);
  process.exit(1);
});
