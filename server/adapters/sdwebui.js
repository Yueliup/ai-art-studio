/**
 * Stable Diffusion WebUI (AUTOMATIC1111) 适配器。
 *
 * 协议特征：同步阻塞式 /sdapi/v1/txt2img，一次性返回 base64 数组。
 * 因此适配层需要：把 batchSize 映射到 batch_size，把 steps/cfg 映射到 steps/cfg_scale，
 * 并处理「base64 前缀缺失」这类常见的不一致返回。
 */

import { BaseAdapter } from './base.js';
import { AppError } from '../core/errors.js';

export class SdWebUiAdapter extends BaseAdapter {
  get requiresKey() {
    return false; // 本地部署通常不需要密钥
  }

  get capabilities() {
    return {
      text2img: true,
      img2img: true,
      negativePrompt: true,
      seedControl: true,
      batchNative: true,
      async: false,
      maxBatchSize: 8,
      supportedSizes: [],
      supportedModels: this.models,
      note: '需要以 --api 参数启动 WebUI',
    };
  }

  buildPayload(req) {
    return {
      prompt: req.prompt,
      negative_prompt: req.negativePrompt,
      width: req.width,
      height: req.height,
      steps: req.steps,
      cfg_scale: req.cfgScale,
      seed: req.seed,
      batch_size: req.batchSize,
      sampler_name: req.sampler,
      override_settings: { sd_model_checkpoint: req.model },
      override_settings_restore_afterwards: true,
      send_images: true,
      save_images: false,
    };
  }

  async submit(payload, ctx = {}) {
    const body = await this.callApi('/sdapi/v1/txt2img', { body: payload, signal: ctx.signal });
    if (!body || typeof body !== 'object') throw new AppError('E_PROVIDER_BAD_RESPONSE', 'WebUI 返回非 JSON');
    if (body.detail) throw new AppError('E_VALIDATION_FAILED', `WebUI 拒绝请求：${JSON.stringify(body.detail).slice(0, 300)}`);
    const list = Array.isArray(body.images) ? body.images : [];
    if (!list.length) throw new AppError('E_PROVIDER_BAD_RESPONSE', 'WebUI 未返回任何图像');

    const images = list.map((b64, i) => ({
      data: Buffer.from(stripDataUrl(b64), 'base64'),
      mime: 'image/png',
      seed: payload.seed >= 0 ? payload.seed + i : undefined,
      meta: { renderer: 'sd-webui', info: safeJson(body.info) },
    }));
    return { images, raw: { count: images.length, info: safeJson(body.info) } };
  }

  async probe() {
    await this.callApi('/sdapi/v1/options', { method: 'GET', maxRetries: 0 });
  }
}

function stripDataUrl(s) {
  const idx = String(s).indexOf(',');
  return idx >= 0 && String(s).startsWith('data:') ? String(s).slice(idx + 1) : String(s);
}
function safeJson(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return { text: v };
    }
  }
  return v;
}
