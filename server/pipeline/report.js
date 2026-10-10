/**
 * 自包含 HTML 质检报告生成器。
 *
 * 设计目标：任何人在任何环境双击就能看，不依赖网络、不依赖服务 —— 因此缩略图全部内嵌为
 * data URI，CSS 内联，无外部字体与脚本。体积通过缩略图限宽（默认 160px）控制。
 *
 * 报告面向两类读者：
 *  - 美术/设计：看「哪些资产有问题、问题在哪、建议改成什么」
 *  - 主程/TA：看「通过率、均分、规则命中分布」，用于评估流水线健康度
 */

import sharp from 'sharp';
import { humanBytes } from '../util/misc.js';

const LEVEL_META = {
  error: { label: '阻断', color: '#d92d20', bg: '#fef3f2', border: '#fecdca' },
  warn: { label: '警告', color: '#b54708', bg: '#fffaeb', border: '#fedf89' },
  info: { label: '提示', color: '#175cd3', bg: '#eff8ff', border: '#b2ddff' },
};

const RULE_LABELS = {
  'decode.failed': '图像解码失败',
  'io.missing': '文件缺失',
  'size.tooSmall': '尺寸过小',
  'size.tooLarge': '尺寸超限',
  'size.notPowerOfTwo': '尺寸非 2 的幂',
  'size.aspectRatio': '长宽比异常',
  'size.fileTooLarge': '文件体积过大',
  'size.fileTooSmall': '文件体积过小',
  'alpha.required': '缺少透明通道',
  'alpha.forbidden': '多余透明通道',
  'format.notAllowed': '格式不在白名单',
  'content.blank': '疑似空白图',
  'content.lowVariance': '内容差异度低',
  'duplicate.detected': '重复资产',
  'pattern.mismatch': '不符合命名模板',
  'charset.forbidden': '含禁止字符',
  'word.forbidden': '含禁用词',
  'ext.notAllowed': '扩展名不合规',
  'case.style': '大小写风格不符',
  'token.missing': '缺少必需字段',
  'length.max': '文件名超长',
  'length.min': '文件名过短',
};

export async function buildReportHtml({ title, version, files, assets, precheck, generatedAt }, ctx = {}) {
  const summary = precheck?.summary || null;
  const results = precheck?.results || [];

  // ---- 生成缩略图 ----
  const thumbs = new Map();
  const limit = 24;
  for (let i = 0; i < Math.min(files.length, limit); i += 1) {
    const f = files[i];
    try {
      const buf = await sharp(f.path)
        .resize(160, 160, { fit: 'inside', withoutEnlargement: true })
        .png({ compressionLevel: 9, palette: true, quality: 70 })
        .toBuffer();
      thumbs.set(f.relPath, `data:image/png;base64,${buf.toString('base64')}`);
    } catch {
      thumbs.set(f.relPath, null);
    }
    ctx.onProgress?.(Math.round(((i + 1) / Math.min(files.length, limit)) * 100), '生成缩略图');
  }

  const kpis = summary
    ? [
        { label: '资产总数', value: summary.total, tone: 'neutral' },
        { label: '通过 / 未通过', value: `${summary.passed} / ${summary.failed}`, tone: summary.failed ? 'warn' : 'ok' },
        { label: '通过率', value: `${(summary.passRate * 100).toFixed(1)}%`, tone: summary.passRate >= 0.95 ? 'ok' : summary.passRate >= 0.8 ? 'warn' : 'error' },
        { label: '平均健康分', value: summary.avgScore, tone: summary.avgScore >= 90 ? 'ok' : summary.avgScore >= 70 ? 'warn' : 'error' },
        { label: '阻断 / 警告 / 提示', value: `${summary.byLevel.error} / ${summary.byLevel.warn} / ${summary.byLevel.info}`, tone: summary.byLevel.error ? 'error' : 'ok' },
        { label: '重复资产对', value: summary.duplicatePairs, tone: summary.duplicatePairs ? 'warn' : 'ok' },
        { label: '总资产体积', value: humanBytes(summary.totalBytes), tone: 'neutral' },
        { label: '检查项命中数', value: summary.byRule.length, tone: 'neutral' },
      ]
    : [];

  const ruleRows = (summary?.byRule || [])
    .map(
      (r) => `<tr><td>${esc(RULE_LABELS[r.rule] || r.rule)}</td><td class="mono">${esc(r.rule)}</td><td class="num">${r.count}</td></tr>`
    )
    .join('');

  const assetCards = results
    .map((r) => {
      const findings = r.findings || [];
      const thumb = thumbs.get(r.relPath);
      const level = findings.some((f) => f.level === 'error') ? 'error' : findings.some((f) => f.level === 'warn') ? 'warn' : 'ok';
      const meta = r.meta || {};
      return `
      <article class="asset ${level}">
        <div class="thumb">${thumb ? `<img src="${thumb}" alt="">` : '<span class="noimg">无预览</span>'}</div>
        <div class="asset-body">
          <header>
            <h4 title="${esc(r.relPath)}">${esc(r.relPath)}</h4>
            <span class="score ${level}">${r.score}</span>
          </header>
          <div class="meta mono">
            ${meta.width && meta.height ? `${meta.width}×${meta.height}` : '—'} · ${meta.format || '—'} ·
            ${meta.bytesText || '—'} · alpha:${meta.hasAlpha ? '有' : '无'}
            ${meta.meanLuma !== undefined ? ` · 均值${meta.meanLuma}` : ''}
          </div>
          ${findings.length ? `<ul class="findings">${findings.slice(0, 6).map(renderFinding).join('')}</ul>` : '<p class="ok-text">通过全部检查项</p>'}
          ${meta.namingCanonical && !meta.namingValid ? `<p class="suggest">建议命名：<code>${esc(meta.namingCanonical)}</code></p>` : ''}
        </div>
      </article>`;
    })
    .join('');

  const noCheckSection = summary
    ? ''
    : '<p class="notice">本次打包未启用前置校验，报告仅包含清单信息。</p>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --ink:#101828; --ink2:#475467; --line:#e4e7ec; --bg:#f9fafb; --card:#fff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width:1180px; margin:0 auto; padding:32px 24px 64px; }
  .head { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; border-bottom:2px solid var(--ink); padding-bottom:16px; margin-bottom:24px; }
  h1 { margin:0 0 4px; font-size:24px; letter-spacing:-.01em; }
  .sub { color:var(--ink2); font-size:13px; }
  .badge { display:inline-block; padding:2px 10px; border-radius:999px; background:var(--ink); color:#fff; font-size:12px; font-weight:600; }
  h2 { font-size:15px; text-transform:uppercase; letter-spacing:.06em; color:var(--ink2); margin:32px 0 12px; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
  .kpi { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .kpi .k { font-size:12px; color:var(--ink2); }
  .kpi .v { font-size:22px; font-weight:700; margin-top:4px; font-variant-numeric:tabular-nums; }
  .kpi.ok .v { color:#067647; } .kpi.warn .v { color:#b54708; } .kpi.error .v { color:#d92d20; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  th,td { text-align:left; padding:9px 14px; border-bottom:1px solid var(--line); font-size:13px; }
  th { background:#f2f4f7; font-weight:600; color:var(--ink2); }
  tr:last-child td { border-bottom:none; }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  .mono { font-family:ui-monospace,"SFMono-Regular",Consolas,monospace; font-size:12px; color:var(--ink2); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:14px; }
  .asset { background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; display:flex; flex-direction:column; }
  .asset.error { border-left:4px solid #d92d20; } .asset.warn { border-left:4px solid #f79009; }
  .thumb { height:150px; background:repeating-conic-gradient(#f2f4f7 0% 25%, #fff 0% 50%) 50%/16px 16px; display:flex; align-items:center; justify-content:center; }
  .thumb img { max-width:100%; max-height:100%; object-fit:contain; }
  .noimg { color:#98a2b3; font-size:12px; }
  .asset-body { padding:12px 14px 14px; }
  .asset-body header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  h4 { margin:0; font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .score { font-weight:700; font-size:13px; padding:1px 8px; border-radius:6px; font-variant-numeric:tabular-nums; }
  .score.ok { background:#ecfdf3; color:#067647; } .score.warn { background:#fffaeb; color:#b54708; } .score.error { background:#fef3f2; color:#d92d20; }
  .findings { list-style:none; margin:8px 0 0; padding:0; display:flex; flex-direction:column; gap:5px; }
  .findings li { font-size:12px; border-radius:6px; padding:5px 8px; border:1px solid; display:flex; gap:6px; align-items:flex-start; }
  .findings li.error { background:#fef3f2; border-color:#fecdca; color:#912018; }
  .findings li.warn { background:#fffaeb; border-color:#fedf89; color:#93370d; }
  .findings li.info { background:#eff8ff; border-color:#b2ddff; color:#175cd3; }
  .findings .rule { flex:none; font-weight:600; }
  .ok-text { color:#067647; font-size:12px; margin:8px 0 0; }
  .suggest { margin:8px 0 0; font-size:12px; color:var(--ink2); }
  .suggest code { background:#f2f4f7; padding:1px 6px; border-radius:4px; font-size:12px; }
  .notice { background:#fffaeb; border:1px solid #fedf89; border-radius:8px; padding:10px 14px; color:#93370d; }
  footer { margin-top:40px; padding-top:16px; border-top:1px solid var(--line); color:#98a2b3; font-size:12px; display:flex; justify-content:space-between; }
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <div>
      <h1>${esc(title)}</h1>
      <div class="sub">生成时间 ${esc(generatedAt)} · 资产 ${files.length} 个${summary ? ` · 通过率 ${(summary.passRate * 100).toFixed(1)}%` : ''}</div>
    </div>
    <span class="badge">${esc(version || 'v1.0.0')}</span>
  </div>

  ${summary ? `<h2>总体评价</h2><div class="kpis">${kpis.map((k) => `<div class="kpi ${k.tone}"><div class="k">${esc(k.label)}</div><div class="v">${esc(String(k.value))}</div></div>`).join('')}</div>` : noCheckSection}

  ${summary && summary.byRule.length ? `<h2>规则命中分布</h2><table><thead><tr><th>检查项</th><th>规则 ID</th><th class="num">命中</th></tr></thead><tbody>${ruleRows}</tbody></table>` : ''}

  <h2>逐资产明细</h2>
  ${results.length ? `<div class="grid">${assetCards}</div>` : '<p class="notice">无逐资产明细。</p>'}

  <h2>资产清单</h2>
  <table>
    <thead><tr><th>路径</th><th>尺寸</th><th>格式</th><th class="num">体积</th><th class="mono">sha256</th></tr></thead>
    <tbody>
      ${assets
        .map(
          (a) =>
            `<tr><td class="mono">${esc(a.entry)}</td><td class="mono">${a.width || '—'}×${a.height || '—'}</td><td class="mono">${esc(a.format || '—')}</td><td class="num">${esc(a.bytesText || '')}</td><td class="mono">${esc(String(a.sha256 || '').slice(0, 16))}…</td></tr>`
        )
        .join('')}
    </tbody>
  </table>

  <footer>
    <span>AI Art Studio · 资产交付中心</span>
    <span>本报告为自包含文件，缩略图已内嵌，可离线归档</span>
  </footer>
</div>
</body>
</html>`;
}

function renderFinding(f) {
  return `<li class="${f.level}"><span class="rule">[${LEVEL_META[f.level]?.label || f.level}]</span><span>${esc(f.message)}${f.expected ? `<br><span class="mono">期望：${esc(String(f.expected))}</span>` : ''}</span></li>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export { LEVEL_META, RULE_LABELS };
