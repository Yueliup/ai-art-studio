/** 通用工具：ID、时间、数值、哈希。 */

import crypto from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 单调递增 + 随机后缀，保证同一毫秒内也不冲突。 */
let counter = Math.floor(Math.random() * 1296);
export function ulid(prefix = '') {
  counter = (counter + 1) % 1296;
  const ts = Date.now().toString(36);
  const rand = Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  const tail = counter.toString(36).padStart(2, '0');
  return `${prefix ? `${prefix}_` : ''}${ts}${tail}${rand}`;
}

export const newJobId = () => ulid('job');
export const newTraceId = () => ulid('tr');
export const newPackageId = () => ulid('pkg');

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function shortHash(buf, len = 12) {
  return sha256(buf).slice(0, len);
}

export function nowIso() {
  return new Date().toISOString();
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export function sanitizeFilename(name, fallback = 'untitled') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\.+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

/** 在目标目录下产生不冲突的文件名：a.png -> a-1.png。 */
export function uniqueName(dir, filename, existsFn, joinFn) {
  const join = joinFn || ((d, f) => `${d.replace(/[\\/]$/, '')}/${f}`);
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  let candidate = filename;
  let i = 1;
  while (existsFn(join(dir, candidate))) {
    candidate = `${stem}-${i}${ext}`;
    i += 1;
  }
  return candidate;
}

export function pct(part, total) {
  if (!total) return 0;
  return clamp(Math.round((part / total) * 100), 0, 100);
}

/** 把矩阵参数展开成任务项列表：cartesian({a:[1,2]}, {b:[3,4]}) */
export function cartesian(dimensions = {}) {
  const keys = Object.keys(dimensions);
  if (!keys.length) return [{}];
  return keys.reduce((acc, key) => {
    const values = Array.isArray(dimensions[key]) ? dimensions[key] : [dimensions[key]];
    return acc.flatMap((combo) => values.map((v) => ({ ...combo, [key]: v })));
  }, [{}]);
}

/** 简单确定性伪随机（种子一致则序列一致），供本地模拟渲染器使用。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}
