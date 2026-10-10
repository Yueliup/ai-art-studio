/**
 * 火山引擎 · 即梦 AI（视觉智能）适配器。
 *
 * 协议特征：异步提交 + 签名鉴权（AK/SK 派生 HMAC）。此处保留标准签名位，
 * 未配置 AK/SK 时回退为「Authorization: Bearer <token>」的简化模式，
 * 便于在只有临时 token 的环境下直接联调。
 */

import crypto from 'node:crypto';
import { BaseAdapter } from './base.js';
import { AppError } from '../core/errors.js';

export class VolcengineAdapter extends BaseAdapter {
  get requiresKey() {
    return true;
  }

  get capabilities() {
    return {
      text2img: true,
      img2img: true,
      negativePrompt: false,
      seedControl: true,
      batchNative: true,
      async: true,
      maxBatchSize: 4,
      supportedSizes: ['1024x1024', '768x1024', '1024x768', '1328x1328'],
      supportedModels: this.models,
      note: '异步任务模式，提交后轮询 task_id',
    };
  }

  buildPayload(req) {
    return {
      req_key: req.model,
      prompt: req.prompt,
      width: req.width,
      height: req.height,
      ...(req.seed >= 0 ? { seed: req.seed } : {}),
      return_url: true,
      logo_info: { add_logo: false },
    };
  }

  async submit(payload, ctx = {}) {
    const body = await this.callApi('/?Action=CVProcess&Version=2022-08-31', {
      body: payload,
      signal: ctx.signal,
      headers: this.signHeaders(payload, 'CVProcess'),
    });
    const remoteTaskId = body?.data?.task_id || body?.task_id;
    if (!remoteTaskId) {
      throw new AppError('E_PROVIDER_BAD_RESPONSE', `即梦未返回 task_id：${body?.message || JSON.stringify(body ?? {}).slice(0, 200)}`, { details: body });
    }
    return { remoteTaskId, images: [], raw: body };
  }

  async poll(remoteTaskId, ctx = {}) {
    const payload = { req_key: this.defaults.model, task_id: remoteTaskId, req_json: '{"return_url":true}' };
    const body = await this.callApi('/?Action=CVGetResult&Version=2022-08-31', {
      body: payload,
      signal: ctx.signal,
      maxRetries: 1,
      headers: this.signHeaders(payload, 'CVGetResult'),
    });
    const status = String(body?.data?.status || body?.status || '').toLowerCase();
    const raw = body?.data?.resp_data ? tryJson(body.data.resp_data) : null;

    if (status === 'failed' || status === 'not_found') {
      return { state: 'failed', error: new AppError('E_PROVIDER_UNAVAILABLE', `即梦任务失败：${body?.data?.message || status}`) };
    }
    if (status === 'done' || status === 'success') {
      const urls = Array.isArray(raw?.image_urls) ? raw.image_urls : [];
      const images = urls.map((u, i) => ({ remoteUrl: u, mime: 'image/jpeg', meta: { renderer: 'volcengine', index: i } }));
      if (!images.length) return { state: 'failed', error: new AppError('E_PROVIDER_BAD_RESPONSE', '任务完成但未返回图片地址') };
      return { state: 'succeeded', images, progress: 100 };
    }
    return { state: 'running', progress: (ctx.lastProgress ?? 10) + 6 };
  }

  /** 火山引擎 V4 签名（简化版：基于当前时间派生 HMAC-SHA256）。 */
  signHeaders(payload, action = 'CVProcess') {
    const ak = this.apiKey;
    const sk = process.env.VOLC_SECRET_KEY || '';
    if (!sk) return { Authorization: `Bearer ${ak}` };

    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const datetime = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const credentialScope = `${date}/cn-north-1/cv/request`;
    const canonical = `POST\n/\nAction=${action}&Version=2022-08-31\ncontent-type:application/json\nhost:visual.volcengineapi.com\nx-content-sha256:${bodyHash}\nx-date:${datetime}\n\ncontent-type;host;x-content-sha256;x-date\n${bodyHash}`;
    const stringToSign = `HMAC-SHA256\n${datetime}\n${credentialScope}\n${crypto.createHash('sha256').update(canonical).digest('hex')}`;
    const kDate = hmac(`VOLC${sk}`, date);
    const kRegion = hmac(kDate, 'cn-north-1');
    const kService = hmac(kRegion, 'cv');
    const kSigning = hmac(kService, 'request');
    const signature = hmac(kSigning, stringToSign).toString('hex');
    return {
      'X-Date': datetime,
      'X-Content-Sha256': bodyHash,
      Authorization: `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=${signature}`,
    };
  }
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}
function tryJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
