/**
 * 批量生成流水线。
 *
 * 这是「AI 美术生产」的主入口，把一次美术需求翻译成一批可追溯的资产：
 *
 *   需求(矩阵) ──▶ 展开为 N 个生成项 ──▶ 逐项调用提供方 ──▶ 落盘 + 规范命名
 *                                                        ├─▶ 可选：自动转格式
 *                                                        └─▶ 可选：自动质检
 *
 * 关键工程点：
 *  - 矩阵展开：prompt × 尺寸 × 模型 × 风格 的组合爆炸在提交前就算清楚，超限直接拒绝；
 *  - 逐项隔离：单项失败只记该项的错误码，不中断整批（美术最怕整批白跑）；
 *  - 命名即交付：生成即按规范集命名，避免事后重命名返工；
 *  - 断点可查：每张图的 provider/model/prompt/seed/耗时都写进 artifact，可复现。
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { AppError } from '../core/errors.js';
import { providers } from '../adapters/index.js';
import { buildName, getPreset } from './naming.js';import { convertAsset, resolveOptions } from './convert.js';
import { inspectAsset, DEFAULT_RULES } from './inspect.js';
import { hashString, sanitizeFilename, humanBytes } from '../util/misc.js';
import { logger } from '../core/logger.js';

export const GENERATE_DEFAULTS = {
  providerId: null,
  prompts: [],
  base: {},
  matrix: {},
  countPerPrompt: 1,
  seedMode: 'increment',
  seedStart: -1,
  naming: { preset: 'game-ui', tokens: {}, customRules: null },
  postProcess: { convert: null, inspect: null },
  outputSubdir: '',
};

/** 把请求规范化为「生成项」列表；同时完成规模预估与限额校验。 */
export function planItems(input, { maxItems = 200 } = {}) {
  const cfg = {
    ...GENERATE_DEFAULTS,
    ...input,
    base: { ...GENERATE_DEFAULTS.base, ...(input.base || {}) },
    naming: { ...GENERATE_DEFAULTS.naming, ...(input.naming || {}) },
    postProcess: { ...GENERATE_DEFAULTS.postProcess, ...(input.postProcess || {}) },
  };

  const prompts = normalizePrompts(cfg.prompts);
  if (!prompts.length) throw new AppError('E_VALIDATION_MISSING_FIELD', '至少需要 1 条提示词', { field: 'prompts' });

  const matrix = normalizeMatrix(cfg.matrix);
  const combos = cartesian(matrix);
  const items = [];

  for (const p of prompts) {
    for (const combo of combos) {
      items.push({
        prompt: composePrompt(p.text, combo),
        negativePrompt: p.negativePrompt ?? cfg.base.negativePrompt ?? '',
        width: Number(combo.width ?? cfg.base.width ?? 1024),
        height: Number(combo.height ?? cfg.base.height ?? 1024),
        steps: combo.steps ?? cfg.base.steps,
        cfgScale: combo.cfgScale ?? cfg.base.cfgScale,
        sampler: combo.sampler ?? cfg.base.sampler,
        model: combo.model ?? cfg.base.model,
        stylePreset: combo.stylePreset ?? cfg.base.stylePreset ?? 'none',
        batchSize: Math.max(1, Number(cfg.countPerPrompt) || 1),
        seed: -1,
        label: promptLabel(p, combo),
        combo,
        sourcePrompt: p.text,
        referenceImage: p.referenceImage || null,
      });
    }
  }

  if (items.length > maxItems) {
    throw new AppError('E_LIMIT_BATCH_TOO_LARGE', `本次将产生 ${items.length} 个生成项，超过单批上限 ${maxItems}`, {
      details: { planned: items.length, limit: maxItems, hint: '减少提示词数量、矩阵维度或分批提交' },
    });
  }

  const totalImages = items.reduce((s, it) => s + it.batchSize, 0);
  if (totalImages > maxItems) {
    throw new AppError('E_LIMIT_BATCH_TOO_LARGE', `本次将产生 ${totalImages} 张图，超过单批上限 ${maxItems}`, {
      details: { planned: totalImages, limit: maxItems },
    });
  }

  // 只有取值多于 1 个的维度才真正构成「矩阵」；单值维度仍会生效，但不该被当作维度展示
  const matrixDims = Object.entries(matrix)
    .filter(([, v]) => v.length > 1)
    .map(([k]) => k);

  return { items, totalImages, matrixDims, prompts: prompts.length, ruleset: cfg.naming.customRules || getPreset(cfg.naming.preset) || getPreset('loose') };
}

/** 预测某个生成项的落盘文件名，供「预演计划」展示真实的命名结果。 */
export function predictFilenames(items, ruleset, namingTokens = {}) {
  return items.map((item) => {
    const name = namingTokens.name || deriveName(item.sourcePrompt);
    const tokens = {
      ...namingTokens,
      name,
      state: namingTokens.state || 'normal',
      w: item.width,
      h: item.height,
      ext: 'png',
    };
    let fileName = buildName(ruleset, tokens);
    if (!/\.[a-z0-9]+$/i.test(fileName)) fileName = `${fileName}.png`;
    return fileName;
  });
}

function normalizePrompts(input) {
  if (typeof input === 'string') return input.split('\n').map((s) => s.trim()).filter(Boolean).map((text) => ({ text }));
  if (!Array.isArray(input)) return [];
  return input
    .map((p) => {
      if (typeof p === 'string') return { text: p.trim() };
      if (p && typeof p === 'object') return { text: String(p.text || p.prompt || '').trim(), negativePrompt: p.negativePrompt, referenceImage: p.referenceImage };
      return null;
    })
    .filter((p) => p && p.text);
}

function normalizeMatrix(matrix) {
  const out = {};
  for (const [k, v] of Object.entries(matrix || {})) {
    if (v === undefined || v === null) continue;
    const arr = (Array.isArray(v) ? v : [v]).filter((x) => x !== '' && x !== null && x !== undefined);
    // 只有多于一个取值时才构成矩阵维度，避免无意义的组合
    if (arr.length) out[k] = arr;
  }
  return out;
}

function cartesian(dims) {
  const keys = Object.keys(dims);
  if (!keys.length) return [{}];
  return keys.reduce((acc, key) => acc.flatMap((combo) => dims[key].map((v) => ({ ...combo, [key]: v }))), [{}]);
}

function composePrompt(text, combo) {
  let out = text;
  for (const [k, v] of Object.entries(combo)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return out;
}

function promptLabel(p, combo) {
  const dims = Object.entries(combo).map(([k, v]) => `${k}=${v}`).join(',');
  return dims ? `${p.text.slice(0, 24)} [${dims}]` : p.text.slice(0, 32);
}

/** slug：把提示词压成可进文件名的短标识。 */
export function promptSlug(text, maxLen = 16) {
  const ascii = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii.length >= 3) return ascii.slice(0, maxLen).replace(/-+$/, '');
  return `p${hashString(String(text)).toString(36).slice(0, 6)}`;
}

/** 命名时应当忽略的通用词，避免出现 icon_ui_icon_xxx 这类冗余。 */
const NAME_STOPWORDS = new Set([
  'ui', 'ux', 'icon', 'icons', 'game', 'art', 'image', 'img', 'asset', 'sprite', 'texture',
  'of', 'the', 'a', 'an', 'and', 'for', 'with', 'style', 'aaa', 'hd', 'png',
]);

/**
 * 从提示词推导 {name} token —— 必须是**单个不含分隔符的词**，
 * 否则会破坏 `{category}_{name}_{state}_{w}x{h}` 的结构（name 里再带 `_` 会导致模板解析错位）。
 * 策略：取前两个有意义的英文词直接拼接（fire+spell → firespell），既合规又可读、还能保持唯一性。
 */
export function deriveName(text, maxLen = 24) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !NAME_STOPWORDS.has(w) && !/^\d+$/.test(w));
  if (!words.length) return `p${hashString(String(text)).toString(36).slice(0, 6)}`;
  const joined = `${words[0]}${words[1] || ''}`.slice(0, maxLen);
  return joined.length >= 2 ? joined : `p${hashString(String(text)).toString(36).slice(0, 6)}`;
}

/**
 * 执行批量生成。
 * @param {object} input 请求参数
 * @param {{signal:AbortSignal,onProgress:Function,onLog:Function,outDir:string}} ctx
 */
export async function runGenerate(input, ctx) {
  const cfg = {
    ...GENERATE_DEFAULTS,
    ...input,
    base: { ...GENERATE_DEFAULTS.base, ...(input.base || {}) },
    naming: { ...GENERATE_DEFAULTS.naming, ...(input.naming || {}) },
    postProcess: { ...GENERATE_DEFAULTS.postProcess, ...(input.postProcess || {}) },
  };

  const providerId = cfg.providerId || providers.activeId;
  const { items, totalImages, matrixDims } = planItems(input);
  const outDir = cfg.outputSubdir ? path.join(ctx.outDir, cfg.outputSubdir) : ctx.outDir;
  fs.mkdirSync(outDir, { recursive: true });

  const ruleset = cfg.naming.customRules || getPreset(cfg.naming.preset) || getPreset('loose');
  const started = Date.now();
  const results = [];
  const artifacts = [];
  const convertOptions = cfg.postProcess?.convert ? resolveOptions(cfg.postProcess.convert) : null;
  const inspectOptions = cfg.postProcess?.inspect ? { ...DEFAULT_RULES, ...cfg.postProcess.inspect } : null;

  ctx.onLog?.('info', `生成计划：${items.length} 个生成项 / ${totalImages} 张图，提供方 ${providerId}`);
  logger.info('generate.plan', { providerId, items: items.length, totalImages, matrixDims });

  let doneImages = 0;
  let seedCursor = cfg.seedMode === 'fixed' ? Number(cfg.seedStart) : -1;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (ctx.signal?.aborted) throw new AppError('E_PIPELINE_ABORTED', '任务已被取消');

    const itemStart = Date.now();
    const itemSeed = resolveSeed(cfg, item, seedCursor);
    if (cfg.seedMode === 'increment' && itemSeed >= 0) seedCursor = itemSeed + item.batchSize;

    const itemProgressBase = (doneImages / totalImages) * 100;

    try {
      const { images, attempts } = await providers.generate(
        providerId,
        { ...item, seed: itemSeed },
        {
          signal: ctx.signal,
          onProgress: (p, stage) => ctx.onProgress?.(itemProgressBase + (p / 100) * (item.batchSize / totalImages) * 100, stage || `生成中 ${i + 1}/${items.length}`),
          onLog: ctx.onLog,
        }
      );

      for (let k = 0; k < images.length; k += 1) {
        if (ctx.signal?.aborted) throw new AppError('E_PIPELINE_ABORTED', '任务已被取消');
        const img = images[k];
        const written = await persistImage(img, { outDir, ruleset, cfg, item, index: k, providerId });

        let conversion = null;
        let inspection = null;

        if (convertOptions) {
          try {
            const conv = await convertAsset(written.path, outDir, convertOptions, { signal: ctx.signal });
            conversion = { outputs: conv.outputs };
          } catch (err) {
            conversion = { error: { code: err.code || 'E_PIPELINE_STEP_FAILED', message: err.message } };
            ctx.onLog?.('warn', `自动转格式失败 ${written.file}：${err.message}`);
          }
        }

        if (inspectOptions) {
          try {
            const qa = await inspectAsset(written.path, inspectOptions);
            inspection = { ok: qa.ok, score: qa.score, findings: qa.findings, meta: qa.meta };
          } catch (err) {
            inspection = { error: { code: err.code, message: err.message }, ok: false, score: 0, findings: [] };
          }
        }

        const artifact = {
          id: `${written.file}#${k}`,
          type: 'image',
          file: written.file,
          relPath: written.relPath,
          path: written.path,
          bytes: written.bytes,
          bytesText: humanBytes(written.bytes),
          width: written.width,
          height: written.height,
          format: 'png',
          providerId,
          model: item.model,
          prompt: item.prompt,
          negativePrompt: item.negativePrompt || null,
          seed: written.seed,
          steps: item.steps ?? null,
          cfgScale: item.cfgScale ?? null,
          sampler: item.sampler ?? null,
          durationMs: Date.now() - itemStart,
          attempts,
          score: inspection?.score ?? null,
          qaOk: inspection?.ok ?? null,
          conversion,
          findings: inspection?.findings ?? [],
        };

        artifacts.push(artifact);
        ctx.onArtifact?.(artifact);
        doneImages += 1;
        ctx.onProgress?.((doneImages / totalImages) * 100, `已产出 ${doneImages}/${totalImages}`);
      }

      results.push({
        status: 'success',
        label: item.label,
        attempts,
        count: images.length,
        durationMs: Date.now() - itemStart,
      });
    } catch (err) {
      const appErr = err instanceof AppError ? err : new AppError('E_PIPELINE_STEP_FAILED', err.message);
      if (appErr.code === 'E_PIPELINE_ABORTED') throw appErr;
      results.push({
        status: 'failed',
        label: item.label,
        code: appErr.code,
        message: appErr.message,
        durationMs: Date.now() - itemStart,
      });
      doneImages += item.batchSize;
      ctx.onLog?.('error', `生成失败「${item.label}」：${appErr.message}`);
      ctx.onProgress?.((doneImages / totalImages) * 100, `已产出 ${doneImages}/${totalImages}`);
    }
  }

  const succeeded = results.filter((r) => r.status === 'success').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const byCode = {};
  for (const r of results) if (r.status === 'failed') byCode[r.code] = (byCode[r.code] || 0) + 1;

  const qaScored = artifacts.filter((a) => a.score !== null);
  const summary = {
    providerId,
    plannedItems: items.length,
    plannedImages: totalImages,
    generated: artifacts.length,
    failedItems: failed,
    succeededItems: succeeded,
    byCode,
    durationMs: Date.now() - started,
    avgScore: qaScored.length ? +(qaScored.reduce((s, a) => s + a.score, 0) / qaScored.length).toFixed(1) : null,
    qaFailed: artifacts.filter((a) => a.qaOk === false).length,
    totalBytes: artifacts.reduce((s, a) => s + a.bytes, 0),
    totalBytesText: humanBytes(artifacts.reduce((s, a) => s + a.bytes, 0)),
    avgMsPerImage: artifacts.length ? Math.round((Date.now() - started) / artifacts.length) : 0,
  };

  return {
    artifacts,
    results,
    summary,
    counts: { total: totalImages, succeeded: artifacts.length, failed: totalImages - artifacts.length, skipped: failed },
  };
}

function resolveSeed(cfg, item, cursor) {
  if (cfg.seedMode === 'fixed') return Number(cfg.seedStart) >= 0 ? Number(cfg.seedStart) : -1;
  if (cfg.seedMode === 'random') return -1;
  if (cursor >= 0) return cursor;
  // increment 模式但用户没给起点：用提示词哈希做起点，保证可复现
  return hashString(item.prompt) % 2 ** 30;
}

/** 落盘 + 规范命名。命名冲突时追加序号，而不是覆盖已有资产。 */
async function persistImage(img, { outDir, ruleset, cfg, item, index, providerId }) {
  const buf = img.data || (await providers.get(providerId).fetchResult(img));
  const meta = await sharp(buf).metadata();
  const ext = (img.mime || 'image/png').includes('jpeg') ? 'jpg' : 'png';

  const tokens = {
    ...cfg.naming.tokens,
    name: cfg.naming.tokens?.name || deriveName(item.sourcePrompt),
    state: cfg.naming.tokens?.state || 'normal',
    w: meta.width,
    h: meta.height,
    ext,
    seed: img.seed ?? 0,
    index: String(index + 1).padStart(2, '0'),
    variant: cfg.naming.tokens?.variant || String(index + 1).padStart(2, '0'),
    model: sanitizeFilename(String(item.model || 'model')).toLowerCase().replace(/[^a-z0-9]/g, ''),
  };

  // 同一次请求内产出多张时，{name} 后追加序号作为天然唯一键。
  // 这样不会破坏 `{category}_{name}_{state}_{w}x{h}` 的结构（若改用 `-1` 后缀会直接让命名不合规）。
  if (item.batchSize > 1 && !cfg.naming.tokens?.name && !/\{(index|variant|seed)\}/.test(ruleset?.pattern || '')) {
    tokens.name = `${tokens.name}${index + 1}`;
  }

  let fileName = ruleset ? buildName(ruleset, tokens) : `${tokens.name}_${tokens.w}x${tokens.h}_${tokens.index}.${ext}`;
  if (!/\.[a-z0-9]+$/i.test(fileName)) fileName = `${fileName}.${ext}`;
  if (fileName.includes('{')) {
    // 模板里存在未提供的 token，退化为安全命名，避免产生 {} 文件
    fileName = `${tokens.name}_${tokens.w}x${tokens.h}_${tokens.index}.${ext}`;
  }
  fileName = sanitizeFilename(fileName);

  // 兜底去重：仍然冲突时改变 {name} 而不是在扩展名前塞 `-n`，从而始终守住命名规范
  let dest = path.join(outDir, fileName);
  if (fs.existsSync(dest) && ruleset) {
    for (let n = 2; n < 200; n += 1) {
      const alt = sanitizeFilename(buildName(ruleset, { ...tokens, name: `${tokens.name}${n}` }));
      const altPath = path.join(outDir, alt);
      if (!fs.existsSync(altPath)) {
        fileName = alt;
        dest = altPath;
        break;
      }
    }
  }
  if (fs.existsSync(dest)) {
    fileName = uniquePath(outDir, fileName).split(path.sep).pop();
    dest = path.join(outDir, fileName);
  }
  fs.writeFileSync(dest, buf);

  return {
    file: path.basename(dest),
    relPath: path.relative(outDir, dest).split(path.sep).join('/'),
    path: dest,
    bytes: buf.length,
    width: meta.width,
    height: meta.height,
    seed: img.seed ?? null,
    mime: img.mime,
  };
}

function uniquePath(dir, name) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}-${i}${ext}`;
    i += 1;
  }
  return path.join(dir, candidate);
}
