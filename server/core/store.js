/**
 * 任务仓库 + 事件总线。
 *
 * 任务（Job）是企业侧的审计单元：谁在什么时候、用什么参数、跑了什么流水线、
 * 每个子步骤成败如何、产物在哪里、失败原因分布是什么，全部可回溯。
 *
 * 落盘策略：内存为主 + 变更后延迟批量刷盘（500ms 合并），避免高频进度写入打爆磁盘；
 * 进程退出时同步刷盘。历史按 historyLimit 截断。
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { getConfig, absPath } from './config.js';
import { AppError } from './errors.js';
import { logger } from './logger.js';
import { publicArtifact } from './sanitize.js';

/**
 * 给产物补一个「相对工作区根目录」的路径，供前端通过 /api/workspace/file 安全取图。
 * 刻意不回传绝对路径：绝对路径会把服务器目录结构泄漏到浏览器。
 */
export function withWorkspacePath(artifact) {
  if (!artifact) return artifact;
  if (!artifact.workspacePath && artifact.path) {
    const rel = path.relative(absPath(), artifact.path).split(path.sep).join('/');
    artifact.workspacePath = rel.startsWith('..') ? null : rel;
  }
  return artifact;
}

export const JOB_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELED: 'canceled',
  PARTIAL: 'partial',
};

const TERMINAL = new Set([JOB_STATUS.SUCCEEDED, JOB_STATUS.FAILED, JOB_STATUS.CANCELED, JOB_STATUS.PARTIAL]);

export class JobStore extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.jobs = new Map();
    this.order = [];
    this._dirty = false;
    this._flushTimer = null;
    this._paused = false;
  }

  file() {
    const p = getConfig().paths.jobs;
    return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  }

  load() {
    try {
      const file = this.file();
      if (!fs.existsSync(file)) return;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const job of raw.jobs || []) {
        // 进程重启后，未完成的任务不可能恢复执行，标记为失败并说明原因，避免"僵尸 running"。
        if (!TERMINAL.has(job.status)) {
          job.status = JOB_STATUS.FAILED;
          job.finishedAt = job.finishedAt || new Date().toISOString();
          job.error = { code: 'E_SYS_INTERNAL', message: '服务重启导致任务中断', retryable: true, domain: 'SYS' };
        }
        this.jobs.set(job.id, job);
        this.order.push(job.id);
      }
      logger.info('jobstore.loaded', { count: this.jobs.size });
    } catch (err) {
      logger.warn('jobstore.load.failed', { error: err.message });
    }
  }

  create(job) {
    this.jobs.set(job.id, job);
    this.order.unshift(job.id);
    this._trim();
    this._touch();
    this.emit(job.id, { type: 'job.created', job });
    return job;
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new AppError('E_JOB_NOT_FOUND', `任务 ${id} 不存在`, { details: { jobId: id } });
    return job;
  }

  has(id) {
    return this.jobs.has(id);
  }

  list({ status, kind, limit = 50, offset = 0, keyword } = {}) {
    let ids = this.order;
    if (status) {
      const set = new Set(String(status).split(','));
      ids = ids.filter((id) => set.has(this.jobs.get(id)?.status));
    }
    if (kind) ids = ids.filter((id) => this.jobs.get(id)?.kind === kind);
    if (keyword) {
      const kw = keyword.toLowerCase();
      ids = ids.filter((id) => {
        const j = this.jobs.get(id);
        return j?.name?.toLowerCase().includes(kw) || j?.id.toLowerCase().includes(kw);
      });
    }
    const total = ids.length;
    const items = ids.slice(offset, offset + limit).map((id) => this.summary(this.jobs.get(id)));
    return { items, total };
  }

  summary(job) {
    return {
      id: job.id,
      name: job.name,
      kind: job.kind,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      durationMs: job.durationMs,
      counts: job.counts,
      error: job.error,
      artifacts: job.artifacts?.length || 0,
      requestedBy: job.requestedBy || 'local',
    };
  }

  patch(id, patch) {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch);
    this._touch();
    this.emit(id, { type: 'job.patch', patch, job: this.summary(job) });
    return job;
  }

  log(id, level, message, fields) {
    const job = this.jobs.get(id);
    if (!job) return;
    const entry = { ts: new Date().toISOString(), level, message, ...(fields ? { fields } : {}) };
    job.logs.push(entry);
    if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
    this._touch();
    this.emit(id, { type: 'job.log', entry });
  }

  addArtifact(id, artifact) {
    const job = this.jobs.get(id);
    if (!job) return;
    const stored = withWorkspacePath(artifact);
    job.artifacts.push(stored);
    this._touch();
    // 事件里推送的是脱敏副本：SSE 与 HTTP 响应一样不该带服务器绝对路径
    this.emit(id, { type: 'job.artifact', artifact: publicArtifact(stored) });
  }

  _trim() {
    const limit = getConfig().queue.historyLimit;
    while (this.order.length > limit) {
      const dropped = this.order.pop();
      this.jobs.delete(dropped);
    }
  }

  _touch() {
    this._dirty = true;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush();
    }, 500);
    this._flushTimer.unref?.();
  }

  flush() {
    if (!this._dirty) return;
    try {
      const file = this.file();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const payload = { version: 1, savedAt: new Date().toISOString(), jobs: this.order.map((id) => this.jobs.get(id)).filter(Boolean) };
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, file);
      this._dirty = false;
    } catch (err) {
      logger.warn('jobstore.flush.failed', { error: err.message });
    }
  }

  /** 任务订阅：既回放快照，又推送后续事件，避免前端订阅时丢事件。 */
  subscribe(id, onEvent) {
    const job = this.get(id);
    onEvent({ type: 'snapshot', job });
    const listener = (evt) => onEvent(evt);
    this.on(id, listener);
    return () => this.off(id, listener);
  }

  stats() {
    const counts = { queued: 0, running: 0, succeeded: 0, failed: 0, canceled: 0, partial: 0 };
    let assetBytes = 0;
    for (const id of this.order) {
      const j = this.jobs.get(id);
      counts[j.status] = (counts[j.status] || 0) + 1;
      for (const a of j.artifacts || []) assetBytes += a.bytes || 0;
    }
    return { total: this.order.length, counts, assetBytes };
  }
}

export const jobStore = new JobStore();
