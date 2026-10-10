/**
 * 任务中心接口：列表 / 详情 / 实时进度(SSE) / 取消 / 重跑 / 产物下载。
 *
 * SSE 而非 WebSocket 的取舍：进度是单向推送，SSE 走原生 Http，无需额外握手与心跳协议，
 * 断线浏览器会自动重连（配合 Last-Event-ID），对企业内网代理更友好。
 */

import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import { jobStore, JOB_STATUS, withWorkspacePath } from '../core/store.js';
import { publicArtifact, stripAbsolutePaths } from '../core/sanitize.js';
import { jobQueue } from '../core/queue.js';
import { paginated } from '../core/response.js';
import { humanBytes } from '../util/misc.js';

export function registerJobRoutes(router) {
  router.get('/api/jobs', async (ctx) => {
    const { items, total } = jobStore.list({
      status: ctx.query.status,
      kind: ctx.query.kind,
      keyword: ctx.query.keyword,
      limit: Number(ctx.query.pageSize || 50),
      offset: ((Number(ctx.query.page || 1) - 1) * Number(ctx.query.pageSize || 50)) | 0,
    });
    return { ...paginated(items, { page: Number(ctx.query.page || 1), pageSize: Number(ctx.query.pageSize || 50), total }), queue: jobQueue.snapshot() };
  });

  router.get('/api/jobs/:id', async (ctx) => {
    const job = jobStore.get(ctx.params.id);
    // 必须走 serialize()：这里曾经直接展开原始 job，把 payload.outDir 这类绝对路径带了出去
    return {
      job: {
        ...serialize(job),
        queuePosition: job.status === JOB_STATUS.QUEUED ? Math.max(0, jobQueue.pending.findIndex((p) => p.record.id === job.id)) : null,
      },
    };
  });

  /** SSE 实时进度流。 */
  router.get('/api/jobs/:id/events', async (ctx) => {
    const jobId = ctx.params.id;
    const job = jobStore.get(jobId); // 提前校验存在性，避免建立长连接后才发现 404

    ctx.res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    ctx.res.write(`retry: 3000\n\n`);

    const send = (event, data) => {
      if (ctx.res.writableEnded) return;
      ctx.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('snapshot', serialize(job));

    const unsubscribe = jobStore.subscribe(jobId, (evt) => {
      if (evt.type === 'snapshot') return;
      if (evt.type === 'job.patch') {
        send('progress', serialize(jobStore.get(jobId)));
        const status = evt.patch?.status;
        if (status && [JOB_STATUS.SUCCEEDED, JOB_STATUS.FAILED, JOB_STATUS.CANCELED, JOB_STATUS.PARTIAL].includes(status)) {
          send('finished', serialize(jobStore.get(jobId)));
          cleanup();
        }
      } else if (evt.type === 'job.log') {
        send('log', evt.entry);
      } else if (evt.type === 'job.artifact') {
        send('artifact', evt.artifact);
      }
    });

    const keepAlive = setInterval(() => {
      if (!ctx.res.writableEnded) ctx.res.write(': ping\n\n');
    }, 15000);
    keepAlive.unref?.();

    let closed = false;
    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      unsubscribe();
      if (!ctx.res.writableEnded) ctx.res.end();
    }

    ctx.req.on('close', cleanup);
    ctx.req.on('aborted', cleanup);

    return { __raw: true, status: 200 };
  });

  router.post('/api/jobs/:id/cancel', async (ctx) => {
    const result = jobQueue.cancel(ctx.params.id);
    return { ...result, job: jobStore.summary(jobStore.get(ctx.params.id)) };
  });

  router.post('/api/jobs/:id/retry', async (ctx) => {
    const job = jobQueue.retry(ctx.params.id);
    return { job };
  });

  router.delete('/api/jobs/:id', async (ctx) => {
    const job = jobStore.get(ctx.params.id);
    if ([JOB_STATUS.RUNNING, JOB_STATUS.QUEUED].includes(job.status)) {
      throw new AppError('E_JOB_ALREADY_RUNNING', '运行中的任务不可删除，请先取消');
    }
    jobStore.jobs.delete(job.id);
    jobStore.order = jobStore.order.filter((id) => id !== job.id);
    jobStore._touch();
    return { deleted: job.id, freedBytes: (job.artifacts || []).reduce((s, a) => s + (a.bytes || 0), 0) };
  });

  router.get('/api/jobs/:id/artifacts', async (ctx) => {
    const job = jobStore.get(ctx.params.id);
    return {
      jobId: job.id,
      count: (job.artifacts || []).length,
      artifacts: (job.artifacts || []).map((a) => ({ ...publicArtifact(withWorkspacePath({ ...a })), exists: a.path ? fs.existsSync(a.path) : false })),
    };
  });

  /** 单产物下载：控制台逐张取图用。 */
  router.get('/api/jobs/:id/artifacts/:index/download', async (ctx) => {
    const job = jobStore.get(ctx.params.id);
    const idx = Number(ctx.params.index);
    const artifact = (job.artifacts || [])[idx];
    if (!artifact) throw new AppError('E_ASSET_NOT_FOUND', `任务 ${ctx.params.id} 不存在序号为 ${ctx.params.index} 的产物`);
    if (!fs.existsSync(artifact.path)) throw new AppError('E_ASSET_NOT_FOUND', '产物文件已被清理');
    const { sendFileDownload } = await import('../core/router.js');
    await sendFileDownload(ctx.res, artifact.path, artifact.file);
    return { __raw: true, status: 200 };
  });

  /** 打包产物下载。 */
  router.get('/api/packages/:fileName/download', async (ctx) => {
    const fileName = path.basename(ctx.params.fileName);
    const { absPath } = await import('../core/config.js');
    const file = absPath('packages', fileName);
    if (!fs.existsSync(file)) throw new AppError('E_PACKAGE_NOT_FOUND', `产物包不存在：${fileName}`);
    const { sendFileDownload } = await import('../core/router.js');
    await sendFileDownload(ctx.res, file, fileName);
    return { __raw: true, status: 200 };
  });

  /** 报告预览（内联打开 HTML）。 */
  router.get('/api/packages/:fileName/preview', async (ctx) => {
    const fileName = path.basename(ctx.params.fileName);
    const { absPath } = await import('../core/config.js');
    const file = absPath('packages', fileName);
    if (!fs.existsSync(file)) throw new AppError('E_PACKAGE_NOT_FOUND', `产物包不存在：${fileName}`);
    const stat = fs.statSync(file);
    ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(ctx.res);
    return { __raw: true, status: 200 };
  });

  router.get('/api/stats/overview', async () => {
    const stats = jobStore.stats();
    const recent = jobStore.list({ limit: 20 }).items;
    const outputs = await countOutputs();
    return {
      jobs: stats,
      outputs,
      recent,
      queue: jobQueue.snapshot(),
      providers: (await (await import('../adapters/index.js')).providers.healthAll()).map((p) => ({ id: p.id, label: p.label, ok: p.ok, detail: p.detail })),
    };
  });
}

function serialize(job) {
  return {
    id: job.id,
    name: job.name,
    kind: job.kind,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    attempts: job.attempts,
    maxRetries: job.maxRetries,
    counts: job.counts,
    error: job.error,
    // payload 里有 outDir 等绝对路径，统一走脱敏
    payload: stripAbsolutePaths(job.payload),
    artifacts: (job.artifacts || []).map((a) => publicArtifact(withWorkspacePath({ ...a }))),
    // result 里各流水线的 outDir / package.path 等都是绝对路径，统一在这里剥掉
    result: stripAbsolutePaths(job.result),
    logs: job.logs?.slice(-40),
  };
}

async function countOutputs() {
  const { absPath } = await import('../core/config.js');
  const dir = absPath('outputs');
  if (!fs.existsSync(dir)) return { files: 0, packs: 0, bytes: 0, bytesText: '0 B' };
  let bytes = 0;
  let files = 0;
  const walk = (d, depth = 0) => {
    if (depth > 4) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else {
        files += 1;
        bytes += fs.statSync(p).size;
      }
    }
  };
  walk(dir);
  const packDir = absPath('packages');
  const packs = fs.existsSync(packDir) ? fs.readdirSync(packDir).filter((f) => f.endsWith('.zip')).length : 0;
  return { files, packs, bytes, bytesText: humanBytes(bytes) };
}
