/**
 * OpenAI Images 适配器（gpt-image-1 / dall-e-3）。
 *
 * 协议特征：同步返回，可能给 b64_json 也可能给 url；尺寸用字符串枚举（"1024x1024"）；
 * gpt-image-1 不支持 response_format 参数，DALL·E 才支持。适配层需要按 model 分叉。
 */

import { BaseAdapter } from './base.js';
import { AppError } from '../core/errors.js';

const DALL_E_SIZES = ['1024x1024', '1792x1024', '1024x1792'];
const GPT_IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'];

export class OpenAiImagesAdapter extends BaseAdapter {
  get requiresKey() {
    return true;
  }

  get capabilities() {
    return {
      text2img: true,
      img2img: true,
      negativePrompt: false,
      seedControl: false,
      batchNative: true,
      async: false,
      maxBatchSize: 8,
      supportedSizes: [...new Set([...DALL_E_SIZES, ...GPT_IMAGE_SIZES])],
      supportedModels: this.models,
      note: '不支持 negative prompt 与固定 seed；n 上限受模型约束',
    };
  }

  buildPayload(req) {
    const isDalle = /dall-e/i.test(req.model);
    const size = isDalle ? nearestDalleSize(req.width, req.height) : `${req.width}x${req.height}`;
    const body = {
      model: req.model,
      prompt: isDalle ? req.prompt : mergeStyle(req.prompt, req.stylePreset),
      n: Math.min(req.batchSize, isDalle ? 1 : 8),
      size,
    };
    if (size === 'auto' && !isDalle) delete body.size;
    if (isDalle) {
      body.quality = 'standard';
      body.response_format = 'b64_json';
    }
    return body;
  }

  async submit(payload, ctx = {}) {
    const body = await this.callApi('/images/generations', { body: payload, signal: ctx.signal });
    const items = Array.isArray(body?.data) ? body.data : [];
    if (!items.length) throw new AppError('E_PROVIDER_BAD_RESPONSE', 'OpenAI 未返回图像数据', { details: body });

    const images = items.map((it) => ({
      data: it.b64_json ? Buffer.from(it.b64_json, 'base64') : null,
      remoteUrl: it.b64_json ? null : it.url,
      mime: 'image/png',
      meta: { renderer: 'openai-images', revisedPrompt: it.revised_prompt || null, model: payload.model },
    }));
    return { images, raw: { count: images.length, created: body.created } };
  }

  async probe() {
    await this.callApi('/models', { method: 'GET', maxRetries: 0 });
  }
}

function mergeStyle(prompt, stylePreset) {
  if (!stylePreset || stylePreset === 'none') return prompt;
  return `${prompt}. Style: ${stylePreset}`;
}

function nearestDalleSize(w, h) {
  const ratio = w / h;
  if (ratio > 1.35) return '1792x1024';
  if (ratio < 0.75) return '1024x1792';
  return '1024x1024';
}
