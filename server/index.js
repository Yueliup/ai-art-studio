/**
 * AI Art Studio · 服务入口。
 *
 * 启动顺序（每一环都可能失败，失败即退出并给出可读原因）：
 *   1. 载入配置并准备目录
 *   2. 初始化日志
 *   3. 恢复任务历史（并把上次未完成的任务标记为中断）
 *   4. 同步提供方适配器
 *   5. 注册路由与中间件
 *   6. 监听端口 + 注册优雅关闭
 *
 * 优雅关闭会：停止接收新任务 → 取消排队任务 → 等待在跑任务收尾 → 刷盘任务历史。
 * 这样即使 Ctrl+C，也不会留下「running 但已死」的僵尸任务。
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, ensureDirs, redactConfig, ROOT } from './core/config.js';
import { initLogger, logger } from './core/logger.js';
import { Router, createHandler, serveStatic, writeJson } from './core/router.js';
import { jobStore } from './core/store.js';
import { jobQueue } from './core/queue.js';
import { providers } from './adapters/index.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerPipelineRoutes } from './routes/pipeline.js';
import { AppError, ERROR_CODES } from './core/errors.js';
import { fail } from './core/response.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function bootstrap() {
  const startedAt = Date.now();
  ensureDirs();
  const cfg = getConfig();
  initLogger({ level: cfg.log?.level || process.env.LOG_LEVEL || 'info', logDir: path.join(ROOT, 'workspace', 'logs') });

  logger.info('boot.config', {
    port: cfg.server.port,
    workspace: cfg.paths.workspace,
    concurrency: cfg.queue.concurrency,
    activeProvider: cfg.providers.active,
  });

  jobStore.load();
  providers.sync();

  const router = new Router();

  // ---- 中间件链：CORS → 鉴权（可选）→ 限流 ----
  const rateBucket = new Map();
  router.use(async (ctx) => {
    const origin = ctx.req.headers.origin;
    if (origin) {
      ctx.res.setHeader('Access-Control-Allow-Origin', getConfig().server.corsOrigin || '*');
      ctx.res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Trace-Id');
      ctx.res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      ctx.res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, X-Trace-Id');
    }
    if (ctx.req.method === 'OPTIONS') {
      ctx.res.writeHead(204);
      ctx.res.end();
      return true;
    }
    return false;
  });

  router.use(async (ctx) => {
    const token = getConfig().auth?.token;
    if (!token) return false;
    // 静态页面与健康检查放行，方便在浏览器里直接打开控制台
    if (!ctx.url.pathname.startsWith('/api/')) return false;
    if (ctx.url.pathname === '/api/system/health') return false;
    const provided = ctx.req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (provided !== token) {
      writeJson(ctx.res, 401, fail(new AppError('E_AUTH_REQUIRED', '访问令牌缺失或无效'), { requestId: ctx.requestId, traceId: ctx.traceId }));
      return true;
    }
    return false;
  });

  router.use(async (ctx) => {
    if (!ctx.url.pathname.startsWith('/api/')) return false;
    const windowMs = 10000;
    const max = 600;
    const key = `${ctx.req.socket.remoteAddress}|${Math.floor(Date.now() / windowMs)}`;
    const count = (rateBucket.get(key) || 0) + 1;
    rateBucket.set(key, count);
    if (rateBucket.size > 5000) {
      for (const [k] of rateBucket) if (!k.endsWith(String(Math.floor(Date.now() / windowMs)))) rateBucket.delete(k);
    }
    if (count > max) {
      writeJson(ctx.res, 429, fail(new AppError('E_LIMIT_QUEUE_FULL', '请求过于频繁，请稍后重试'), { requestId: ctx.requestId }));
      return true;
    }
    return false;
  });

  // ---- 路由注册 ----
  registerSystemRoutes(router);
  registerJobRoutes(router);
  registerPipelineRoutes(router);

  router.get('/api', async () => ({
    name: 'AI Art Studio API',
    version: '1.0.0',
    endpoints: router.describe().filter((r) => r.path.startsWith('/api')),
    errorCodes: Object.keys(ERROR_CODES).length,
  }));

  const handler = createHandler({
    router,
    bodyLimitBytes: getConfig().server.bodyLimitMB * 1024 * 1024,
  });

  const webDir = path.join(ROOT, 'web');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (!url.pathname.startsWith('/api')) {
      serveStatic(webDir, url.pathname, req, res).then((served) => {
        if (!served && !res.writableEnded) {
          // SPA 兜底：非资源请求一律回 index.html
          serveStatic(webDir, '/index.html', req, res).then((ok) => {
            if (!ok && !res.writableEnded) {
              res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end('Not Found');
            }
          });
        }
      });
      return;
    }
    handler(req, res).catch((err) => {
      logger.error('http.unhandled', { error: err?.message, stack: err?.stack?.split('\n').slice(0, 4).join(' | ') });
      if (res.writableEnded) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(fail(new AppError('E_SYS_INTERNAL', '未捕获的服务异常'))));
    });
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(getConfig().server.port, getConfig().server.host, resolve);
  });

  const addr = server.address();
  const base = `http://${addr.address === '::' || addr.address === '0.0.0.0' ? '127.0.0.1' : addr.address}:${addr.port}`;
  logger.info('boot.ready', { url: base, ms: Date.now() - startedAt });

  const shutdown = async (signal) => {
    logger.warn('boot.shutdown', { signal });
    const result = await jobQueue.stop({ timeoutMs: 12000 });
    server.close(() => {
      logger.info('boot.closed', result);
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 兜底：单次请求级的异常不应该拖垮整个服务（正在跑的批量任务会一起丢），
  // 因此这里只记录并计数，交由健康检查暴露异常频率。
  let unhandledCount = 0;
  process.on('uncaughtException', (err) => {
    unhandledCount += 1;
    logger.error('process.uncaughtException', { count: unhandledCount, error: err?.message, stack: err?.stack?.split('\n').slice(0, 5).join(' | ') });
    if (unhandledCount > 50) {
      logger.error('process.tooManyExceptions', { count: unhandledCount });
      shutdown('uncaughtException');
    }
  });
  process.on('unhandledRejection', (reason) => {
    unhandledCount += 1;
    logger.error('process.unhandledRejection', { count: unhandledCount, error: reason?.message || String(reason) });
  });

  return { server, url: base, router, config: redactConfig(), unhandled: () => unhandledCount };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  bootstrap().catch((err) => {
    logger.error('boot.failed', { error: err?.message, stack: err?.stack });
    // eslint-disable-next-line no-console
    console.error('\n启动失败：', err?.message, '\n');
    process.exit(1);
  });
}
