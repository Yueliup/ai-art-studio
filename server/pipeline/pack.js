/**
 * 交付打包。
 *
 * 美术交付物不是「一堆图」，而是一个可被下游流水线直接消费的包：
 *   assets/       资产本体（可扁平或按品类分目录）
 *   manifest.json 结构化清单：逐文件 sha256、尺寸、来源提供方、提示词、seed
 *   report.html   人读的自包含质检报告（缩略图内嵌，可直接发邮件/存档）
 *   README.txt    给下游的交付说明
 *
 * 打包前会执行前置校验（precheck）：存在 error 级问题时按策略阻断或放行并标注，
 * 避免把破损资产打到包里发出去。
 */

import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { AppError } from '../core/errors.js';
import { sha256, humanBytes, newPackageId, sanitizeFilename } from '../util/misc.js';
import { inspectAssets, DEFAULT_RULES } from './inspect.js';
import { buildReportHtml } from './report.js';

export const PACK_DEFAULTS = {
  packageName: 'ai-art-delivery',
  version: 'v1.0.0',
  structure: 'flat', // flat | byCategory
  includeManifest: true,
  includeReport: true,
  includeChecksums: true,
  precheck: { enabled: true, strict: false, rules: {} },
  compression: 'deflate',
  targetSizeMB: 0,
};

const CATEGORY_DIRS = {
  icon: 'icons',
  btn: 'ui/buttons',
  bg: 'backgrounds',
  panel: 'ui/panels',
  fx: 'effects',
  avatar: 'avatars',
  frame: 'ui/frames',
  badge: 'ui/badges',
};

export async function packAssets(input, ctx) {
  const o = { ...PACK_DEFAULTS, ...input, precheck: { ...PACK_DEFAULTS.precheck, ...(input.precheck || {}) } };
  const files = (input.files || []).filter(Boolean);

  if (!ctx?.outDir) throw new AppError('E_SYS_INTERNAL', '打包失败：未指定输出目录（ctx.outDir）');
  if (!files.length) throw new AppError('E_VALIDATION_MISSING_FIELD', '打包列表为空，没有可交付的资产', { field: 'files' });

  for (const f of files) {
    if (!fs.existsSync(f.path)) throw new AppError('E_ASSET_NOT_FOUND', `资产文件缺失：${f.relPath || f.path}`);
  }

  // ---- 前置校验 ----
  ctx.onProgress?.(5, '前置校验');
  let precheck = null;
  if (o.precheck.enabled) {
    const { results, summary } = await inspectAssets(
      files.map((f) => ({ path: f.path, relPath: f.relPath || path.basename(f.path) })),
      { ...DEFAULT_RULES, ...o.precheck.rules, detectDuplicates: true, namingPreset: o.precheck.rules.namingPreset || 'game-ui' },
      { signal: ctx.signal, onProgress: (p, s) => ctx.onProgress?.(5 + p * 0.25, s) }
    );
    precheck = { summary, blocked: results.filter((r) => !r.ok).map((r) => r.relPath), results };
    if (o.precheck.strict && precheck.blocked.length) {
      throw new AppError('E_STAGE_PRECHECK_FAILED', `前置校验未通过：${precheck.blocked.length} 个资产存在 error 级问题，已按严格模式阻断打包`, {
        details: { blocked: precheck.blocked.slice(0, 20), byRule: summary.byRule },
      });
    }
    ctx.onLog?.(precheck.blocked.length ? 'warn' : 'info', `前置校验完成：${summary.passed}/${summary.total} 通过，均分 ${summary.avgScore}`);
  }

  // ---- 组装包 ----
  ctx.onProgress?.(32, '生成清单');
  const zip = new AdmZip();
  const manifest = {
    schemaVersion: '1.0',
    packageName: sanitizeFilename(o.packageName),
    version: o.version,
    createdAt: new Date().toISOString(),
    generator: 'AI Art Studio · 资产交付中心',
    assetCount: files.length,
    totalBytes: 0,
    assets: [],
    precheck: precheck ? { summary: precheck.summary, blocked: precheck.blocked } : null,
    // 环境指纹：便于复现问题
    toolchain: { node: process.version, platform: process.platform, arch: process.arch },
  };

  const nameCount = new Map();
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    const buf = fs.readFileSync(f.path);
    const cat = guessCategory(path.basename(f.path));
    const dir = o.structure === 'byCategory' ? CATEGORY_DIRS[cat] || 'misc' : 'assets';
    let entryName = `${dir}/${path.basename(f.path)}`;
    if (nameCount.has(entryName)) {
      const n = nameCount.get(entryName) + 1;
      nameCount.set(entryName, n);
      const dot = entryName.lastIndexOf('.');
      entryName = `${entryName.slice(0, dot)}-${n}${entryName.slice(dot)}`;
    } else {
      nameCount.set(entryName, 1);
    }

    const meta = await sharp(buf).metadata().catch(() => ({}));
    const checksum = sha256(buf);
    zip.addFile(entryName, buf);
    manifest.assets.push({
      entry: entryName,
      file: path.basename(f.path),
      category: cat,
      bytes: buf.length,
      bytesText: humanBytes(buf.length),
      sha256: checksum,
      width: meta.width || null,
      height: meta.height || null,
      format: meta.format || null,
      hasAlpha: Boolean(meta.hasAlpha),
      source: f.source || f.providerId || 'unknown',
      prompt: f.prompt || null,
      seed: f.seed ?? null,
      score: f.score ?? null,
      qaOk: f.qaOk ?? null,
    });
    manifest.totalBytes += buf.length;
    ctx.onProgress?.(32 + Math.round(((i + 1) / files.length) * 20), `打包中 ${i + 1}/${files.length}`);
  }
  manifest.totalBytesText = humanBytes(manifest.totalBytes);

  // ---- 校验清单 ----
  if (o.includeChecksums) {
    zip.addFile(
      'checksums.sha256',
      Buffer.from(manifest.assets.map((a) => `${a.sha256}  ${a.entry}`).join('\n'), 'utf8')
    );
  }

  // ---- 报告 ----
  if (o.includeReport) {
    ctx.onProgress?.(56, '生成质检报告');
    const reportFiles = manifest.assets.map((a, i) => ({ path: files[i].path, relPath: a.entry }));
    const html = await buildReportHtml({
      title: `${o.packageName} · 交付质检报告`,
      version: o.version,
      files: reportFiles,
      assets: manifest.assets,
      precheck,
      generatedAt: manifest.createdAt,
    }, { signal: ctx.signal, onProgress: (p, s) => ctx.onProgress?.(56 + p * 0.24, s) });
    zip.addFile('report.html', Buffer.from(html, 'utf8'));
  }

  if (o.includeManifest) {
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  }

  zip.addFile('README.txt', Buffer.from(buildReadme(manifest, o), 'utf8'));

  // ---- 输出 ----
  ctx.onProgress?.(84, '写出文件');
  const packageId = newPackageId();
  const zipName = `${sanitizeFilename(o.packageName)}_${sanitizeFilename(o.version)}_${packageId}.zip`;
  const dest = path.join(ctx.outDir, zipName);
  fs.mkdirSync(ctx.outDir, { recursive: true });
  const zipBuffer = zip.toBuffer();
  fs.writeFileSync(dest, zipBuffer);

  const bundleChecksum = sha256(zipBuffer);
  ctx.onProgress?.(100, '打包完成');

  return {
    package: {
      id: packageId,
      name: sanitizeFilename(o.packageName),
      version: o.version,
      file: zipName,
      relPath: zipName,
      path: dest,
      bytes: zipBuffer.length,
      bytesText: humanBytes(zipBuffer.length),
      sha256: bundleChecksum,
      assetCount: manifest.assets.length,
      totalAssetBytes: manifest.totalBytes,
      compression: o.compression,
      structure: o.structure,
      entries: zip.getEntries().map((e) => ({ name: e.entryName, bytes: e.header.size })),
      createdAt: manifest.createdAt,
    },
    manifest,
    precheck,
    counts: { total: files.length, succeeded: manifest.assets.length, failed: 0, skipped: 0 },
  };
}

function guessCategory(filename) {
  const lower = filename.toLowerCase();
  for (const key of Object.keys(CATEGORY_DIRS)) {
    if (lower.startsWith(`${key}_`) || lower.includes(`_${key}_`)) return key;
  }
  return 'misc';
}

function buildReadme(manifest, o) {
  const lines = [
    `# ${manifest.packageName} ${manifest.version}`,
    '',
    `生成时间：${manifest.createdAt}`,
    `资产数量：${manifest.assetCount} 个（${manifest.totalBytesText}）`,
    `目录结构：${o.structure === 'byCategory' ? '按品类分目录' : '扁平结构（assets/）'}`,
    '',
    '## 包内文件',
    '  assets/            资产本体',
    '  manifest.json      结构化清单（含 sha256、尺寸、提示词、seed）',
    '  checksums.sha256   校验清单，可用于 CI 校验完整性',
    '  report.html        质检报告（浏览器直接打开，缩略图已内嵌）',
    '  README.txt         本文件',
    '',
    '## 校验方式',
    '  Linux/macOS:  sha256sum -c checksums.sha256',
    '  Windows:      Get-FileHash -Algorithm SHA256 <file>  # 与 manifest.json 比对',
    '',
    '## 资产来源',
    ...[...new Set(manifest.assets.map((a) => a.source))].map((s) => `  - ${s}: ${manifest.assets.filter((a) => a.source === s).length} 个`),
    '',
  ];
  return lines.join('\n');
}
