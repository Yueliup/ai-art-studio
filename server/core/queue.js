/**
 * 并发任务队列。
 *
 * 关键企业特性：
 *  - 双重并发上限：全局上限 + 每个提供方独立上限（本地 GPU 只能串行，云端 API 可并行）；
 *  - 准入控制：队列长度超限直接回 E_LIMIT_QUEUE_FULL，而不是无限堆积把内存吃光；
 *  - 出队前检查取消标记，排队期间被取消的任务不会白白占用算力；
 *  - 单点收口：无论 handler 抛什么，都落到任务终态并广播，绝不让任务卡在 running；
 *  - 可重试错误自动指数退避重试，重试期间被取消立即生效；
 *  - 优雅关闭：先拒绝新任务，再等待在跑任务收尾。
 */

import { getConfig } from './config.js';
import { jobStore, JOB_STATUS } from './store.js';
import { logger, runWithContext } from './logger.js';
import { AppError, toAppError } from './errors.js';

/** 支持「非阻塞占用」的信号量：拿不到就让调度器去等释放事件，而不是排队阻塞。 */
class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
  }
  tryAcquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return true;
    }
    return false;
  }
  release() {
    this.active = Math.max(0, this.active - 1);
  }
  load() {
    return { active: this.active, limit: this.limit, idle: this.active < this.limit };
  }
}

export class JobQueue {
  constructor() {
    this.pending = [];
    this.running = new Map();
    this.globalSem = new Semaphore(getConfig().queue.concurrency);
    this.providerSem = new Map();
    this.stopping = false;
    this._pumping = false;
    /** 保留任务处理器，使失败任务可以被「重跑」而无需前端重新提交参数。 */
    this.handlers = new Map();
  }

  semFor(providerId) {
    if (!providerId) return null;
    if (!this.providerSem.has(providerId)) {
      const cfg = getConfig().providers.definitions[providerId];
      this.providerSem.set(providerId, new Semaphore(cfg?.maxConcurrency || 2));
    }
    return this.providerSem.get(providerId);
  }

  /**
   * 入队并立即返回任务快照（不阻塞 HTTP 请求）。
   * @param {object} job { id, name, kind, providerId, traceId, requestedBy, payload }
   * @param {(ctx:{job:any, signal:AbortSignal, onProgress:Function, onLog:Function}) => Promise<any>} handler
   */
  enqueue(job, handler, opts = {}) {
    if (this.stopping) throw new AppError('E_SYS_SHUTTING_DOWN');
    const max = getConfig().queue.maxQueueSize;
    if (this.pending.length >= max) {
      throw new AppError('E_LIMIT_QUEUE_FULL', `任务队列已满（上限 ${max}），请稍后提交`, {
        details: { pending: this.pending.length, limit: max },
      });
    }

    const controller = new AbortController();
    const record = {
      id: job.id,
      name: job.name,
      kind: job.kind,
      providerId: job.providerId || null,
      traceId: job.traceId || null,
      requestedBy: job.requestedBy || 'local',
      payload: job.payload || {},
      status: JOB_STATUS.QUEUED,
      progress: 0,
      stage: '排队中',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      logs: [],
      artifacts: [],
      result: null,
      error: null,
      counts: { total: job.payload?.total || 0, succeeded: 0, failed: 0, skipped: 0 },
      attempts: 0,
      maxRetries: opts.retries ?? getConfig().queue.maxRetries,
    };

    jobStore.create(record);
    this.handlers.set(record.id, handler);
    if (this.handlers.size > getConfig().queue.historyLimit * 2) {
      const keep = new Set(jobStore.order);
      for (const key of this.handlers.keys()) if (!keep.has(key)) this.handlers.delete(key);
    }
    this.pending.push({ record, handler, controller });
    logger.info('queue.enqueued', { jobId: record.id, kind: record.kind, pending: this.pending.length + this.running.size });
    this._schedule();
    return jobStore.summary(jobStore.get(record.id));
  }

  _schedule() {
    setImmediate(() => this._pump());
  }

  /** 调度器：只在拿到两级信号量时才把任务置为 running，否则等下一次释放事件。 */
  _pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      while (this.pending.length && !this.stopping) {
        const item = this.pending[0];

        if (item.controller.signal.aborted) {
          this.pending.shift();
          this._finalize(item, { status: JOB_STATUS.CANCELED, reason: '排队期间被用户取消' });
          continue;
        }

        if (!this.globalSem.tryAcquire()) break;
        const sem = this.semFor(item.record.providerId);
        if (sem && !sem.tryAcquire()) {
          this.globalSem.release();
          break;
        }

        this.pending.shift();
        this.running.set(item.record.id, { item, sem });
        this._run(item).catch((err) => {
          this._finalize(item, { status: JOB_STATUS.FAILED, error: toAppError(err) });
        });
      }
    } finally {
      this._pumping = false;
    }
  }

  async _run(item) {
    const { record, handler, controller } = item;
    const onProgress = (progress, stage) =>
      jobStore.patch(record.id, {
        progress: Math.max(0, Math.min(100, Math.round(progress))),
        ...(stage ? { stage } : {}),
      });
    const onLog = (level, message, fields) => jobStore.log(record.id, level, message, fields);
    const onArtifact = (artifact) => jobStore.addArtifact(record.id, artifact);

    await runWithContext({ traceId: record.traceId, jobId: record.id, span: 'job' }, async () => {
      jobStore.patch(record.id, { status: JOB_STATUS.RUNNING, startedAt: new Date().toISOString(), stage: '启动中' });
      const maxAttempts = (record.maxRetries ?? 0) + 1;
      let attempt = 0;

      while (attempt < maxAttempts) {
        attempt += 1;
        jobStore.patch(record.id, { attempts: attempt });
        try {
          const output = await handler({ job: jobStore.get(record.id), signal: controller.signal, onProgress, onLog, onArtifact });
          const counts = output?.counts || record.counts;
          const partial = counts.failed > 0 && (counts.succeeded > 0 || counts.skipped > 0);
          this._finalize(item, {
            status: partial ? JOB_STATUS.PARTIAL : JOB_STATUS.SUCCEEDED,
            // handler 约定返回 { counts, result }，此处把 result 提升到任务顶层，避免多一层嵌套
            result: output?.result ?? null,
            counts,
          });
          return;
        } catch (err) {
          const appErr = toAppError(err);
          if (controller.signal.aborted) {
            this._finalize(item, { status: JOB_STATUS.CANCELED, reason: `执行中被取消（${appErr.message}）` });
            return;
          }
          if (!appErr.retryable || attempt >= maxAttempts) {
            this._finalize(item, { status: JOB_STATUS.FAILED, error: appErr });
            return;
          }
          const delay = getConfig().queue.baseBackoffMs * 2 ** (attempt - 1);
          onLog('warn', `第 ${attempt} 次执行失败（${appErr.code}）：${appErr.message}，${delay}ms 后重试`);
          logger.warn('job.retry', { jobId: record.id, attempt, code: appErr.code, delay });
          await new Promise((r) => setTimeout(r, delay));
          if (controller.signal.aborted) {
            this._finalize(item, { status: JOB_STATUS.CANCELED, reason: '重试等待期间被取消' });
            return;
          }
        }
      }
    });
  }

  _finalize(item, { status, result = null, error = null, counts, reason }) {
    const { record } = item;
    const entry = this.running.get(record.id);
    if (entry) {
      if (entry.sem) entry.sem.release();
      this.globalSem.release();
      this.running.delete(record.id);
    }

    const live = jobStore.has(record.id) ? jobStore.get(record.id) : record;
    const startedAt = live.startedAt ? new Date(live.startedAt).getTime() : Date.now();
    const stageLabel = {
      [JOB_STATUS.SUCCEEDED]: '已完成',
      [JOB_STATUS.PARTIAL]: '部分成功',
      [JOB_STATUS.FAILED]: '执行失败',
      [JOB_STATUS.CANCELED]: '已取消',
    }[status];

    if (reason) jobStore.log(record.id, 'warn', reason);
    jobStore.patch(record.id, {
      status,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      progress: [JOB_STATUS.SUCCEEDED, JOB_STATUS.PARTIAL].includes(status) ? 100 : live.progress,
      stage: stageLabel,
      result,
      error: error ? (error.toPayload?.() ?? error) : null,
      ...(counts ? { counts } : {}),
    });

    logger.info('job.finished', { jobId: record.id, status, durationMs: Date.now() - startedAt });
    this._schedule();
  }

  cancel(id) {
    const idx = this.pending.findIndex((p) => p.record.id === id);
    if (idx >= 0) {
      const [item] = this.pending.splice(idx, 1);
      item.controller.abort();
      this._finalize(item, { status: JOB_STATUS.CANCELED, reason: '排队期间被用户取消' });
      return { canceled: true, was: 'queued' };
    }
    const running = this.running.get(id);
    if (running) {
      running.item.controller.abort();
      jobStore.log(id, 'warn', '已发送取消信号，等待当前步骤收尾');
      return { canceled: true, was: 'running' };
    }
    throw new AppError('E_JOB_NOT_CANCELABLE', `任务 ${id} 当前状态不可取消`);
  }

  retry(id) {
    const job = jobStore.get(id);
    if ([JOB_STATUS.RUNNING, JOB_STATUS.QUEUED].includes(job.status)) {
      throw new AppError('E_JOB_ALREADY_RUNNING');
    }
    const handler = this.handlers.get(id);
    if (!handler) {
      throw new AppError('E_JOB_NOT_CANCELABLE', '该任务已超出保留窗口，无法重跑');
    }
    jobStore.patch(id, { status: JOB_STATUS.QUEUED, error: null, logs: [], artifacts: [], result: null, progress: 0, stage: '重新排队' });
    const controller = new AbortController();
    this.pending.push({ record: jobStore.get(id), handler, controller });
    this._schedule();
    return jobStore.summary(job);
  }

  async stop({ timeoutMs = 15000 } = {}) {
    this.stopping = true;
    for (const item of this.pending.splice(0)) {
      item.controller.abort();
      this._finalize(item, { status: JOB_STATUS.CANCELED, reason: '服务关闭，排队任务已取消' });
    }
    const deadline = Date.now() + timeoutMs;
    while (this.running.size && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    jobStore.flush();
    return { stillRunning: this.running.size };
  }

  snapshot() {
    return {
      pending: this.pending.length,
      running: this.running.size,
      stopping: this.stopping,
      global: this.globalSem.load(),
      providers: Object.fromEntries([...this.providerSem.entries()].map(([k, v]) => [k, v.load()])),
    };
  }
}

export const jobQueue = new JobQueue();
