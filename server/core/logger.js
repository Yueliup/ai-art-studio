/**
 * 结构化日志 + 请求上下文（AsyncLocalStorage 传递 traceId）。
 *
 * 生产落盘为 JSON Lines，便于直接接入 ELK / Loki；控制台输出带颜色便于本地调试。
 * 所有日志自动携带 traceId，跨「HTTP 请求 -> 队列任务 -> 外部提供方调用」保持同一条链路。
 */

import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

export const als = new AsyncLocalStorage();

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', reset: '\x1b[0m' };

let currentLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
let logStream = null;

export function initLogger({ level, logDir }) {
  if (level) currentLevel = LEVELS[String(level).toLowerCase()] ?? currentLevel;
  if (logDir) {
    fs.mkdirSync(logDir, { recursive: true });
    logStream = fs.createWriteStream(path.join(logDir, 'app.log'), { flags: 'a' });
  }
}

export function currentContext() {
  return als.getStore() || {};
}

/** 在指定上下文中执行 fn，用于 HTTP 请求与队列任务。 */
export function runWithContext(ctx, fn) {
  return als.run({ ...currentContext(), ...ctx }, fn);
}

export function bindContext(patch) {
  const store = als.getStore();
  if (store) Object.assign(store, patch);
}

function emit(level, event, fields) {
  if (LEVELS[level] < currentLevel) return;
  const ctx = currentContext();
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    traceId: ctx.traceId || null,
    jobId: ctx.jobId || null,
    span: ctx.span || null,
    ...fields,
  };
  const text = `[${record.ts.slice(11, 23)}] ${COLORS[level]}${level.toUpperCase().padEnd(5)}${COLORS.reset} ` +
    `${(record.traceId || '-').slice(0, 12)} ${event}`;
  const tail = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');
  process.stdout.write(`${text}${tail ? ` ${tail}` : ''}\n`);
  logStream?.write(`${JSON.stringify(record)}\n`);
}

export const logger = {
  debug: (event, fields) => emit('debug', event, fields),
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
  child(baseFields) {
    return {
      debug: (e, f) => emit('debug', e, { ...baseFields, ...f }),
      info: (e, f) => emit('info', e, { ...baseFields, ...f }),
      warn: (e, f) => emit('warn', e, { ...baseFields, ...f }),
      error: (e, f) => emit('error', e, { ...baseFields, ...f }),
    };
  },
};

/** 统计接口耗时并输出统一 access 日志。 */
export function timeit() {
  const start = process.hrtime.bigint();
  return () => Number(process.hrtime.bigint() - start) / 1e6;
}
