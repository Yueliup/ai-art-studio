/**
 * ComfyUI 适配器。
 *
 * 协议特征：异步队列模型。POST /prompt 拿到 prompt_id，再轮询 /history/{id} 取产物，
 * 产物通过 /view 接口按 {filename, subfolder, type} 下载。
 * 这是「异步提供方」的标准形态，也是适配层 poll 契约的主要验证场景。
 */

import { BaseAdapter } from './base.js';
import { AppError } from '../core/errors.js';

const WORKFLOWS = {
  'workflow:base_txt2img': (req) => ({
    3: {
      class_type: 'KSampler',
      inputs: {
        seed: req.seed < 0 ? Math.floor(Math.random() * 1e15) : req.seed,
        steps: req.steps,
        cfg: req.cfgScale,
        sampler_name: req.sampler,
        scheduler: 'normal',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: req.model } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: req.width, height: req.height, batch_size: req.batchSize } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: req.prompt, clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: req.negativePrompt, clip: ['4', 1] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'aiart', images: ['8', 0] } },
  }),
};

export class ComfyUiAdapter extends BaseAdapter {
  get requiresKey() {
    return false;
  }

  get capabilities() {
    return {
      text2img: true,
      img2img: false,
      negativePrompt: true,
      seedControl: true,
      batchNative: true,
      async: true,
      maxBatchSize: 8,
      supportedSizes: [],
      supportedModels: this.models,
      note: '异步队列模式：提交后轮询 history',
    };
  }

  buildPayload(req) {
    const builder = WORKFLOWS[req.model];
    if (!builder) {
      throw new AppError('E_VALIDATION_OUT_OF_RANGE', `未知工作流：${req.model}`, { field: 'model', details: { available: Object.keys(WORKFLOWS) } });
    }
    return { prompt: builder(req), client_id: `aiart-${Date.now().toString(36)}` };
  }

  /** 提交后立即返回 remoteTaskId，真正的等待交给 poll。 */
  async submit(payload, ctx = {}) {
    const body = await this.callApi('/prompt', { body: payload, signal: ctx.signal });
    const remoteTaskId = body?.prompt_id;
    if (!remoteTaskId) throw new AppError('E_PROVIDER_BAD_RESPONSE', 'ComfyUI 未返回 prompt_id', { details: truncate(body) });
    return { remoteTaskId, images: [], raw: { prompt_id: remoteTaskId, number: body.number } };
  }

  async poll(remoteTaskId, ctx = {}) {
    const history = await this.callApi(`/history/${encodeURIComponent(remoteTaskId)}`, { method: 'GET', signal: ctx.signal, maxRetries: 1 });
    const entry = history?.[remoteTaskId];
    if (!entry) return { state: 'running', progress: ctx.lastProgress ?? 10 };

    const status = entry.status || {};
    if (status.status_str === 'error') {
      return {
        state: 'failed',
        error: new AppError('E_PIPELINE_STEP_FAILED', `ComfyUI 执行失败：${truncate(status.messages)}`),
      };
    }

    const images = [];
    for (const node of Object.values(entry.outputs || {})) {
      for (const img of node.images || []) {
        if (img.type === 'temp') continue;
        images.push({
          remoteUrl: `${this.baseUrl}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${img.type || 'output'}`,
          mime: 'image/png',
          meta: { renderer: 'comfyui', node: img.filename },
        });
      }
    }
    if (!images.length) return { state: 'running', progress: Math.min(90, (ctx.lastProgress ?? 10) + 8) };
    return { state: 'succeeded', images, progress: 100 };
  }

  async probe() {
    await this.callApi('/system_stats', { method: 'GET', maxRetries: 0 });
  }
}

function truncate(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}
