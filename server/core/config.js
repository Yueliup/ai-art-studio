/**
 * 配置中心。
 *
 * 三层覆盖：config/default.json -> config/local.json -> 环境变量（AIART_*）。
 * 提供方密钥支持 env 引用（"env:OPENAI_API_KEY"），避免把密钥写进仓库；
 * 对外输出时统一走 redactConfig，密钥只回显掩码。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');

const DEFAULTS = {
  server: { port: 8848, host: '127.0.0.1', bodyLimitMB: 256, corsOrigin: '*' },
  paths: {
    workspace: 'workspace',
    uploads: 'workspace/uploads',
    outputs: 'workspace/outputs',
    packages: 'workspace/packages',
    reports: 'workspace/reports',
    logs: 'workspace/logs',
    jobs: 'workspace/jobs.json',
  },
  queue: { concurrency: 3, maxQueueSize: 200, maxRetries: 2, baseBackoffMs: 800, jobTtlHours: 72, historyLimit: 300 },
  convert: {
    allowedInput: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'tiff', 'gif', 'bmp'],
    allowedOutput: ['png', 'jpg', 'webp', 'avif', 'tiff'],
  },
  inspect: {
    namingPreset: 'game-ui',
    minEdge: 8,
    maxEdge: 8192,
    requirePowerOfTwo: false,
    alphaPolicy: 'any',
    maxFileSizeKB: 20480,
    duplicateDistance: 4,
  },
  providers: {
    active: 'local-mock',
    definitions: {
      'local-mock': {
        label: '本地模拟渲染器',
        kind: 'mock',
        enabled: true,
        baseUrl: '',
        timeoutMs: 30000,
        maxConcurrency: 4,
        models: ['mock-diffusion-v1', 'mock-painter-v1'],
        defaults: { model: 'mock-diffusion-v1', width: 1024, height: 1024 },
      },
      'sd-webui': {
        label: 'Stable Diffusion WebUI (A1111)',
        kind: 'sdwebui',
        enabled: false,
        baseUrl: 'http://127.0.0.1:7860',
        apiKey: '',
        timeoutMs: 180000,
        maxConcurrency: 1,
        models: ['sd_xl_base_1.0', 'anything-v5'],
        defaults: { model: 'sd_xl_base_1.0', width: 1024, height: 1024, steps: 28, cfgScale: 7, sampler: 'DPM++ 2M Karras' },
      },
      comfyui: {
        label: 'ComfyUI (工作流引擎)',
        kind: 'comfyui',
        enabled: false,
        baseUrl: 'http://127.0.0.1:8188',
        apiKey: '',
        timeoutMs: 300000,
        maxConcurrency: 1,
        models: ['workflow:base_txt2img'],
        defaults: { model: 'workflow:base_txt2img', width: 1024, height: 1024, steps: 24 },
      },
      'openai-images': {
        label: 'OpenAI Images',
        kind: 'openai',
        enabled: false,
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'env:OPENAI_API_KEY',
        timeoutMs: 120000,
        maxConcurrency: 4,
        models: ['gpt-image-1', 'dall-e-3'],
        defaults: { model: 'gpt-image-1', width: 1024, height: 1024 },
      },
      dashscope: {
        label: '阿里云百炼 · 通义万相',
        kind: 'dashscope',
        enabled: false,
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
        apiKey: 'env:DASHSCOPE_API_KEY',
        timeoutMs: 120000,
        maxConcurrency: 4,
        models: ['wanx2.1-t2i-turbo', 'wanx2.1-t2i-plus'],
        defaults: { model: 'wanx2.1-t2i-turbo', width: 1024, height: 1024 },
      },
      volcengine: {
        label: '火山引擎 · 即梦 AI',
        kind: 'volcengine',
        enabled: false,
        baseUrl: 'https://visual.volcengineapi.com',
        apiKey: 'env:ARK_API_KEY',
        timeoutMs: 120000,
        maxConcurrency: 2,
        models: ['jimeng-high-aes', 'jimeng-2.1'],
        defaults: { model: 'jimeng-2.1', width: 1024, height: 1024 },
      },
    },
  },
  auth: { token: '' },
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k] || {}, v) : v;
  }
  return out;
}

function readJsonIfExists(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function applyEnv(cfg, env) {
  const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
  if (env.AIART_PORT) cfg.server.port = num(env.AIART_PORT, cfg.server.port);
  if (env.AIART_HOST) cfg.server.host = env.AIART_HOST;
  if (env.AIART_WORKSPACE) cfg.paths.workspace = env.AIART_WORKSPACE;
  if (env.AIART_CONCURRENCY) cfg.queue.concurrency = num(env.AIART_CONCURRENCY, cfg.queue.concurrency);
  if (env.AIART_LOG_LEVEL) cfg.log = { ...(cfg.log || {}), level: env.AIART_LOG_LEVEL };
  if (env.AIART_AUTH_TOKEN) cfg.auth.token = env.AIART_AUTH_TOKEN;
  if (env.AIART_ACTIVE_PROVIDER) cfg.providers.active = env.AIART_ACTIVE_PROVIDER;
  return cfg;
}

export const CONFIG_FILE = path.join(ROOT, 'config', 'default.json');

const fileCfg = readJsonIfExists(CONFIG_FILE);
let config = applyEnv(deepMerge(DEFAULTS, fileCfg), process.env);

/** 解析 "env:VAR" 形式的密钥引用。 */
export function resolveSecret(value) {
  if (typeof value !== 'string') return value;
  if (value.startsWith('env:')) return process.env[value.slice(4)] || '';
  return value;
}

export function getConfig() {
  return config;
}

export function reloadConfig() {
  const patched = readJsonIfExists(CONFIG_FILE);
  config = applyEnv(deepMerge(DEFAULTS, patched), process.env);
  return config;
}

export function updateConfig(patch) {
  const next = deepMerge(config, patch);
  config = next;
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(stripRuntime(config), null, 2), 'utf8');
  return config;
}

function stripRuntime(cfg) {
  return JSON.parse(JSON.stringify(cfg));
}

/** 对外输出时脱敏：密钥只保留尾部 4 位。 */
export function redactConfig(cfg = config) {
  const cloned = JSON.parse(JSON.stringify(cfg, (k, v) => (k === 'apiKey' ? undefined : v)));
  for (const [id, def] of Object.entries(cfg.providers.definitions)) {
    cloned.providers.definitions[id].hasKey = Boolean(resolveSecret(def.apiKey));
    cloned.providers.definitions[id].keyHint = maskSecret(resolveSecret(def.apiKey));
    cloned.providers.definitions[id].resolvedBaseUrl = def.baseUrl || '';
  }
  return cloned;
}

export function maskSecret(secret) {
  if (!secret) return '';
  if (secret.length <= 4) return '****';
  return `${'*'.repeat(Math.min(8, secret.length - 4))}${secret.slice(-4)}`;
}

export function absPath(...parts) {
  const base = path.isAbsolute(config.paths.workspace) ? config.paths.workspace : path.join(ROOT, config.paths.workspace);
  return path.join(base, ...parts);
}

/** 启动时确保工作目录齐备。 */
export function ensureDirs() {
  for (const key of ['workspace', 'uploads', 'outputs', 'packages', 'reports', 'logs']) {
    const p = config.paths[key];
    if (!p) continue;
    fs.mkdirSync(path.isAbsolute(p) ? p : path.join(ROOT, p), { recursive: true });
  }
  fs.mkdirSync(path.join(ROOT, 'config'), { recursive: true });
  return config;
}

export { deepMerge };
