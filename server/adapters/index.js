/**
 * 提供方注册中心。
 *
 * 职责：
 *  1. 按配置实例化适配器，向上层屏蔽「用哪个实现」；
 *  2. 提供统一调用入口 `generate()`，内部处理「同步 / 异步轮询」两种范式的差异，
 *     并统一组装 NormalizedImage[]；
 *  3. 提供能力矩阵与健康检查聚合，供前端渲染状态灯与参数联动。
 *
 * 上层流水线只需调用 providers.generate(providerId, request, ctx)，不感知协议差异。
 */

import { getConfig } from '../core/config.js';
import { AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { sleep } from '../core/httpclient.js';
import { MockAdapter } from './mock.js';
import { SdWebUiAdapter } from './sdwebui.js';
import { ComfyUiAdapter } from './comfyui.js';
import { OpenAiImagesAdapter } from './openai.js';
import { DashScopeAdapter } from './dashscope.js';
import { VolcengineAdapter } from './volcengine.js';

const REGISTRY = {
  mock: MockAdapter,
  sdwebui: SdWebUiAdapter,
  comfyui: ComfyUiAdapter,
  openai: OpenAiImagesAdapter,
  dashscope: DashScopeAdapter,
  volcengine: VolcengineAdapter,
};

class ProviderService {
  constructor() {
    this.adapters = new Map();
  }

  /** 按当前配置重建适配器实例（配置热更新后调用）。 */
  sync() {
    const defs = getConfig().providers.definitions;
    const seen = new Set();
    for (const [id, def] of Object.entries(defs)) {
      const Ctor = REGISTRY[def.kind] || REGISTRY.mock;
      const next = new Ctor(id, def);
      const existing = this.adapters.get(id);
      // 复用实例可以让 MCP/SDK 连接池等资源不被打断
      if (existing && existing.kind === next.kind) {
        existing.def = def;
        existing.baseUrl = next.baseUrl;
        existing.timeoutMs = next.timeoutMs;
        existing.models = next.models;
        existing.defaults = next.defaults;
      } else {
        this.adapters.set(id, next);
      }
      seen.add(id);
    }
    for (const id of [...this.adapters.keys()]) if (!seen.has(id)) this.adapters.delete(id);
    return this;
  }

  get(id) {
    if (!this.adapters.size) this.sync();
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new AppError('E_PROVIDER_NOT_FOUND', `提供方「${id}」未注册`, {
        details: { available: [...this.adapters.keys()] },
      });
    }
    return adapter;
  }

  get activeId() {
    return getConfig().providers.active;
  }

  list() {
    if (!this.adapters.size) this.sync();
    return [...this.adapters.values()].map((a) => a.describe());
  }

  async healthAll() {
    const adapters = [...(this.adapters.size ? this.adapters.values() : this.sync().adapters.values())];
    const results = await Promise.all(
      adapters.map(async (a) => ({ id: a.id, label: a.label, kind: a.kind, enabled: a.def.enabled !== false, ...(await a.healthCheck()) }))
    );
    return results;
  }

  /**
   * 统一生成入口。
   * @param {string} providerId
   * @param {object} request 统一 GenerateRequest
   * @param {{signal?:AbortSignal, onProgress?:Function, onLog?:Function}} ctx
   * @returns {Promise<{images:Array, attempts:number, raw:any}>}
   */
  async generate(providerId, request, ctx = {}) {
    const adapter = this.get(providerId);
    if (adapter.def.enabled === false) {
      throw new AppError('E_PROVIDER_NOT_CONFIGURED', `提供方「${adapter.label}」已禁用，请先在提供方配置中启用`, {
        details: { providerId },
      });
    }

    const req = adapter.normalizeRequest(request);
    const payload = adapter.buildPayload(req);
    const t0 = Date.now();
    logger.info('provider.generate.start', { providerId, model: req.model, size: `${req.width}x${req.height}`, batch: req.batchSize });

    const submitted = await adapter.submit(payload, {
      ...ctx,
      onStep: (done, total) => ctx.onProgress?.((done / total) * 0.95),
    });

    let images = submitted.images || [];
    let raw = submitted.raw ?? null;
    let attempts = 1;

    if (!images.length && submitted.remoteTaskId) {
      images = await this._awaitAsync(adapter, submitted.remoteTaskId, ctx);
      attempts = images.__attempts || 1;
    }

    if (!images.length) throw new AppError('E_PROVIDER_BAD_RESPONSE', `${adapter.label} 未产出任何图像`);

    logger.info('provider.generate.done', { providerId, count: images.length, ms: Date.now() - t0 });
    return { images: images.map(stripInternals), attempts, raw };
  }

  /** 异步提供方的统一轮询器：带总超时、进度回调与取消响应。 */
  async _awaitAsync(adapter, remoteTaskId, ctx = {}) {
    const deadline = Date.now() + adapter.timeoutMs;
    const interval = 1200;
    let lastProgress = 5;
    let attempts = 0;

    while (Date.now() < deadline) {
      if (ctx.signal?.aborted) throw new AppError('E_PIPELINE_ABORTED', '任务已被取消');
      attempts += 1;
      const state = await adapter.poll(remoteTaskId, { ...ctx, lastProgress });

      if (state.state === 'failed') throw state.error instanceof AppError ? state.error : new AppError('E_PIPELINE_STEP_FAILED', String(state.error));
      if (state.state === 'succeeded') {
        const imgs = state.images || [];
        imgs.__attempts = attempts;
        ctx.onProgress?.(99, '拉取产物');
        return imgs;
      }
      lastProgress = Math.max(lastProgress, state.progress ?? lastProgress);
      ctx.onProgress?.(Math.max(5, Math.min(90, lastProgress)), '生成中');
      await sleep(interval);
    }
    throw new AppError('E_PROVIDER_TIMEOUT', `${adapter.label} 任务 ${remoteTaskId} 轮询超时（${adapter.timeoutMs}ms）`);
  }
}

function stripInternals(img) {
  const { ...rest } = img;
  delete rest.__attempts;
  return rest;
}

export const providers = new ProviderService();
