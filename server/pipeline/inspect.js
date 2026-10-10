/**
 * 资产完整性检查（Asset QA）。
 *
 * 把「美术交付验收」标准化为可批量执行的检查项，输出逐资产的 Finding[] 与 0-100 健康分。
 * 检查维度：
 *   A. 可解码性   —— 文件是否损坏、是否被截断
 *   B. 规格合规   —— 尺寸区间、2 的幂、长宽比、文件体积
 *   C. 通道合规   —— alpha 通道策略（UI 必须带透明 / 贴图禁止带透明）
 *   D. 内容质量   —— 纯色/近空白检测（常见于导出失败）
 *   E. 命名规范   —— 调用命名引擎
 *   F. 资产重复   —— dHash 感知哈希去重（容忍轻微压缩差异）
 *
 * 每项检查都遵循同一契约：{ level, rule, message, expected?, actual?, asset? }，
 * 前端与报告渲染只需一套逻辑。
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { AppError } from '../core/errors.js';
import { validateFilename, getPreset, PRESETS } from './naming.js';
import { humanBytes } from '../util/misc.js';

export const SEVERITY_WEIGHT = { error: 12, warn: 4, info: 0 };

export const DEFAULT_RULES = {
  minEdge: 8,
  maxEdge: 8192,
  requirePowerOfTwo: false,
  alphaPolicy: 'any', // any | require | forbid
  allowedFormats: null,
  maxFileSizeKB: 20480,
  minFileSizeKB: 0,
  maxAspectRatio: 8,
  checkBlank: true,
  blankStdDevThreshold: 2.0,
  detectDuplicates: true,
  // 重复判定的主判据是「16×16 灰度指纹的平均绝对差」（0-255 尺度）：
  // 单靠 dHash 汉明距离对纯色/平滑渐变类美术素材过于敏感，会把风格一致的图标整片误判为重复。
  // ≤ duplicateMeanDiff 视为完全重复（阻断），≤ similarMeanDiff 视为高度相似（警告）。
  duplicateMeanDiff: 1,
  similarMeanDiff: 6,
  namingPreset: 'game-ui',
  customNamingRules: null,
};

/**
 * 感知指纹：
 *  - hash：16x15 位 dHash（相对亮度符号），用于快速判等与粗筛；
 *  - grid：16x16 灰度指纹，用于度量真实差异（对平滑渐变类素材远好于汉明距离）。
 */
export async function perceptualFingerprint(filePath) {
  const raw = await sharp(filePath).greyscale().resize(16, 16, { fit: 'fill' }).raw().toBuffer();
  const bits = [];
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 15; x += 1) bits.push(raw[y * 16 + x] > raw[y * 16 + x + 1] ? '1' : '0');
  }
  return { hash: bits.join(''), grid: Buffer.from(raw) };
}

/** 平均绝对差（0-255 尺度）；0 表示逐像素一致。 */
function meanAbsDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** 兼容旧调用方。 */
export async function perceptualHash(filePath) {
  return (await perceptualFingerprint(filePath)).hash;
}

function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) d += 1;
  return d;
}

/** dHash 汉明距离：用于「完全重复」的快速二次确认（与灰度差互补）。 */
export function hashDistance(a, b) {
  return hamming(a, b);
}

/** 单资产检查：返回 { ok, score, findings, meta }。 */
export async function inspectAsset(filePath, options = {}) {
  const rules = { ...DEFAULT_RULES, ...options };
  const findings = [];
  const fileName = path.basename(filePath);
  const push = (level, rule, message, extra = {}) => findings.push({ level, rule, message, file: fileName, ...extra });

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    push('error', 'io.missing', '文件不存在或不可读');
    return { ok: false, score: 0, findings, meta: null, fileName };
  }

  // ---- A. 可解码性 ----
  let meta = null;
  try {
    const m = await sharp(filePath).metadata();
    if (!m.width || !m.height) throw new Error('缺少尺寸信息');
    meta = {
      format: m.format,
      width: m.width,
      height: m.height,
      channels: m.channels,
      hasAlpha: Boolean(m.hasAlpha),
      space: m.space,
      density: m.density || null,
      orientation: m.orientation || null,
      isAnimated: (m.pages || 1) > 1,
      pages: m.pages || 1,
      bytes: stat.size,
      bytesText: humanBytes(stat.size),
    };
    // 完整解码一遍，抓「元数据正常但像素数据损坏 / 被截断」的情况
    await sharp(filePath).raw().toBuffer({ resolveWithObject: true });
  } catch (err) {
    push('error', 'decode.failed', `图像无法解码：${err.message}`, { actual: humanBytes(stat.size) });
    return { ok: false, score: 0, findings, meta, fileName };
  }

  // ---- B. 规格合规 ----
  const minEdge = Math.min(meta.width, meta.height);
  const maxEdge = Math.max(meta.width, meta.height);
  if (minEdge < rules.minEdge) push('error', 'size.tooSmall', `最短边 ${minEdge}px 小于下限 ${rules.minEdge}px`, { actual: `${meta.width}x${meta.height}` });
  if (maxEdge > rules.maxEdge) push('error', 'size.tooLarge', `最长边 ${maxEdge}px 超过上限 ${rules.maxEdge}px`, { actual: `${meta.width}x${meta.height}` });

  if (rules.requirePowerOfTwo && (!isPow2(meta.width) || !isPow2(meta.height))) {
    push('warn', 'size.notPowerOfTwo', `尺寸 ${meta.width}x${meta.height} 非 2 的幂，可能影响 GPU 采样效率`);
  }

  const ratio = maxEdge / Math.max(1, minEdge);
  if (ratio > rules.maxAspectRatio) {
    push('warn', 'size.aspectRatio', `长宽比 ${ratio.toFixed(2)}:1 超过 ${rules.maxAspectRatio}:1，疑似裁切错误`);
  }

  if (rules.maxFileSizeKB && meta.bytes / 1024 > rules.maxFileSizeKB) {
    push('warn', 'size.fileTooLarge', `文件体积 ${meta.bytesText} 超过 ${rules.maxFileSizeKB}KB，建议压缩或转 WebP`, { actual: meta.bytesText });
  }
  if (rules.minFileSizeKB && meta.bytes / 1024 < rules.minFileSizeKB) {
    push('warn', 'size.fileTooSmall', `文件体积仅 ${meta.bytesText}，疑似空图或导出失败`);
  }

  // ---- C. 通道合规 ----
  if (rules.alphaPolicy === 'require' && !meta.hasAlpha) {
    push('error', 'alpha.required', '该资产要求保留透明通道，当前为不透明图（JPG 或已合并背景）');
  }
  if (rules.alphaPolicy === 'forbid' && meta.hasAlpha) {
    push('warn', 'alpha.forbidden', '该资产不允许透明通道，建议展平背景以减小体积');
  }
  if (rules.allowedFormats?.length && !rules.allowedFormats.includes(meta.format)) {
    push('error', 'format.notAllowed', `格式 ${meta.format} 不在允许列表 [${rules.allowedFormats.join(', ')}]`, { actual: meta.format });
  }

  // ---- D. 内容质量：近空白 / 纯色检测 ----
  if (rules.checkBlank) {
    try {
      const stats = await sharp(filePath).greyscale().stats();
      const [ch] = stats.channels;
      if (ch.stdev < rules.blankStdDevThreshold) {
        push('error', 'content.blank', `图像近似纯色（灰度标准差 ${ch.stdev.toFixed(2)} < ${rules.blankStdDevThreshold}），疑似空白导出`, { actual: ch.stdev.toFixed(2) });
      } else if (ch.stdev < rules.blankStdDevThreshold * 3) {
        push('info', 'content.lowVariance', `图像内容差异度偏低（标准差 ${ch.stdev.toFixed(2)}），请确认是否符合预期`);
      }
      meta.meanLuma = Number(ch.mean.toFixed(2));
      meta.stdDev = Number(ch.stdev.toFixed(2));
    } catch {
      push('info', 'content.statsFailed', '无法计算图像统计信息，已跳过内容质量检查');
    }
  }

  // ---- E. 命名规范 ----
  const ruleset = rules.customNamingRules || getPreset(rules.namingPreset) || PRESETS.loose;
  const naming = validateFilename(fileName, ruleset);
  for (const f of naming.findings) {
    findings.push({ ...f, file: fileName, group: 'naming', suggestion: naming.canonical });
  }
  meta.namingCanonical = naming.canonical;
  meta.namingTokens = naming.tokens;
  meta.namingValid = naming.valid;

  // ---- 评分 ----
  const penalty = findings.reduce((sum, f) => sum + (SEVERITY_WEIGHT[f.level] || 0), 0);
  const score = Math.max(0, 100 - penalty);

  return {
    ok: !findings.some((f) => f.level === 'error'),
    score,
    findings,
    meta,
    fileName,
    filePath,
  };
}

/** 批量检查：串行处理避免同时解码大图把内存打满，并逐项回报进度。 */
export async function inspectAssets(files, options = {}, ctx = {}) {
  const rules = { ...DEFAULT_RULES, ...options };
  const results = [];
  const total = files.length;

  for (let i = 0; i < total; i += 1) {
    if (ctx.signal?.aborted) throw new AppError('E_PIPELINE_ABORTED', '任务已被取消');
    const file = files[i];
    try {
      const r = await inspectAsset(file.path, rules);
      results.push({ ...r, relPath: file.relPath || path.basename(file.path) });
    } catch (err) {
      results.push({
        ok: false,
        score: 0,
        fileName: path.basename(file.path),
        relPath: file.relPath || path.basename(file.path),
        findings: [{ level: 'error', rule: 'inspect.exception', message: err.message, file: path.basename(file.path) }],
        meta: null,
      });
    }
    ctx.onProgress?.(Math.round(((i + 1) / total) * (rules.detectDuplicates ? 85 : 100)), `检查中 ${i + 1}/${total}`);
  }

  // ---- F. 重复检测 ----
  const duplicates = [];
  if (rules.detectDuplicates) {
    const hashed = [];
    for (let i = 0; i < results.length; i += 1) {
      const r = results[i];
      if (!r.meta) continue;
      try {
        const fp = await perceptualFingerprint(r.filePath);
        hashed.push({ index: i, hash: fp.hash, grid: fp.grid, file: r.relPath });
      } catch {
        /* 忽略指纹失败 */
      }
      ctx.onProgress?.(85 + Math.round(((i + 1) / results.length) * 12), '重复检测');
    }
    for (let i = 0; i < hashed.length; i += 1) {
      for (let j = i + 1; j < hashed.length; j += 1) {
        const diff = meanAbsDiff(hashed[i].grid, hashed[j].grid);
        const exact = diff <= rules.duplicateMeanDiff;
        if (!exact && diff > rules.similarMeanDiff) continue;
        duplicates.push({ a: hashed[i].file, b: hashed[j].file, distance: +diff.toFixed(2), exact });
        results[hashed[j].index].findings.push({
          level: exact ? 'error' : 'warn',
          rule: 'duplicate.detected',
          message: exact
            ? `与 ${hashed[i].file} 完全重复（灰度差 ${diff.toFixed(2)}）`
            : `与 ${hashed[i].file} 高度相似（灰度差 ${diff.toFixed(2)}），请确认是否为同一资产的冗余版本`,
          file: results[hashed[j].index].fileName,
          group: 'duplicate',
          related: hashed[i].file,
        });
      }
    }
    // 重复扣分
    for (const r of results) {
      const dupPenalty = r.findings.filter((f) => f.rule === 'duplicate.detected').reduce((s, f) => s + (f.level === 'error' ? 12 : 4), 0);
      if (dupPenalty) r.score = Math.max(0, r.score - dupPenalty);
    }
  }

  const summary = summarize(results, duplicates);
  ctx.onProgress?.(100, '检查完成');
  return { results, summary, duplicates, ruleset: rules.customNamingRules || getPreset(rules.namingPreset) || PRESETS.loose };
}

export function summarize(results, duplicates = []) {
  const byRule = {};
  const byLevel = { error: 0, warn: 0, info: 0 };
  let tokensTotal = 0;

  for (const r of results) {
    for (const f of r.findings) {
      byRule[f.rule] = (byRule[f.rule] || 0) + 1;
      byLevel[f.level] = (byLevel[f.level] || 0) + 1;
    }
    if (r.meta) tokensTotal += 1;
  }

  const passed = results.filter((r) => r.ok).length;
  const avgScore = results.length ? +(results.reduce((s, r) => s + r.score, 0) / results.length).toFixed(1) : 0;

  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length ? +(passed / results.length).toFixed(4) : 0,
    avgScore,
    duplicateGroups: duplicates.filter((d) => d.exact).length,
    duplicatePairs: duplicates.length,
    byLevel,
    byRule: Object.entries(byRule)
      .sort((a, b) => b[1] - a[1])
      .map(([rule, count]) => ({ rule, count })),
    totalBytes: results.reduce((s, r) => s + (r.meta?.bytes || 0), 0),
    decoded: tokensTotal,
  };
}

function isPow2(n) {
  return n > 0 && (n & (n - 1)) === 0;
}
