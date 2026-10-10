/**
 * 输入源解析。
 *
 * 工具集里的每一步都要能消费上一步的产物，因此统一定义三种输入源：
 *   upload    —— 本次请求上传的文件（multipart）
 *   job       —— 指定历史任务的产物（artifact）
 *   workspace —— 工作区目录下的已落盘资产（按子目录/扩展名筛选）
 *
 * 这样「生成 → 转格式 → 质检 → 打包」可以串成一条链，也可以各自独立使用。
 */

import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import { jobStore } from '../core/store.js';
import { absPath } from '../core/config.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.tiff', '.tif', '.gif', '.bmp']);

export function isImage(file) {
  return IMAGE_EXT.has(path.extname(file).toLowerCase());
}

/**
 * @param {object} ctx 请求上下文
 * @param {object} spec { source, jobIds, subdir, extensions, max, filter }
 * @returns {{files: Array<{path,relPath}>, origin:string, warnings:string[]}}
 */
export function resolveInputFiles(ctx, spec = {}) {
  const source = spec.source || 'upload';
  const warnings = [];
  const max = Number(spec.max || 500);

  if (source === 'upload') {
    const files = (ctx.body?.kind === 'multipart' ? ctx.body.data.files : []).filter((f) => isImage(f.path));
    if (!files.length) {
      throw new AppError('E_VALIDATION_MISSING_FIELD', '未收到有效的图像文件（仅支持 png/jpg/webp/avif/tiff/gif/bmp）', { field: 'files' });
    }
    if (files.length > max) throw new AppError('E_LIMIT_BATCH_TOO_LARGE', `上传文件数 ${files.length} 超过单批上限 ${max}`);
    return { files: files.map((f) => ({ path: f.path, relPath: f.filename })), origin: 'upload', warnings };
  }

  if (source === 'job') {
    const ids = Array.isArray(spec.jobIds) ? spec.jobIds : [spec.jobIds].filter(Boolean);
    if (!ids.length) throw new AppError('E_VALIDATION_MISSING_FIELD', '使用任务产物作为输入时必须提供 jobIds', { field: 'jobIds' });
    const files = [];
    for (const id of ids) {
      const job = jobStore.get(id);
      const arts = (job.artifacts || []).filter((a) => a.path && fs.existsSync(a.path));
      if (!arts.length) warnings.push(`任务 ${id} 没有可用的图像产物`);
      for (const a of arts) files.push({ path: a.path, relPath: a.relPath || path.basename(a.path), source: a.providerId || job.kind });
    }
    if (!files.length) throw new AppError('E_ASSET_NOT_FOUND', '所选任务没有可用的图像产物');
    return { files: files.slice(0, max), relPath: '', origin: `job:${ids.join(',')}`, warnings };
  }

  if (source === 'workspace') {
    const subdir = spec.subdir || 'outputs';
    const dir = absPath(subdir);
    if (!fs.existsSync(dir)) throw new AppError('E_NOT_FOUND', `工作区目录不存在：${subdir}`);
    const collected = [];
    walk(dir, dir, collected);
    let files = collected.filter((f) => isImage(f.abs)).map((f) => ({ path: f.abs, relPath: f.rel }));
    if (spec.extensions?.length) {
      const exts = new Set(spec.extensions.map((e) => `.${String(e).replace(/^\./, '').toLowerCase()}`));
      files = files.filter((f) => exts.has(path.extname(f.path).toLowerCase()));
    }
    if (spec.keyword) {
      const kw = String(spec.keyword).toLowerCase();
      files = files.filter((f) => f.relPath.toLowerCase().includes(kw));
    }
    if (spec.since) {
      const t = new Date(spec.since).getTime();
      files = files.filter((f) => fs.statSync(f.path).mtimeMs >= t);
    }
    if (!files.length) throw new AppError('E_ASSET_NOT_FOUND', `工作区 ${subdir} 下没有匹配的图像资产`, { details: { subdir } });
    if (files.length > max) {
      warnings.push(`匹配到 ${files.length} 个文件，已按上限截取前 ${max} 个`);
      files = files.slice(0, max);
    }
    return { files, origin: `workspace:${subdir}`, warnings };
  }

  throw new AppError('E_VALIDATION_OUT_OF_RANGE', `未知输入源：${source}`, { field: 'source', details: { supported: ['upload', 'job', 'workspace'] } });
}

function walk(root, dir, out, depth = 0) {
  if (depth > 6) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      walk(root, abs, out, depth + 1);
    } else {
      out.push({ abs, rel: path.relative(root, abs).split(path.sep).join('/') });
    }
  }
}

/** 解析「从上传表单里带过来的 JSON 配置」。 */
export function pickPayload(ctx, defaults = {}) {
  const body = ctx.body || {};
  if (body.kind === 'multipart') {
    const p = body.data.fields?.payload;
    return { ...defaults, ...(typeof p === 'object' && p ? p : {}) };
  }
  if (body.kind === 'json') {
    const { source, jobIds, subdir, keyword, files, ...rest } = body.data || {};
    // 客户端既可以直接给扁平字段（source/subdir/…），也可以给显式的 inputSpec 对象；后者优先级更高
    return { ...defaults, ...rest, inputSpec: rest.inputSpec || { source, jobIds, subdir, keyword } };
  }
  return { ...defaults };
}
