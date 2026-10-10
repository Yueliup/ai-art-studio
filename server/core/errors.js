/**
 * 统一错误码注册表。
 *
 * 设计约定：
 *  - 每个错误码形如 `E_<域>_<语义>`，域固定，便于前端按域做统一兜底与埋点聚合。
 *  - httpStatus 只描述「传输层」该回什么，业务语义一律看 code。
 *  - retryable 标记该错误是否允许队列自动重试（如超时/限流可重试，参数错误不可重试）。
 *
 * 前端只需消费 { code, message, details, retryable } 四个字段即可完成全部错误分支。
 */

export const ERROR_DOMAINS = {
  SYS: '系统',
  VALIDATION: '参数校验',
  NOT_FOUND: '资源不存在',
  CONFLICT: '状态冲突',
  LIMIT: '配额与限流',
  IO: '文件与磁盘',
  FORMAT: '格式与编解码',
  PIPELINE: '流水线执行',
  PROVIDER: '外部提供方',
  AUTH: '鉴权',
};

/** @type {Record<string, {httpStatus:number, domain:keyof typeof ERROR_DOMAINS, retryable:boolean, message:string}>} */
export const ERROR_CODES = {
  OK: { httpStatus: 200, domain: 'SYS', retryable: false, message: '成功' },

  // ---- 系统 ----
  E_SYS_INTERNAL: { httpStatus: 500, domain: 'SYS', retryable: false, message: '服务内部错误' },
  E_SYS_NOT_IMPLEMENTED: { httpStatus: 501, domain: 'SYS', retryable: false, message: '能力尚未实现' },
  E_SYS_SHUTTING_DOWN: { httpStatus: 503, domain: 'SYS', retryable: true, message: '服务正在关闭，暂不接收新任务' },
  E_SYS_BUSY: { httpStatus: 503, domain: 'SYS', retryable: true, message: '服务繁忙，请稍后重试' },

  // ---- 参数校验 ----
  E_VALIDATION_FAILED: { httpStatus: 400, domain: 'VALIDATION', retryable: false, message: '参数校验失败' },
  E_VALIDATION_MISSING_FIELD: { httpStatus: 400, domain: 'VALIDATION', retryable: false, message: '缺少必填字段' },
  E_VALIDATION_BAD_TYPE: { httpStatus: 400, domain: 'VALIDATION', retryable: false, message: '字段类型不合法' },
  E_VALIDATION_OUT_OF_RANGE: { httpStatus: 400, domain: 'VALIDATION', retryable: false, message: '字段取值超出允许范围' },

  // ---- 资源 ----
  E_NOT_FOUND: { httpStatus: 404, domain: 'NOT_FOUND', retryable: false, message: '资源不存在' },
  E_ASSET_NOT_FOUND: { httpStatus: 404, domain: 'NOT_FOUND', retryable: false, message: '资产文件不存在' },
  E_JOB_NOT_FOUND: { httpStatus: 404, domain: 'NOT_FOUND', retryable: false, message: '任务不存在' },
  E_PACKAGE_NOT_FOUND: { httpStatus: 404, domain: 'NOT_FOUND', retryable: false, message: '产物包不存在' },
  E_ROUTE_NOT_FOUND: { httpStatus: 404, domain: 'NOT_FOUND', retryable: false, message: '接口不存在' },
  E_PROVIDER_NOT_FOUND: { httpStatus: 404, domain: 'NOT_FOUND', retryable: false, message: '提供方未注册' },

  E_JOB_NOT_CANCELABLE: { httpStatus: 409, domain: 'CONFLICT', retryable: false, message: '任务当前状态不可取消' },
  E_JOB_ALREADY_RUNNING: { httpStatus: 409, domain: 'CONFLICT', retryable: false, message: '任务正在执行中' },
  E_STAGE_PRECHECK_FAILED: { httpStatus: 409, domain: 'CONFLICT', retryable: false, message: '打包前置校验未通过' },

  // ---- 配额与限流 ----
  E_LIMIT_QUEUE_FULL: { httpStatus: 429, domain: 'LIMIT', retryable: true, message: '任务队列已满' },
  E_LIMIT_PAYLOAD_TOO_LARGE: { httpStatus: 413, domain: 'LIMIT', retryable: false, message: '上传体积超限' },
  E_LIMIT_BATCH_TOO_LARGE: { httpStatus: 422, domain: 'LIMIT', retryable: false, message: '批次数量超限' },

  // ---- IO ----
  E_IO_READ_FAILED: { httpStatus: 500, domain: 'IO', retryable: true, message: '文件读取失败' },
  E_IO_WRITE_FAILED: { httpStatus: 500, domain: 'IO', retryable: true, message: '文件写入失败' },
  E_IO_DISK_FULL: { httpStatus: 507, domain: 'IO', retryable: true, message: '磁盘空间不足' },

  // ---- 格式 ----
  E_FORMAT_UNSUPPORTED: { httpStatus: 415, domain: 'FORMAT', retryable: false, message: '不支持的格式' },
  E_FORMAT_DECODE_FAILED: { httpStatus: 422, domain: 'FORMAT', retryable: false, message: '图像解码失败（文件可能损坏）' },
  E_FORMAT_ENCODE_FAILED: { httpStatus: 500, domain: 'FORMAT', retryable: true, message: '图像编码失败' },
  E_FORMAT_TOO_SMALL: { httpStatus: 422, domain: 'FORMAT', retryable: false, message: '图像尺寸小于下限' },
  E_FORMAT_TOO_LARGE: { httpStatus: 422, domain: 'FORMAT', retryable: false, message: '图像尺寸超过上限' },

  // ---- 流水线 ----
  E_PIPELINE_STEP_FAILED: { httpStatus: 500, domain: 'PIPELINE', retryable: false, message: '流水线步骤执行失败' },
  E_PIPELINE_ABORTED: { httpStatus: 499, domain: 'PIPELINE', retryable: false, message: '任务已被取消' },
  E_NAMING_RULE_INVALID: { httpStatus: 400, domain: 'PIPELINE', retryable: false, message: '命名规范表达式非法' },

  // ---- 外部提供方 ----
  E_PROVIDER_TIMEOUT: { httpStatus: 504, domain: 'PROVIDER', retryable: true, message: '提供方响应超时' },
  E_PROVIDER_UNAVAILABLE: { httpStatus: 502, domain: 'PROVIDER', retryable: true, message: '提供方不可用' },
  E_PROVIDER_AUTH: { httpStatus: 502, domain: 'PROVIDER', retryable: false, message: '提供方鉴权失败，请检查密钥' },
  E_PROVIDER_RATE_LIMIT: { httpStatus: 429, domain: 'PROVIDER', retryable: true, message: '提供方触发限流' },
  E_PROVIDER_BAD_RESPONSE: { httpStatus: 502, domain: 'PROVIDER', retryable: true, message: '提供方返回结构不符合契约' },
  E_PROVIDER_CONTENT_REJECTED: { httpStatus: 422, domain: 'PROVIDER', retryable: false, message: '提示词被内容安全策略拦截' },
  E_PROVIDER_QUOTA_EXCEEDED: { httpStatus: 402, domain: 'PROVIDER', retryable: false, message: '提供方额度已用尽' },
  E_PROVIDER_NOT_CONFIGURED: { httpStatus: 412, domain: 'PROVIDER', retryable: false, message: '提供方未完成配置' },

  // ---- 鉴权 ----
  E_AUTH_REQUIRED: { httpStatus: 401, domain: 'AUTH', retryable: false, message: '缺少访问令牌' },
  E_AUTH_FORBIDDEN: { httpStatus: 403, domain: 'AUTH', retryable: false, message: '令牌无权访问该资源' },
};

export function isKnownCode(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, code);
}

export function describeCode(code) {
  return ERROR_CODES[code] || ERROR_CODES.E_SYS_INTERNAL;
}

/**
 * 统一业务异常。全链路只抛这一种异常，保证错误出口唯一。
 */
export class AppError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]
   * @param {{details?:any, cause?:Error, field?:string}} [opts]
   */
  constructor(code, message, opts = {}) {
    const meta = describeCode(code);
    super(message || meta.message);
    this.name = 'AppError';
    this.code = isKnownCode(code) ? code : 'E_SYS_INTERNAL';
    this.httpStatus = meta.httpStatus;
    this.domain = meta.domain;
    this.retryable = meta.retryable;
    this.details = opts.details ?? null;
    this.field = opts.field ?? null;
    if (opts.cause) this.cause = opts.cause;
    Error.captureStackTrace?.(this, AppError);
  }

  toPayload() {
    return {
      code: this.code,
      domain: this.domain,
      message: this.message,
      retryable: this.retryable,
      field: this.field,
      details: this.details,
    };
  }
}

/** 断言助手：让校验代码保持声明式。 */
export function assert(condition, code, message, details) {
  if (!condition) throw new AppError(code, message, { details });
}

/** 把任意异常收敛为 AppError，保证错误出口唯一。 */
export function toAppError(err) {
  if (err instanceof AppError) return err;
  if (err && err.name === 'AbortError') {
    return new AppError('E_PROVIDER_TIMEOUT', '请求被中止或超时', { cause: err });
  }
  const code = err?.code;
  if (code === 'ENOSPC') return new AppError('E_IO_DISK_FULL', undefined, { cause: err });
  if (code === 'ENOENT') return new AppError('E_ASSET_NOT_FOUND', undefined, { cause: err });
  if (code === 'EACCES' || code === 'EPERM') return new AppError('E_IO_WRITE_FAILED', '文件权限不足', { cause: err });
  return new AppError('E_SYS_INTERNAL', err?.message || '服务内部错误', { cause: err });
}
