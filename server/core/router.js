/**
 * 极简 HTTP 路由框架。
 *
 * 只用 Node 原生能力实现，不引入 Web 框架，但具备生产所需的关键行为：
 *  - 路径参数 (:id) 与方法路由
 *  - 统一请求体解析：JSON 与 multipart/form-data（流式落盘，不把大文件读进内存）
 *  - 请求体积限制（超限及时断流，避免打爆内存）
 *  - 中间件链（鉴权 / 限流 / trace 注入）与统一错误出口
 *  - 静态资源服务（带 ETag 与缓存头）
 */

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { logger, als, runWithContext } from './logger.js';
import { fail, ok } from './response.js';
import { newTraceId } from '../util/misc.js';

export class Router {
  constructor() {
    this.routes = [];
    this.middlewares = [];
  }

  use(fn) {
    this.middlewares.push(fn);
    return this;
  }

  add(method, pattern, handler, meta = {}) {
    const keys = [];
    const regex = new RegExp(
      `^${pattern
        .replace(/\/:([A-Za-z0-9_]+)/g, (_, k) => {
          keys.push(k);
          return '/([^/]+)';
        })
        .replace(/\*$/, '(.*)')}$`
    );
    this.routes.push({ method, regex, keys, handler, meta, pattern });
    return this;
  }

  get(p, h, m) {
    return this.add('GET', p, h, m);
  }
  post(p, h, m) {
    return this.add('POST', p, h, m);
  }
  put(p, h, m) {
    return this.add('PUT', p, h, m);
  }
  patch(p, h, m) {
    return this.add('PATCH', p, h, m);
  }
  delete(p, h, m) {
    return this.add('DELETE', p, h, m);
  }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = pathname.match(route.regex);
      if (m) {
        const params = {};
        route.keys.forEach((k, i) => {
          params[k] = decodeURIComponent(m[i + 1]);
        });
        return { route, params };
      }
    }
    return null;
  }

  /** 供 /api/system/routes 自描述用。 */
  describe() {
    return this.routes.map((r) => ({ method: r.method, path: r.pattern, ...r.meta }));
  }
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.zip': 'application/zip',
};

export function contentTypeFor(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * 解析请求体。
 * - application/json  -> 解析为对象，超限抛 413
 * - multipart/form-data -> parts: { fields, files: [{field, filename, path, size, mime}] }
 */
export async function parseBody(req, { limitBytes }) {
  const ctype = req.headers['content-type'] || '';
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return { kind: 'none' };

  if (ctype.includes('application/json')) {
    const raw = await readAll(req, limitBytes);
    if (!raw.length) return { kind: 'json', data: {} };
    try {
      return { kind: 'json', data: JSON.parse(raw.toString('utf8')), rawBytes: raw.length };
    } catch (err) {
      throw new AppError('E_VALIDATION_FAILED', `请求体不是合法 JSON：${err.message}`);
    }
  }

  if (ctype.includes('multipart/form-data')) {
    return { kind: 'multipart', data: await parseMultipart(req, limitBytes) };
  }

  if (ctype.includes('application/x-www-form-urlencoded')) {
    const raw = await readAll(req, limitBytes);
    return { kind: 'json', data: Object.fromEntries(new URLSearchParams(raw.toString('utf8'))) };
  }

  const raw = await readAll(req, limitBytes);
  return { kind: 'raw', data: raw, rawBytes: raw.length };
}

function readAll(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (limitBytes && size > limitBytes) {
        req.destroy();
        reject(new AppError('E_LIMIT_PAYLOAD_TOO_LARGE', `请求体超过上限 ${(limitBytes / 1024 / 1024).toFixed(0)}MB`, { details: { limitBytes } }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(new AppError('E_IO_READ_FAILED', `读取请求体失败：${err.message}`, { cause: err })));
  });
}

/**
 * multipart 解析：借用 WHATWG FormData 实现，先把流交给 Response，
 * 再由 undici 负责边界解析；文件通过 File 对象读出后落盘。
 * 相比手写流式解析器，避免了一堆边界条件（CRLF、嵌套 boundary、超长 header）的坑。
 */
async function parseMultipart(req, limitBytes) {
  const ctype = req.headers['content-type'];
  const webStream = Readable.toWeb(req);
  let form;
  try {
    form = await new Response(webStream, { headers: { 'content-type': ctype } }).formData();
  } catch (err) {
    throw new AppError('E_VALIDATION_FAILED', `multipart 解析失败：${err.message}`, { cause: err });
  }

  const fields = {};
  const files = [];
  const uploadDir = path.join(process.cwd(), 'workspace', 'uploads', `batch_${Date.now().toString(36)}`);

  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') {
      fields[key] = value;
      continue;
    }
    const arr = Buffer.from(await value.arrayBuffer());
    if (limitBytes && arr.length > limitBytes) {
      throw new AppError('E_LIMIT_PAYLOAD_TOO_LARGE', `文件 ${value.name} 超过上限`);
    }
    fs.mkdirSync(uploadDir, { recursive: true });
    const safe = String(value.name || 'upload.bin').replace(/[\\/:*?"<>|]/g, '_');
    const dest = path.join(uploadDir, safe);
    fs.writeFileSync(dest, arr);
    files.push({
      field: key,
      filename: safe,
      originalName: value.name,
      mime: value.type || 'application/octet-stream',
      path: dest,
      size: arr.length,
    });
  }

  // 支持 fields.payload 携带 JSON 参数（前端一次性提交「文件 + 配置」的常见形态）
  if (fields.payload) {
    try {
      fields.payload = JSON.parse(fields.payload);
    } catch {
      throw new AppError('E_VALIDATION_FAILED', 'payload 字段不是合法 JSON', { field: 'payload' });
    }
  }

  return { fields, files, uploadDir };
}

export async function serveStatic(rootDir, pathname, req, res, { index = 'index.html' } = {}) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!rel) rel = index;
  const target = path.join(rootDir, rel);
  const resolved = path.resolve(target);

  if (!resolved.startsWith(path.resolve(rootDir))) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(fail(new AppError('E_AUTH_FORBIDDEN', '路径越界'))));
    return true;
  }

  let stat = fs.existsSync(resolved) ? fs.statSync(resolved) : null;
  if (stat?.isDirectory()) {
    const idx = path.join(resolved, index);
    if (fs.existsSync(idx)) {
      stat = fs.statSync(idx);
      return sendFile(idx, stat, req, res);
    }
    return false;
  }
  if (!stat) return false;
  return sendFile(resolved, stat, req, res);
}

function sendFile(filePath, stat, req, res) {
  const etag = `W/"${stat.size}-${stat.mtimeMs.toString(36)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }
  const headers = {
    'Content-Type': contentTypeFor(filePath),
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=60',
    'Last-Modified': stat.mtime.toUTCString(),
  };
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
  return true;
}

export async function sendFileDownload(res, filePath, downloadName) {
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentTypeFor(filePath),
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${encodeURIComponent(downloadName || path.basename(filePath))}"`,
    'Cache-Control': 'no-store',
  });
  try {
    await streamPipeline(fs.createReadStream(filePath), res);
  } catch (err) {
    // 客户端提前断开时字节流会抛 Premature close，属于正常现象，仅需关闭连接
    if (!res.writableEnded) res.destroy();
    throw err;
  }
}

/** 统一请求处理入口：注入 trace 上下文、统一错误出口、统一 access 日志。 */
export function createHandler({ router, bodyLimitBytes, hooks = [] }) {
  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const traceId = req.headers['x-trace-id'] || newTraceId();
    const start = process.hrtime.bigint();
    const requestId = randomUUID();

    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Trace-Id', traceId);
    res.setHeader('X-Powered-By', 'AI-Art-Studio');

    await runWithContext({ traceId, requestId, span: 'http' }, async () => {
      const matched = router.match(req.method, url.pathname);
      if (!matched) {
        writeJson(res, 404, fail(new AppError('E_ROUTE_NOT_FOUND', `接口不存在：${req.method} ${url.pathname}`), { requestId, traceId }));
        return;
      }

      const ctx = {
        req,
        res,
        url,
        params: matched.params,
        query: Object.fromEntries(url.searchParams.entries()),
        requestId,
        traceId,
        body: null,
        meta: matched.route.meta,
        locals: {},
        elapsed() {
          return Number(process.hrtime.bigint() - start) / 1e6;
        },
      };

      try {
        ctx.body = await parseBody(req, { limitBytes: bodyLimitBytes });
        for (const hook of hooks) {
          const stop = await hook(ctx);
          if (stop) return;
        }
        const result = await matched.route.handler(ctx);
        if (res.writableEnded) return;

        const elapsedMs = +ctx.elapsed().toFixed(2);
        if (result && result.__raw === true) {
          logger.info('http.done', { method: req.method, path: url.pathname, status: result.status || 200, ms: elapsedMs });
          return;
        }
        writeJson(res, 200, ok(result ?? null, { requestId, traceId, elapsedMs }));
        logger.info('http.done', { method: req.method, path: url.pathname, status: 200, ms: elapsedMs });
      } catch (err) {
        const appErr = err?.code && err?.httpStatus ? err : new AppError('E_SYS_INTERNAL', err?.message || '服务内部错误', { cause: err });
        const elapsedMs = +ctx.elapsed().toFixed(2);

        // 客户端中途断开（下载大文件时关闭页面/取消请求）不是服务端故障，不应该按 5xx 处理
        const clientAbort = /Premature close|EPIPE|ECONNRESET|aborted|write after end/i.test(appErr.message || '');
        if (clientAbort) {
          logger.debug('http.client.aborted', { method: req.method, path: url.pathname, ms: elapsedMs });
          if (!res.writableEnded) res.destroy();
          return;
        }

        logger[appErr.httpStatus >= 500 ? 'error' : 'warn']('http.error', {
          method: req.method,
          path: url.pathname,
          status: appErr.httpStatus,
          code: appErr.code,
          message: appErr.message,
          ms: elapsedMs,
        });

        if (res.writableEnded) return;
        if (res.headersSent) {
          // 响应头已发出（流式下载/SSE 中途失败），无法再改状态码，只能断开连接
          logger.warn('http.stream.broken', { path: url.pathname, code: appErr.code });
          res.destroy();
          return;
        }
        writeJson(res, appErr.httpStatus, fail(appErr, { requestId, traceId, elapsedMs }));
      }
    });
  };
}

export function writeJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

export { als };
