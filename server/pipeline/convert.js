/**
 * 格式转换流水线。
 *
 * 覆盖美术流水线里 90% 的转换诉求：
 *  - 目标格式：png / jpg / webp / avif / tiff（含各格式的编码参数）
 *  - 尺寸：等比缩放 / 裁剪填充 / 最长边约束 / 倍率多档（@1x @2x @3x）
 *  - 通道：透明图转 JPG 时自动铺底色，避免出现黑底
 *  - 元数据：剥离 EXIF（默认，减小体积并规避隐私）或保留
 *  - 输出命名：走命名规范引擎，保证转换后依然合规
 *
 * 每个文件独立事务：失败不影响其他文件，最终返回逐项结果 + 聚合摘要。
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { AppError } from '../core/errors.js';
import { buildName, getPreset, validateFilename } from './naming.js';
import { humanBytes, sanitizeFilename } from '../util/misc.js';

export const CONVERT_DEFAULTS = {
  format: 'webp',
  quality: 85,
  lossless: false,
  effort: 4,
  resize: { mode: 'none', width: null, height: null, maxEdge: null, scale: 1, fit: 'inside' },
  variants: [],
  background: '#ffffff',
  flattenAlpha: true,
  stripMetadata: true,
  namingPreset: 'game-ui',
  customNamingRules: null,
  nameTokenOverrides: {},
  outputSubdir: '',
  keepRelativePath: false,
};

const FORMAT_ENCODERS = {
  png: (pipeline, o) => pipeline.png({ compressionLevel: clampLevel(o.effort, 0, 9), palette: Boolean(o.palette), quality: o.quality }),
  jpg: (pipeline, o) => pipeline.jpeg({ quality: clampLevel(o.quality, 1, 100), mozjpeg: true, progressive: true }),
  jpeg: (pipeline, o) => pipeline.jpeg({ quality: clampLevel(o.quality, 1, 100), mozjpeg: true, progressive: true }),
  webp: (pipeline, o) => pipeline.webp({ quality: clampLevel(o.quality, 1, 100), lossless: Boolean(o.lossless), effort: clampLevel(o.effort, 0, 6) }),
  avif: (pipeline, o) => pipeline.avif({ quality: clampLevel(o.quality, 1, 100), lossless: Boolean(o.lossless), effort: clampLevel(o.effort, 0, 9) }),
  tiff: (pipeline, o) => pipeline.tiff({ quality: clampLevel(o.quality, 1, 100), compression: 'lzw' }),
};

const ALPHA_LESS = new Set(['jpg', 'jpeg']);

export function resolveOptions(input = {}) {
  const o = { ...CONVERT_DEFAULTS, ...input, resize: { ...CONVERT_DEFAULTS.resize, ...(input.resize || {}) } };
  const fmt = String(o.format || 'webp').toLowerCase().replace('jpeg', 'jpg');
  if (!FORMAT_ENCODERS[fmt]) {
    throw new AppError('E_FORMAT_UNSUPPORTED', `不支持输出格式 .${fmt}`, { details: { supported: Object.keys(FORMAT_ENCODERS) } });
  }
  o.format = fmt;
  return o;
}

/** 计算目标尺寸。返回 [{suffix, scale, width, height}]。 */
function planTargets(meta, o) {
  const { resize, variants, format } = o;
  const targets = [];
  const variantList = variants?.length ? variants : [{ suffix: '', scale: resize.scale || 1 }];

  for (const v of variantList) {
    const scale = Number(v.scale || 1);
    let w = Math.round(meta.width * scale);
    let h = Math.round(meta.height * scale);

    if (resize.mode === 'exact' && resize.width && resize.height) {
      w = Math.round(resize.width * scale);
      h = Math.round(resize.height * scale);
    } else if (resize.mode === 'maxEdge' && resize.maxEdge) {
      const cap = resize.maxEdge * scale;
      const longest = Math.max(w, h);
      if (longest > cap) {
        const k = cap / longest;
        w = Math.round(w * k);
        h = Math.round(h * k);
      }
    } else if (resize.mode === 'box' && resize.width && resize.height) {
      // 在给定盒子内等比缩放（fit: inside），不会放大
      const k = Math.min(resize.width / meta.width, resize.height / meta.height, 1) * scale;
      w = Math.round(meta.width * k);
      h = Math.round(meta.height * k);
    }

    w = Math.max(1, w);
    h = Math.max(1, h);
    targets.push({ suffix: v.suffix ?? '', scale, width: w, height: h, fit: resizeModeToFit(resize.mode, v.fit) });
  }
  void format;
  return dedupeTargets(targets);
}

function resizeModeToFit(mode, override) {
  if (override) return override;
  if (mode === 'exact') return 'fill';
  if (mode === 'crop') return 'cover';
  return 'inside';
}

function dedupeTargets(targets) {
  const seen = new Set();
  return targets.filter((t) => {
    const key = `${t.width}x${t.height}${t.suffix}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 转换单个文件 -> 多个变体。 */
export async function convertAsset(srcPath, outDir, options, ctx = {}) {
  const o = resolveOptions(options);
  const fileName = path.basename(srcPath);
  const outputs = [];

  let meta;
  try {
    meta = await sharp(srcPath).metadata();
  } catch (err) {
    throw new AppError('E_FORMAT_DECODE_FAILED', `${fileName} 解码失败：${err.message}`, { cause: err });
  }
  if (!meta.width || !meta.height) throw new AppError('E_FORMAT_DECODE_FAILED', `${fileName} 缺少尺寸信息`);

  const ruleset = o.customNamingRules || getPreset(o.namingPreset);
  const targets = planTargets(meta, o);
  const ext = o.format === 'jpg' ? 'jpg' : o.format;
  const src = ruleset ? validateFilename(fileName, ruleset) : null;
  // 转换不应该改变资产的语义：先把源文件名里能解析出来的 token 全部继承下来，
  // 再用尺寸/格式/变体覆盖掉「这次转换真正改变了」的那几个。
  const inherited = { ...(src?.tokens || {}), ...o.nameTokenOverrides };
  fs.mkdirSync(outDir, { recursive: true });

  for (const target of targets) {
    if (ctx.signal?.aborted) throw new AppError('E_PIPELINE_ABORTED', '任务已被取消');

    const stem = fileName.replace(/\.[^.]+$/, '');
    const outName = ruleset
      ? buildName(ruleset, completeTokens(ruleset, {
          ...inherited,
          name: o.nameTokenOverrides?.name || deriveNameToken(fileName, ruleset, src),
          state: variantWord(target, src),
          w: target.width,
          h: target.height,
          ext,
        }))
      : `${sanitizeFilename(stem + target.suffix)}.${ext}`;
    const safeName = sanitizeFilename(outName);
    const dest = uniqueInDir(outDir, safeName);

    let pipeline = sharp(srcPath, { animated: false }).rotate();

    if (target.width !== meta.width || target.height !== meta.height) {
      pipeline = pipeline.resize(target.width, target.height, {
        fit: target.fit,
        withoutEnlargement: target.fit === 'inside',
        background: o.background,
        kernel: 'lanczos3',
      });
    }

    if (ALPHA_LESS.has(ext) && o.flattenAlpha) {
      pipeline = pipeline.flatten({ background: o.background });
    }

    // sharp 默认即剥离元数据；仅当显式要求保留时才 withMetadata
    if (!o.stripMetadata) pipeline = pipeline.withMetadata();
    const encode = FORMAT_ENCODERS[ext];
    if (!encode) throw new AppError('E_FORMAT_UNSUPPORTED', `不支持输出格式 .${ext}`);

    let buffer;
    try {
      buffer = await encode(pipeline, o).toBuffer();
    } catch (err) {
      throw new AppError('E_FORMAT_ENCODE_FAILED', `${fileName} 编码为 ${ext} 失败：${err.message}`, { cause: err });
    }

    fs.writeFileSync(dest, buffer);
    const outMeta = await sharp(buffer).metadata().catch(() => ({}));
    outputs.push({
      variant: target.suffix || 'base',
      scale: target.scale,
      file: safeName,
      path: dest,
      relPath: path.relative(outDir, dest).split(path.sep).join('/'),
      format: ext,
      width: outMeta.width || target.width,
      height: outMeta.height || target.height,
      bytes: buffer.length,
      bytesText: humanBytes(buffer.length),
      hasAlpha: Boolean(outMeta.hasAlpha),
      ratio: meta.width ? +((buffer.length / fs.statSync(srcPath).size) || 0).toFixed(3) : null,
    });
    ctx.onOutput?.(outputs[outputs.length - 1]);
  }

  return {
    source: fileName,
    sourcePath: srcPath,
    sourceFormat: meta.format,
    sourceSize: `${meta.width}x${meta.height}`,
    sourceBytes: fs.statSync(srcPath).size,
    outputs,
  };
}

function uniqueInDir(dir, name) {
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

/**
 * 推导 {name} token：
 *  1) 原文件名已合规 → 直接复用它的 name 段（转换不应改变资产的语义名）；
 *  2) 否则从分隔符切分后挑一个像「词」的片段（跳过尺寸段、状态段）；
 *  3) 都不行则退化为纯字母数字的兜底名。
 */
function deriveNameToken(fileName, ruleset, validated) {
  if (validated?.valid && validated.tokens?.name) return validated.tokens.name;
  const parts = fileName
    .replace(/\.[^.]+$/, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const isSize = (p) => /^\d+x\d+$/.test(p) || /^\d{2,5}$/.test(p);
  const states = new Set(['normal', 'hover', 'active', 'disabled', 'pressed', 'selected', 'default', 'focus']);
  const cand = parts.find((p, i) => i > 0 && p.length >= 2 && p.length <= 24 && !isSize(p) && !states.has(p) && /[a-z]/.test(p));
  if (cand) return cand.slice(0, 24);
  const fallback = parts.find((p) => p.length >= 2 && /[a-z]/.test(p) && !isSize(p));
  return (fallback || 'asset').slice(0, 24);
}

const SCALE_WORDS = { 1: 'normal', 2: 'double', 3: 'triple', 4: 'quad', 8: 'octa' };

/** 模板里出现但推不出来的必填 token，用中性占位值补齐，保证结构完整（哨兵值会被质检标记为需人工确认）。 */
const TOKEN_FALLBACKS = {
  category: 'misc', state: 'normal', variant: 'v1', view: 'front', skin: 'base',
  channel: 'web', campaign: 'campaign', version: 'v1', character: 'char',
};

function completeTokens(ruleset, tokens) {
  const needed = [...String(ruleset.pattern).matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((m) => m[1]);
  const out = { ...tokens };
  for (const token of needed) {
    const v = out[token];
    if (v !== undefined && v !== null && v !== '') continue;
    out[token] = TOKEN_FALLBACKS[token] || token.replace(/[^a-z0-9]/g, '').slice(0, 12) || 'x';
  }
  return out;
}

/**
 * 推导 {state} token（同时也是「变体」槽位）。
 * 规则里 state 的字符类是「2-12 个小写字母」，所以带数字的后缀（如 `1x`）不能直接落进去，
 * 需要映射成词；映射不出来时沿用原状态 —— 尺寸 token 本身已保证不同变体不会重名。
 */
function variantWord(target, validated) {
  const letters = String(target.suffix || '').replace(/[^a-zA-Z]/g, '').toLowerCase();
  if (letters.length >= 2 && letters.length <= 12) return letters;
  const sourceState = validated?.tokens?.state;
  if (target.scale === 1) return sourceState && /^[a-z]{2,12}$/.test(sourceState) ? sourceState : 'normal';
  if (target.scale < 1) return 'half';
  return SCALE_WORDS[target.scale] || (sourceState && /^[a-z]{2,12}$/.test(sourceState) ? sourceState : 'normal');
}

/**
 * 批量转换。
 * @param {Array<{path:string, relPath?:string}>} files
 */
export async function convertAssets(files, outDir, options, ctx = {}) {
  const results = [];
  const t0 = Date.now();
  const total = files.length;

  for (let i = 0; i < total; i += 1) {
    const file = files[i];
    try {
      const r = await convertAsset(file.path, outDir, options, ctx);
      results.push({ status: 'success', ...r });
    } catch (err) {
      const appErr = err instanceof AppError ? err : new AppError('E_PIPELINE_STEP_FAILED', err.message);
      results.push({
        status: 'failed',
        source: path.basename(file.path),
        sourcePath: file.path,
        code: appErr.code,
        message: appErr.message,
        outputs: [],
      });
      ctx.onLog?.('error', `转换失败 ${path.basename(file.path)}：${appErr.message}`);
    }
    ctx.onProgress?.(Math.round(((i + 1) / total) * 100), `转换中 ${i + 1}/${total}`);
  }

  const succeeded = results.filter((r) => r.status === 'success');
  const failed = results.filter((r) => r.status === 'failed');
  const outputs = succeeded.flatMap((r) => r.outputs);
  const inputBytes = succeeded.reduce((s, r) => s + r.sourceBytes, 0) + failed.length * 0;
  const outputBytes = outputs.reduce((s, o) => s + o.bytes, 0);

  return {
    results,
    outputs,
    counts: { total, succeeded: succeeded.length, failed: failed.length, skipped: 0, outputs: outputs.length },
    savings: {
      inputBytes,
      outputBytes,
      savedBytes: Math.max(0, inputBytes - outputBytes),
      ratio: inputBytes ? +(((inputBytes - outputBytes) / inputBytes) * 100).toFixed(1) : 0,
      inputBytesText: humanBytes(inputBytes),
      outputBytesText: humanBytes(outputBytes),
    },
    durationMs: Date.now() - t0,
    format: options.format,
  };
}

function clampLevel(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export { planTargets };
