/**
 * 系统与提供方管理接口。
 *
 * 设计原则：控制台需要的一切「元信息」都由服务端自描述返回，
 * 前端不硬编码任何枚举（错误码、命名规范、提供方能力、转换选项），
 * 新增一个提供方或规范集无需改前端。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfig, redactConfig, updateConfig, absPath, ROOT } from '../core/config.js';
import { ERROR_CODES } from '../core/errors.js';
import { providers } from '../adapters/index.js';
import { jobStore } from '../core/store.js';
import { jobQueue } from '../core/queue.js';
import { listPresets, PRESETS } from '../pipeline/naming.js';
import { humanBytes } from '../util/misc.js';
import { DEFAULT_RULES } from '../pipeline/inspect.js';
import { AppError } from '../core/errors.js';

export function registerSystemRoutes(router) {
  router.get('/api/system/health', async () => {
    const providerHealth = await providers.healthAll();
    const stats = jobStore.stats();
    return {
      status: 'ok',
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      memory: {
        rss: humanBytes(process.memoryUsage().rss),
        heapUsed: humanBytes(process.memoryUsage().heapUsed),
      },
      queue: jobQueue.snapshot(),
      jobs: stats,
      providers: providerHealth.map((p) => ({ id: p.id, label: p.label, enabled: p.enabled, ok: p.ok, latencyMs: p.latencyMs, detail: p.detail })),
      activeProvider: providers.activeId,
      checkedAt: new Date().toISOString(),
    };
  });

  /** 自描述元信息：前端启动时拉一次即可渲染出全部表单控件。 */
  router.get('/api/system/meta', async () => {
    const cfg = getConfig();
    return {
      version: '1.0.0',
      product: 'AI Art Studio',
      errorCodes: Object.entries(ERROR_CODES).map(([code, m]) => ({ code, ...m })),
      namingPresets: listPresets(),
      namingPresetsFull: Object.values(PRESETS),
      providers: providers.list(),
      activeProvider: providers.activeId,
      convert: {
        formats: Object.keys({ png: 1, jpg: 1, webp: 1, avif: 1, tiff: 1 }),
        resizeModes: [
          { id: 'none', label: '保持原始尺寸' },
          { id: 'maxEdge', label: '限制最长边' },
          { id: 'box', label: '限制在尺寸盒内（可缩放倍率）' },
          { id: 'exact', label: '精确尺寸（拉伸/裁剪）' },
          { id: 'crop', label: '裁剪填充到目标尺寸' },
        ],
        variantModes: [
          { id: 'scale', label: '倍率多档' },
          { id: 'fixed', label: '固定尺寸' },
        ],
      },
      inspect: { defaults: DEFAULT_RULES, alphaPolicies: ['any', 'require', 'forbid'] },
      queue: cfg.queue,
      limits: {
        bodyLimitMB: cfg.server.bodyLimitMB,
        maxBatchItems: 200,
        maxUploadFiles: 500,
      },
      paths: Object.fromEntries(Object.entries(cfg.paths).map(([k, v]) => [k, v])),
    };
  });

  router.get('/api/system/routes', async (ctx) => ({ routes: router.describe(), servedFrom: ctx.url.pathname }));

  /** 工作区浏览：控制台「资产库」页用它列出已落盘的产物。 */
  router.get('/api/workspace/tree', async (ctx) => {
    const subdir = ctx.query.subdir || 'outputs';
    const dir = absPath(subdir);
    if (!fs.existsSync(dir)) return { subdir, dir, entries: [], total: 0, totalBytes: 0 };
    const entries = [];
    walk(dir, dir, entries);
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return {
      subdir,
      entries: entries.slice(0, Number(ctx.query.limit || 200)),
      total: entries.length,
      totalBytes: entries.reduce((s, e) => s + e.bytes, 0),
      totalBytesText: humanBytes(entries.reduce((s, e) => s + e.bytes, 0)),
    };
  });

  /** 资产缩略图/原图预览：控制台直接内联显示，避免 base64 塞进 JSON。 */
  router.get('/api/workspace/file', async (ctx) => {
    const rel = ctx.query.path;
    if (!rel) throw new AppError('E_VALIDATION_MISSING_FIELD', '缺少 path 参数', { field: 'path' });
    const resolved = path.resolve(absPath(rel));
    const allowedRoots = ['outputs', 'packages', 'uploads'].map((k) => path.resolve(absPath(k)));
    if (!allowedRoots.some((root) => resolved.startsWith(root))) {
      throw new AppError('E_AUTH_FORBIDDEN', '仅允许访问工作区内的产物与上传目录');
    }
    if (!fs.existsSync(resolved)) throw new AppError('E_ASSET_NOT_FOUND', `文件不存在：${rel}`);
    const { sendFileDownload, contentTypeFor } = await import('../core/router.js');
    const stat = fs.statSync(resolved);
    if (ctx.query.download === '1') {
      await sendFileDownload(ctx.res, resolved, path.basename(resolved));
    } else {
      ctx.res.writeHead(200, {
        'Content-Type': contentTypeFor(resolved),
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=300',
      });
      fs.createReadStream(resolved).pipe(ctx.res);
    }
    return { __raw: true, status: 200 };
  });

  router.get('/api/providers', async () => {
    const health = await providers.healthAll();
    const byId = new Map(health.map((h) => [h.id, h]));
    return {
      active: providers.activeId,
      providers: providers.list().map((p) => ({ ...p, health: byId.get(p.id) || null })),
    };
  });

  router.post('/api/providers/health', async () => ({ results: await providers.healthAll() }));

  router.post('/api/providers/test', async (ctx) => {
    const { providerId } = ctx.body?.data || {};
    if (!providerId) throw new AppError('E_VALIDATION_MISSING_FIELD', '缺少 providerId', { field: 'providerId' });
    const adapter = providers.get(providerId);
    return { providerId, ...(await adapter.healthCheck()) };
  });

  /** 更新提供方配置：支持热更新（改完立即生效，无需重启）。 */
  router.patch('/api/providers/config', async (ctx) => {
    const { providerId, patch, setActive } = ctx.body?.data || {};
    if (!providerId && !patch) throw new AppError('E_VALIDATION_MISSING_FIELD', '缺少 providerId 或 patch');
    const cfg = getConfig();
    if (!cfg.providers.definitions[providerId]) {
      throw new AppError('E_PROVIDER_NOT_FOUND', `提供方「${providerId}」不存在`);
    }
    const allowed = ['enabled', 'baseUrl', 'apiKey', 'timeoutMs', 'maxConcurrency', 'models', 'defaults', 'label'];
    const clean = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (allowed.includes(k)) clean[k] = v;
    }
    updateConfig({ providers: { definitions: { [providerId]: clean }, ...(setActive ? { active: setActive } : {}) } });
    providers.sync();

    // 配置变更后立刻做一次健康检查，把结果直接回给前端，省一次往返
    const adapter = providers.get(providerId);
    const health = await adapter.healthCheck();
    return { provider: { ...adapter.describe(), health }, active: providers.activeId, applied: Object.keys(clean) };
  });

  router.post('/api/providers/activate', async (ctx) => {
    const { providerId } = ctx.body?.data || {};
    providers.get(providerId);
    updateConfig({ providers: { active: providerId } });
    return { active: providers.activeId };
  });

  /** 命名规范试算：给出文件名与规范集，立即返回校验结果与建议名。 */
  router.post('/api/naming/validate', async (ctx) => {
    const { filenames = [], preset = 'game-ui', customRules } = ctx.body?.data || {};
    const { validateFilename, getPreset } = await import('../pipeline/naming.js');
    const ruleset = customRules || getPreset(preset);
    if (!ruleset) throw new AppError('E_NAMING_RULE_INVALID', `规范集「${preset}」不存在`);
    return {
      preset: ruleset.id,
      results: filenames.map((f) => ({ filename: f, ...validateFilename(f, ruleset) })),
    };
  });

  router.get('/api/config/raw', async () => ({ config: redactConfig() }));

  router.get('/api/config/paths', async () => ({
    root: ROOT,
    workspace: absPath(),
    uploads: absPath('uploads'),
    outputs: absPath('outputs'),
    packages: absPath('packages'),
    reports: absPath('reports'),
  }));
}

function walk(root, dir, out, depth = 0) {
  if (depth > 6) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      walk(root, abs, out, depth + 1);
    } else {
      const stat = fs.statSync(abs);
      out.push({
        relPath: path.relative(root, abs).split(path.sep).join('/'),
        name: entry.name,
        subdir: path.relative(root, dir).split(path.sep).join('/') || '.',
        bytes: stat.size,
        bytesText: humanBytes(stat.size),
        mtime: stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs,
        ext: path.extname(entry.name).toLowerCase().replace('.', ''),
      });
    }
  }
}
