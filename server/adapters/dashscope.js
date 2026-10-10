/**
 * 阿里云百炼 · 通义万相（DashScope）适配器。
 *
 * 协议特征：**异步任务**。POST /services/aigc/text2image/image-synthesis 提交，
 * 带 header X-DashScope-Async: enable，返回 output.task_id；
 * 再 GET /tasks/{task_id} 轮询，直到 task_status = SUCCEEDED 且 results[].url 可用。
 * 图片 URL 有效期通常 24 小时，因此必须立即落盘 —— 这正是适配层 fetchResult 的价值。
 */

import { BaseAdapter } from './base.js';
import { AppError } from '../core/errors.js';

export class DashScopeAdapter extends BaseAdapter {
  get requiresKey() {
    return true;
  }

  get capabilities() {
    return {
      text2img: true,
      img2img: false,
      negativePrompt: true,
      seedControl: true,
      batchNative: true,
      async: true,
      maxBatchSize: 4,
      supportedSizes: ['1024*1024', '1280*720', '720*1280', '1440*810', '810*1440'],
      supportedModels: this.models,
      note: '异步任务模式，产物 URL 有效期为 24 小时，已自动转存本地',
    };
  }

  buildPayload(req) {
    return {
      model: req.model,
      input: {
        prompt: req.prompt,
        ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
      },
      parameters: {
        size: `${req.width}*${req.height}`,
        n: Math.min(req.batchSize, 4),
        ...(req.seed >= 0 ? { seed: req.seed } : {}),
        prompt_extend: true,
      },
    };
  }

  async submit(payload, ctx = {}) {
    const body = await this.callApi('/services/aigc/text2image/image-synthesis', {
      body: payload,
      signal: ctx.signal,
      headers: { 'X-DashScope-Async': 'enable' },
    });
    const remoteTaskId = body?.output?.task_id;
    if (!remoteTaskId) {
      throw new AppError('E_PROVIDER_BAD_RESPONSE', `通义万相未返回 task_id：${body?.message || JSON.stringify(body).slice(0, 200)}`, { details: body });
    }
    return { remoteTaskId, images: [], raw: body };
  }

  async poll(remoteTaskId, ctx = {}) {
    const body = await this.callApi(`/tasks/${encodeURIComponent(remoteTaskId)}`, { method: 'GET', signal: ctx.signal, maxRetries: 1 });
    const output = body?.output || {};
    const state = String(output.task_status || '').toUpperCase();

    if (state === 'FAILED' || state === 'UNKNOWN') {
      const code = String(output.code || '');
      const mapped = /InvalidApiKey|Unauthorized/i.test(code)
        ? 'E_PROVIDER_AUTH'
        : /Quota|Throttling|LimitExceeded/i.test(code)
          ? 'E_PROVIDER_QUOTA_EXCEEDED'
          : /DataInspection|SensitiveContent/i.test(code)
            ? 'E_PROVIDER_CONTENT_REJECTED'
            : 'E_PROVIDER_UNAVAILABLE';
      return { state: 'failed', error: new AppError(mapped, `通义万相任务失败：${output.message || code}`, { details: output }) };
    }
    if (state === 'SUCCEEDED') {
      const results = Array.isArray(output.results) ? output.results : [];
      const images = results
        .filter((r) => r.url)
        .map((r, i) => ({
          remoteUrl: r.url,
          mime: 'image/png',
          seed: r.seed,
          meta: { renderer: 'dashscope', index: i, taskId: remoteTaskId },
        }));
      if (!images.length) return { state: 'failed', error: new AppError('E_PROVIDER_BAD_RESPONSE', '任务成功但未返回图片地址') };
      return { state: 'succeeded', images, progress: 100 };
    }
    return { state: state === 'PENDING' ? 'pending' : 'running', progress: state === 'PENDING' ? 5 : (ctx.lastProgress ?? 10) + 5 };
  }
}
