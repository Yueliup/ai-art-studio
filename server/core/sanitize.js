/**
 * 出站数据脱敏。
 *
 * 工具集内部到处都用绝对路径（产物落盘位置、输出目录、产物包位置），但**这些不该出现在
 * 任何 HTTP 响应里**：本地跑只是泄漏个人目录结构，一旦部署到公网就是明确的信息泄漏。
 *
 * 与其在每个路由里手工挑选字段（漏一个就出事），不如在响应出口统一做一次深拷贝过滤：
 * 凡「值本身是一个绝对路径字符串」的字段一律剔除，相对路径（relPath / workspacePath）照常保留。
 * 这样新增路由、新增字段时天然安全。
 *
 * 判定策略（刻意保守，避免误伤）：
 *  - URL（`http://…`）一律放行；
 *  - Windows 盘符路径 `C:\…` 与 UNC `\\host\share` 直接判定；
 *  - POSIX 路径只在命中**已知根目录**（项目根 / 家目录 / 临时目录）时判定 ——
 *    否则 `/api/jobs/xxx` 这种以 `/` 开头的相对 URL 会被误判成绝对路径。
 */

import os from 'node:os';
import { ROOT } from './config.js';

const KNOWN_ROOTS = [ROOT, os.homedir(), os.tmpdir()]
  .filter(Boolean)
  .map((p) => String(p).replace(/[\\/]+$/, '').toLowerCase());

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const UNC = /^\\\\[^\\/]+[\\/]/;

/** 判断一个字符串是否是「本机文件系统绝对路径」。 */
export function isAbsolutePath(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 4096) return false;
  if (URL_LIKE.test(value)) return false;
  if (WINDOWS_DRIVE.test(value)) return true;
  if (UNC.test(value)) return true;
  const lower = value.toLowerCase();
  return KNOWN_ROOTS.some((root) => lower === root || lower.startsWith(`${root}/`) || lower.startsWith(`${root}\\`));
}

/**
 * 递归剔除对象里的绝对路径字段。
 * @param {any} input
 * @param {{dropKeys?: string[]}} [opts] 额外强制剔除的字段名（即使值是相对路径）
 */
export function stripAbsolutePaths(input, opts = {}) {
  const dropKeys = new Set(opts.dropKeys || []);
  const walk = (value) => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return isAbsolutePath(value) ? undefined : value;
    if (Array.isArray(value)) return value.map(walk).filter((v) => v !== undefined);
    if (typeof value === 'object') {
      if (value instanceof Date) return value.toISOString();
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (dropKeys.has(k)) continue;
        const cleaned = walk(v);
        if (cleaned !== undefined) out[k] = cleaned;
      }
      return out;
    }
    return value;
  };
  return walk(input);
}

/** 产物对外表示：去掉 path，保留前端取图需要的 workspacePath。 */
export function publicArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') return artifact;
  const { path: _dropped, ...rest } = artifact;
  return stripAbsolutePaths(rest);
}
