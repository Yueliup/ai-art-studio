/**
 * 统一响应信封。
 *
 * 所有接口（含流式接口的每个事件）都使用同一结构，前端 SDK 只需实现一次解包：
 *   成功: { success:true,  code:"OK",   message, requestId, traceId, elapsedMs, data }
 *   失败: { success:false, code:"E_*",  message, requestId, traceId, elapsedMs, error:{domain,retryable,field,details} }
 *
 * 分页统一放在 data.pagination：{ page, pageSize, total, totalPages }。
 */

import { AppError, toAppError } from './errors.js';

export function ok(data = null, extra = {}) {
  return {
    success: true,
    code: 'OK',
    message: extra.message || '成功',
    requestId: extra.requestId || null,
    traceId: extra.traceId || null,
    elapsedMs: extra.elapsedMs ?? null,
    ...(extra.warnings?.length ? { warnings: extra.warnings } : {}),
    data,
  };
}

export function fail(err, extra = {}) {
  const appErr = toAppError(err);
  return {
    success: false,
    code: appErr.code,
    message: appErr.message,
    requestId: extra.requestId || null,
    traceId: extra.traceId || null,
    elapsedMs: extra.elapsedMs ?? null,
    error: appErr.toPayload(),
    data: null,
  };
}

export function paginated(items, { page = 1, pageSize = 20, total = items.length } = {}) {
  const safeSize = Math.max(1, Number(pageSize) || 20);
  return {
    items,
    pagination: {
      page: Math.max(1, Number(page) || 1),
      pageSize: safeSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeSize)),
    },
  };
}

/** 批次结果聚合：企业侧关心「成功多少 / 失败多少 / 失败原因分布」。 */
export function aggregate(results = []) {
  const summary = {
    total: results.length,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    byCode: {},
  };
  for (const r of results) {
    if (r.status === 'success') summary.succeeded += 1;
    else if (r.status === 'skipped') summary.skipped += 1;
    else {
      summary.failed += 1;
      const c = r.code || 'E_SYS_INTERNAL';
      summary.byCode[c] = (summary.byCode[c] || 0) + 1;
    }
  }
  summary.successRate = summary.total ? +(summary.succeeded / summary.total).toFixed(4) : 0;
  return summary;
}

export { AppError };
