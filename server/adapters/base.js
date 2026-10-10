/**
 * 提供方适配器基类 —— 统一「请求归一化 / 响应归一化 / 错误归一化」三件事。
 *
 * 外部 AI 绘图工具的接口差异极大（同步返回 base64 / 异步返回 taskId 轮询 / WebSocket 推送），
 * 因此在适配层把差异吃掉，向上层暴露恒定契约：
 *
 *   buildPayload(req) -> provider 原生请求体
 *   submit(payload, ctx) -> { remoteTaskId?, images?: RawImage[], raw }
 *   poll(remoteTaskId, ctx) -> { state:'pending'|'running'|'succeeded'|'failed', progress?, images?, error? }
 *   fetchResult(image, ctx) -> Buffer
 *
 * 统一入参 GenerateRequest（归一化后）：
 *   { prompt, negativePrompt, width, height, steps, cfgScale, seed, batchSize,
 *     sampler, model, stylePreset, referenceImage?, extra? }
 *
 * 统一出参 NormalizedImage：
 *   { data:Buffer, mime, width, height, seed?, remoteUrl?, meta }
 */

import { AppError } from '../core/errors.js';
import { resolveSecret } from '../core/config.js';
import { request as httpRequest, defaultClassify, downloadToFile } from '../core/httpclient.js';
import { logger } from '../core/logger.js';

export class BaseAdapter {
  /**
   * @param {string} id 提供方 ID（与配置项 providers.definitions 的 key 一致）
   * @param {object} def 提供方配置
   */
  constructor(id, def) {
    this.id = id;
    this.def = def;
    this.label = def.label || id;
    this.kind = def.kind || id;
    this.baseUrl = (def.baseUrl || '').replace(/\/$/, '');
    this.timeoutMs = def.timeoutMs || 60000;
    this.models = def.models || [];
    this.defaults = def.defaults || {};
  }

  get apiKey() {
    return resolveSecret(this.def.apiKey);
  }

  /** 声明能力，供前端做参数联动（例如是否支持 negative prompt / 参考图）。 */
  get capabilities() {
    return {
      text2img: true,
      img2img: false,
      negativePrompt: true,
      seedControl: true,
      batchNative: true,
      async: false,
      maxBatchSize: 8,
      supportedSizes: [],
      supportedModels: this.models,
    };
  }

  get configured() {
    return this.def.enabled !== false;
  }

  /** 统一的参数校验与归一化：所有适配器共享，保证入参语义一致。 */
  normalizeRequest(req = {}) {
    const d = this.defaults;
    const pick = (a, b) => (a === undefined || a === null || a === '' ? b : a);
    const width = clampInt(pick(req.width, d.width ?? 1024), 64, 4096);
    const height = clampInt(pick(req.height, d.height ?? 1024), 64, 4096);
    const prompt = String(pick(req.prompt, '')).trim();
    if (!prompt) throw new AppError('E_VALIDATION_MISSING_FIELD', '提示词 prompt 不能为空', { field: 'prompt' });
    if (prompt.length > 2000) throw new AppError('E_VALIDATION_OUT_OF_RANGE', '提示词长度超过 2000 字符', { field: 'prompt' });

    return {
      prompt,
      negativePrompt: String(pick(req.negativePrompt, d.negativePrompt ?? '')).trim(),
      width,
      height,
      steps: clampInt(pick(req.steps, d.steps ?? 24), 1, 150),
      cfgScale: clampFloat(pick(req.cfgScale, d.cfgScale ?? 7), 0, 30),
      seed: pick(req.seed, -1) === -1 || pick(req.seed, -1) === '' ? -1 : clampInt(pick(req.seed, -1), 0, 2 ** 31 - 1),
      batchSize: clampInt(pick(req.batchSize, 1), 1, 8),
      sampler: String(pick(req.sampler, d.sampler ?? 'DPM++ 2M Karras')),
      model: String(pick(req.model, d.model ?? this.models[0] ?? 'default')),
      stylePreset: String(pick(req.stylePreset, d.stylePreset ?? 'none')),
      referenceImage: req.referenceImage || null,
      extra: req.extra || {},
    };
  }

  /** 子类实现。默认不支持异步任务模式。 */
  buildPayload(req) {
    throw new AppError('E_SYS_NOT_IMPLEMENTED', `${this.label} 未实现 buildPayload`);
  }

  async submit() {
    throw new AppError('E_SYS_NOT_IMPLEMENTED', `${this.label} 未实现 submit`);
  }

  async poll() {
    throw new AppError('E_SYS_NOT_IMPLEMENTED', `${this.label} 未实现 poll`);
  }

  async fetchResult(image) {
    if (image.data) return image.data;
    if (!image.remoteUrl) throw new AppError('E_PROVIDER_BAD_RESPONSE', '产物既无内联数据也无下载地址');
    return this.downloadRaw(image.remoteUrl);
  }

  /** 下载远端二进制产物到临时文件再读回，避免大图长驻内存。 */
  async downloadRaw(url) {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiart-'));
    const dest = path.join(dir, 'raw.bin');
    try {
      await downloadToFile(url, dest, { timeoutMs: this.timeoutMs, headers: this.authHeaders() });
      return fs.readFileSync(dest);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  authHeaders() {
    const key = this.apiKey;
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  /** 统一的 HTTP 调用入口，自动带鉴权、超时、重试与错误映射。 */
  async callApi(pathname, { method = 'POST', body, headers = {}, maxRetries = 2, signal, raw = false } = {}) {
    const url = pathname.startsWith('http') ? pathname : `${this.baseUrl}${pathname}`;
    const res = await httpRequest(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...this.authHeaders(),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs: this.timeoutMs,
      maxRetries,
      signal,
      parse: raw ? 'none' : 'json',
      label: this.label,
      baseBackoffMs: 1000,
      classify: defaultClassify(this.label),
    });
    return res.body;
  }

  /** 健康检查：返回 { ok, latencyMs, detail, models? }，永不抛异常（前端要能画状态灯）。 */
  async healthCheck() {
    const t0 = Date.now();
    try {
      if (!this.configured) return { ok: false, latencyMs: 0, detail: '该提供方已在配置中禁用' };
      if (this.requiresKey && !this.apiKey) {
        return { ok: false, latencyMs: 0, detail: '缺少 API Key（可通过环境变量注入）' };
      }
      if (this.requiresKey && this.baseUrl) {
        const reach = await this.ping(this.baseUrl);
        if (reach.status === 401 || reach.status === 403) {
          return { ok: false, latencyMs: Date.now() - t0, detail: '鉴权失败：API Key 无效', code: 'E_PROVIDER_AUTH' };
        }
        return { ok: true, latencyMs: Date.now() - t0, detail: `网络可达（HTTP ${reach.status}）`, models: this.models };
      }
      await this.probe();
      return { ok: true, latencyMs: Date.now() - t0, detail: '连通正常', models: this.models };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        detail: err?.message || '探测失败',
        code: err?.code || 'E_PROVIDER_UNAVAILABLE',
      };
    }
  }

  /** 轻量连通性探测：任何 HTTP 响应都算「网络可达」，只有网络层失败才抛错。 */
  async ping(url) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...this.authHeaders() },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 10000)),
      });
      return { status: res.status };
    } catch (err) {
      throw new AppError('E_PROVIDER_UNAVAILABLE', `${this.label} 网络不可达：${err?.message || 'unknown'}`, { cause: err });
    }
  }

  async probe() {
    /* 默认无探测端点，子类覆盖 */
  }

  get requiresKey() {
    return false;
  }

  describe() {
    return {
      id: this.id,
      label: this.label,
      kind: this.kind,
      baseUrl: this.baseUrl,
      enabled: this.def.enabled !== false,
      configured: Boolean(this.baseUrl || this.kind === 'mock') && (!this.requiresKey || Boolean(this.apiKey)),
      requiresKey: this.requiresKey,
      hasKey: Boolean(this.apiKey),
      timeoutMs: this.timeoutMs,
      maxConcurrency: this.def.maxConcurrency || 2,
      models: this.models,
      defaults: this.defaults,
      capabilities: this.capabilities,
    };
  }
}

function clampInt(v, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
function clampFloat(v, min, max) {
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export { clampInt, clampFloat };
