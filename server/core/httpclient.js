/**
 * 出站 HTTP 客户端：统一超时、重试退避、错误映射、埋点。
 *
 * 所有对外部 AI 提供方的调用必须经由此客户端，从而保证：
 *  1. 网络类错误被统一映射到 E_PROVIDER_* 错误码，而不是把 ECONNRESET 泄漏到上层；
 *  2. 重试策略集中一处（仅对 retryable 的错误码与 5xx/429 生效），带指数退避 + 抖动；
 *  3. 每次调用都有 span 记录，可在任务详情里看到「第几次尝试、耗时、状态码」。
 */

import { AppError } from './errors.js';
import { logger } from './logger.js';

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function computeDelay(attempt, baseMs, maxMs = 15000) {
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const jitter = Math.random() * baseMs * 0.4;
  return Math.round(exp + jitter);
}

/**
 * 单次请求（带超时与取消）。
 * @returns {Promise<{status:number, headers:Headers, body:any, raw:string}>}
 */
async function once(url, options) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 30000,
    signal,
    parse = 'auto',
    label = 'http',
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => controller.abort(new Error('cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });

  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: 'follow',
    });
    const raw = await res.text();
    let parsed = raw;
    if (parse === 'json' || (parse === 'auto' && /application\/json|text\/json/i.test(res.headers.get('content-type') || ''))) {
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = raw;
      }
    }
    logger.debug('provider.http', { label, url: safeUrl(url), status: res.status, ms: Date.now() - started, attempt: options.attempt });
    return { status: res.status, headers: res.headers, body: parsed, raw };
  } catch (err) {
    const aborted = controller.signal.aborted;
    const reason = controller.signal.reason?.message;
    logger.warn('provider.http.failed', {
      label,
      url: safeUrl(url),
      ms: Date.now() - started,
      attempt: options.attempt,
      reason: aborted ? reason || 'aborted' : err?.message,
    });
    if (aborted && reason === 'timeout') {
      throw new AppError('E_PROVIDER_TIMEOUT', `${label} 请求超时（${timeoutMs}ms）`, { cause: err });
    }
    if (aborted) {
      throw new AppError('E_PIPELINE_ABORTED', '任务已被取消', { cause: err });
    }
    throw new AppError('E_PROVIDER_UNAVAILABLE', `${label} 网络不可达：${err?.message || 'unknown'}`, { cause: err });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function safeUrl(url) {
  try {
    const u = new URL(url);
    const secretKeys = ['key', 'api_key', 'apikey', 'token', 'access_token', 'secret'];
    for (const k of secretKeys) if (u.searchParams.has(k)) u.searchParams.set(k, '***');
    return u.toString();
  } catch {
    return String(url);
  }
}

/**
 * 带重试的请求，返回 { status, body, raw, attempts, trace:[...] }。
 * 业务侧可用 classify 把提供方特有的错误体映射为统一错误码。
 */
export async function request(url, options = {}) {
  const {
    maxRetries = 2,
    baseBackoffMs = 800,
    retryOn = () => true,
    classify,
    ...rest
  } = options;

  const trace = [];
  let lastErr = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const t0 = Date.now();
    try {
      const res = await once(url, { ...rest, attempt });

      if (RETRYABLE_STATUS.has(res.status) && attempt <= maxRetries && retryOn(res)) {
        const delay = computeDelay(attempt, baseBackoffMs);
        trace.push({ attempt, status: res.status, ms: Date.now() - t0, retryInMs: delay });
        await sleep(delay);
        lastErr = new AppError(classify ? classify(res).code : 'E_PROVIDER_UNAVAILABLE', undefined, { details: truncate(res.raw) });
        continue;
      }

      trace.push({ attempt, status: res.status, ms: Date.now() - t0 });
      if (res.status >= 400) {
        const mapped = classify ? classify(res) : { code: 'E_PROVIDER_UNAVAILABLE', message: `HTTP ${res.status}` };
        const err = new AppError(mapped.code, mapped.message, { details: mapped.details ?? truncate(res.raw) });
        err.httpStatusRemote = res.status;
        err.attempts = attempt;
        err.trace = trace;
        throw err;
      }
      return { ...res, attempts: attempt, trace };
    } catch (err) {
      const appErr = err instanceof AppError ? err : new AppError('E_PROVIDER_UNAVAILABLE', String(err?.message || err));
      lastErr = appErr;
      if (!appErr.retryable || attempt > maxRetries) {
        appErr.attempts = attempt;
        appErr.trace = trace;
        throw appErr;
      }
      const delay = computeDelay(attempt, baseBackoffMs);
      trace.push({ attempt, error: appErr.code, ms: Date.now() - t0, retryInMs: delay });
      await sleep(delay);
    }
  }

  lastErr.attempts = maxRetries + 1;
  lastErr.trace = trace;
  throw lastErr;
}

export function truncate(text, n = 600) {
  if (text == null) return null;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  return s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s;
}

/** 供适配器复用的状态码 -> 统一错误码映射。 */
export function defaultClassify(label) {
  return (res) => {
    const body = res.body;
    const msg = typeof body === 'object' && body ? body.error?.message || body.message || body.msg : truncate(res.raw, 200);
    if (res.status === 401 || res.status === 403) return { code: 'E_PROVIDER_AUTH', message: `${label} 鉴权失败：${msg || res.status}` };
    if (res.status === 402) return { code: 'E_PROVIDER_QUOTA_EXCEEDED', message: `${label} 额度不足：${msg || res.status}` };
    if (res.status === 429) return { code: 'E_PROVIDER_RATE_LIMIT', message: `${label} 限流：${msg || res.status}` };
    if (res.status === 400 && /content|safety|policy|敏感|违规/i.test(String(msg))) {
      return { code: 'E_PROVIDER_CONTENT_REJECTED', message: `${label} 内容审核拦截：${msg}` };
    }
    return { code: 'E_PROVIDER_UNAVAILABLE', message: `${label} 返回 ${res.status}：${msg || ''}` };
  };
}

export async function downloadToFile(url, destPath, { timeoutMs = 120000, signal, headers = {} } = {}) {
  const fs = await import('node:fs');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  signal?.addEventListener('abort', () => controller.abort(new Error('cancelled')), { once: true });
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) throw new AppError('E_PROVIDER_UNAVAILABLE', `下载产物失败：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    return { bytes: buf.length, contentType: res.headers.get('content-type') };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('E_IO_WRITE_FAILED', `产物下载失败：${err?.message}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

export { sleep };
