/**
 * 命名规范引擎。
 *
 * 把「美术资源命名规范」从口头约定变成可执行、可校验、可自动修复的机器可读规则。
 *
 * 规则采用 token 模板 + 约束集两层：
 *   pattern: "{category}_{name}_{state}_{w}x{h}.{ext}"   —— 结构（顺序与必需 token）
 *   约束集: 大小写 / 分隔符 / 长度 / 允许值域 / 禁用词 / 字符集 —— 内容
 *
 * 校验产出 Finding[]，自动修复产出 canonical name。
 * 设计上刻意不引入正则回溯风险：token 模式统一转成惰性分组，且长度受限。
 */

import { AppError } from '../core/errors.js';

export const TOKEN_PATTERN = /\{([a-z][a-z0-9_]*)(?::(\d+))?\}/g;

/** 内置规范集：覆盖游戏 UI / 宣传物料 / 角色立绘三类典型场景。 */
export const PRESETS = {
  'game-ui': {
    id: 'game-ui',
    label: '游戏 UI 图标规范 v2',
    description: '适用于图标、按钮、底板等 UI 切图，强调可搜索与多语言安全（禁中文、禁大写）',
    pattern: '{category}_{name}_{state}_{w}x{h}.{ext}',
    separator: '_',
    case: 'snake',
    allowedCategories: ['icon', 'btn', 'bg', 'panel', 'fx', 'avatar', 'frame', 'badge'],
    allowedExtensions: ['png', 'webp'],
    requiredTokens: ['category', 'name', 'w', 'h'],
    optionalTokens: ['state'],
    tokenRules: {
      category: { pattern: '^[a-z]{2,12}$', description: '全小写英文品类词，2-12 位' },
      name: { pattern: '^[a-z0-9]{2,24}$', description: '全小写英文/数字，2-24 位' },
      state: { pattern: '^[a-z]{2,12}$', description: '状态词（normal/hover/disabled…）' },
      w: { pattern: '^\\d{2,5}$', description: '宽度像素' },
      h: { pattern: '^\\d{2,5}$', description: '高度像素' },
      ext: { pattern: '^(png|webp)$', description: '仅允许 png / webp' },
    },
    forbiddenWords: ['final', 'copy', 'new', 'test', 'tmp', 'temp', 'untitled', '副本', '未命名', '新建', '最终'],
    forbiddenChars: '[\\u4e00-\\u9fa5\\s]',
    maxLength: 64,
    minLength: 9,
  },
  'marketing-kv': {
    id: 'marketing-kv',
    label: '宣传物料规范 v1',
    description: '适用于 KV / Banner / 投放素材，强制携带渠道与尺寸，便于归因',
    pattern: '{channel}_{campaign}_{w}x{h}_{version}.{ext}',
    separator: '_',
    case: 'kebab',
    allowedCategories: [],
    allowedExtensions: ['jpg', 'png', 'webp'],
    requiredTokens: ['channel', 'campaign', 'w', 'h', 'version'],
    optionalTokens: [],
    tokenRules: {
      channel: { pattern: '^(app|web|h5|ios|android|douyin|wechat|official)$', description: '投放渠道枚举' },
      campaign: { pattern: '^[a-z0-9-]{3,32}$', description: '活动标识 kebab-case' },
      w: { pattern: '^\\d{3,5}$' },
      h: { pattern: '^\\d{3,5}$' },
      version: { pattern: '^v\\d{1,3}(-\\d{1,3})?$', description: '形如 v1 或 v1-2' },
      ext: { pattern: '^(jpg|png|webp)$' },
    },
    forbiddenWords: ['final', 'finalfinal', 'ok', 'good', 'copy', '副本', '最新'],
    forbiddenChars: '[\\u4e00-\\u9fa5\\s]',
    maxLength: 80,
    minLength: 12,
  },
  'character-art': {
    id: 'character-art',
    label: '角色立绘规范 v1',
    description: '适用于角色立绘与皮肤，强制角色/皮肤/视图三段式，便于资产库检索',
    pattern: '{character}_{skin}_{view}_{w}x{h}.{ext}',
    separator: '_',
    case: 'snake',
    allowedCategories: [],
    allowedExtensions: ['png', 'webp', 'psd'],
    requiredTokens: ['character', 'skin', 'view', 'w', 'h'],
    optionalTokens: [],
    tokenRules: {
      character: { pattern: '^[a-z]{2,20}$' },
      skin: { pattern: '^[a-z0-9]{2,20}$' },
      view: { pattern: '^(front|back|side|three-quarter|half|full)$', description: '视图枚举' },
      w: { pattern: '^\\d{3,5}$' },
      h: { pattern: '^\\d{3,5}$' },
      ext: { pattern: '^(png|webp|psd)$' },
    },
    forbiddenWords: ['wip', 'draft', 'old', 'backup', '副本', '草稿'],
    forbiddenChars: '[\\u4e00-\\u9fa5\\s]',
    maxLength: 72,
    minLength: 14,
  },
  loose: {
    id: 'loose',
    label: '宽松检查（仅安全字符）',
    description: '不强制结构，只拦截中文字符、空格与危险字符，适合存量资产摸底',
    pattern: '{name}.{ext}',
    separator: '_',
    case: 'asis',
    allowedCategories: [],
    allowedExtensions: ['png', 'jpg', 'jpeg', 'webp', 'avif'],
    requiredTokens: ['name'],
    optionalTokens: ['ext'],
    tokenRules: { name: { pattern: '^[A-Za-z0-9._-]{1,60}$' }, ext: { pattern: '^[a-z0-9]{2,5}$' } },
    forbiddenWords: [],
    forbiddenChars: '[\\\\/:*?"<>|]',
    maxLength: 96,
    minLength: 3,
  },
};

export function listPresets() {
  return Object.values(PRESETS).map(({ id, label, description, pattern }) => ({ id, label, description, pattern }));
}

export function getPreset(id) {
  return PRESETS[id] || null;
}

/**
 * 把 token 模板编译成匹配正则，用于从文件名反解 token。
 *
 * 关键点：token 的字符类优先从 tokenRules 推导（而不是一律用宽松的 `.+?`），
 * 否则 `{name}` 与 `{state}` 的边界会因惰性匹配而错位 —— 例如
 * `icon_ui_icon_fire_normal_512x512` 会把 `ui` 当 name、把 `fire_normal_512` 当 w。
 * 用规则里的字符类收紧后，解析要么精确成功，要么如实报「不符合模板」，不会再给出误导性的字段报错。
 */
export function compilePattern(pattern, tokenRules = {}) {
  const tokens = [];
  let regex = '^';
  let lastIndex = 0;
  let m;
  TOKEN_PATTERN.lastIndex = 0;
  while ((m = TOKEN_PATTERN.exec(pattern))) {
    const [raw, token, maxLen] = m;
    const literal = pattern.slice(lastIndex, m.index);
    if (literal) regex += escapeRegex(literal);
    const cls = classFromRule(tokenRules[token]?.pattern) || DEFAULT_TOKEN_CLASS;
    const bounded = maxLen ? `${cls}{1,${Number(maxLen)}}` : cls;
    regex += `(${bounded})`;
    tokens.push({ token, raw, maxLen: maxLen ? Number(maxLen) : null, bounded: Boolean(classFromRule(tokenRules[token]?.pattern)) });
    lastIndex = m.index + raw.length;
  }
  const tail = pattern.slice(lastIndex);
  if (tail) regex += escapeRegex(tail);
  regex += '$';
  return { regex: new RegExp(regex), tokens };
}

const DEFAULT_TOKEN_CLASS = '[A-Za-z0-9._\\-]+';

/** 从规则的 pattern 里提取可安全内联的字符类；不确定时返回 null 走宽松兜底。 */
function classFromRule(rulePattern) {
  if (typeof rulePattern !== 'string') return null;
  const inner = rulePattern.trim().replace(/^\^/, '').replace(/\$$/, '');
  if (!inner) return null;
  if (inner.includes('(')) return null; // 含分组，内联会破坏捕获组编号
  if (/[^A-Za-z0-9[\]\-\\^$.|*+?{},]/.test(inner)) return null;
  if (inner.includes('|')) return `(?:${inner})`;
  return inner;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 由元数据生成规范文件名（自动修复 / 批量重命名用）。 */
export function buildName(ruleset, meta = {}) {
  const values = { ...meta };
  const name = ruleset.pattern.replace(TOKEN_PATTERN, (raw, token) => {
    const v = values[token];
    if (v === undefined || v === null || v === '') return '';
    return String(v);
  });
  return normalizeSeparators(name, ruleset.separator);
}

function normalizeSeparators(name, sep = '_') {
  return name
    .replace(/[-_\s]+/g, sep)
    .replace(new RegExp(`\\${sep}{2,}`, 'g'), sep)
    .replace(new RegExp(`^\\${sep}|\\${sep}$`, 'g'), '');
}

function applyCase(text, mode) {
  const parts = text.split(/[-_]/).filter(Boolean);
  switch (mode) {
    case 'snake':
    case 'kebab':
      return parts.map((p) => p.toLowerCase()).join(mode === 'snake' ? '_' : '-');
    case 'camel':
      return parts.map((p, i) => (i === 0 ? p.toLowerCase() : p[0].toUpperCase() + p.slice(1).toLowerCase())).join('');
    case 'pascal':
      return parts.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join('');
    default:
      return text;
  }
}

/**
 * 校验单个文件名。
 * @returns {{valid:boolean, tokens:object, findings:Array, canonical:string|null}}
 */
export function validateFilename(filename, ruleset, opts = {}) {
  const findings = [];
  const push = (level, rule, message, extra = {}) => findings.push({ level, rule, message, ...extra });

  if (!ruleset) throw new AppError('E_NAMING_RULE_INVALID', '命名规范集不存在');

  const dotIdx = filename.lastIndexOf('.');
  const base = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
  const ext = dotIdx > 0 ? filename.slice(dotIdx + 1) : '';

  // 1. 长度
  if (filename.length > ruleset.maxLength) {
    push('error', 'length.max', `文件名超长（${filename.length} > ${ruleset.maxLength}）`);
  }
  if (filename.length < ruleset.minLength) {
    push('warn', 'length.min', `文件名过短（${filename.length} < ${ruleset.minLength}）`);
  }

  // 2. 禁用字符
  if (ruleset.forbiddenChars) {
    const re = new RegExp(ruleset.forbiddenChars);
    const bad = filename.match(new RegExp(ruleset.forbiddenChars, 'g'));
    if (bad) push('error', 'charset.forbidden', `包含禁止字符：${[...new Set(bad)].join(' ')}`, { actual: bad.join('') });
    void re;
  }

  // 3. 禁用词
  for (const word of ruleset.forbiddenWords || []) {
    if (base.toLowerCase().includes(word.toLowerCase())) {
      push('error', 'word.forbidden', `包含禁用词「${word}」（临时/重复文件常见标记）`, { actual: word });
    }
  }

  // 4. 扩展名
  if (ruleset.allowedExtensions?.length && !ruleset.allowedExtensions.includes(ext.toLowerCase())) {
    push('error', 'ext.notAllowed', `扩展名 .${ext || '(无)'} 不在允许列表 [${ruleset.allowedExtensions.join(', ')}]`, { actual: ext });
  }

  // 5. 反解 token
  // 注意：模板里若含 {ext}，必须拿「含扩展名的完整文件名」去匹配，否则永远匹配失败。
  const { regex, tokens } = compilePattern(ruleset.pattern, ruleset.tokenRules || {});
  const expectsExt = /\{ext\}/.test(ruleset.pattern);
  let match = (expectsExt ? filename : base).match(regex);
  if (!match) match = (expectsExt ? base : filename).match(regex);
  const parsed = {};
  if (!match) {
    push('error', 'pattern.mismatch', `不符合命名模板 ${ruleset.pattern}`, { expected: ruleset.pattern, actual: filename });
  } else {
    tokens.forEach((t, i) => {
      parsed[t.token] = match[i + 1];
    });
  }
  parsed.ext = parsed.ext || ext || undefined;

  // 6. 必填 token
  for (const token of ruleset.requiredTokens || []) {
    if (!parsed[token]) push('error', 'token.missing', `缺少必需字段 {${token}}`);
  }

  // 7. 逐 token 值域
  for (const [token, rule] of Object.entries(ruleset.tokenRules || {})) {
    const value = parsed[token];
    if (value === undefined) continue;
    if (!new RegExp(rule.pattern).test(value)) {
      push('error', `token.${token}`, `字段 {${token}} = "${value}" 不合法：${rule.description || rule.pattern}`, { actual: value, expected: rule.pattern });
    }
  }

  // 8. 品类白名单
  if (ruleset.allowedCategories?.length && parsed.category && !ruleset.allowedCategories.includes(parsed.category)) {
    push('warn', 'category.notAllowed', `品类「${parsed.category}」不在白名单 [${ruleset.allowedCategories.join(', ')}]`, { actual: parsed.category });
  }

  // 9. 大小写规范
  if (ruleset.case !== 'asis') {
    const canonicalBase = applyCase(base, ruleset.case);
    if (canonicalBase !== base) {
      push(ruleset.case === 'snake' ? 'error' : 'warn', 'case.style', `不符合 ${ruleset.case} 命名风格，应为 "${canonicalBase}"`, { expected: canonicalBase, actual: base });
    }
  }

  const canonical = findings.some((f) => f.rule === 'pattern.mismatch')
    ? suggestCanonical(ruleset, parsed, { base, ext })
    : buildName(ruleset, { ...parsed, ext: ext || parsed.ext });

  return {
    valid: !findings.some((f) => f.level === 'error'),
    tokens: parsed,
    findings,
    canonical,
  };
}

/** 从残缺信息里尽力拼出一个规范名，用于「一键修复建议」。 */
function suggestCanonical(ruleset, parsed, { base, ext }) {
  const parts = base.split(/[-_\s]+/).filter(Boolean);
  const values = { ...parsed, ext: ext || 'png' };
  if (!values.name) values.name = parts[0] || 'asset';
  if (ruleset.requiredTokens?.includes('category') && !values.category) values.category = 'icon';
  if (ruleset.requiredTokens?.includes('w') && !values.w) values.w = '512';
  if (ruleset.requiredTokens?.includes('h') && !values.h) values.h = '512';
  if (ruleset.requiredTokens?.includes('state') && !values.state) values.state = 'normal';
  const built = buildName(ruleset, values);
  const cased = ruleset.case === 'asis' ? built : applyCase(built.replace(/\.[a-z0-9]+$/i, ''), ruleset.case) + `.${values.ext}`;
  return cased.replace(/^[_-]+|[_-]+$/g, '');
}

/** 供「重命名」流程批量构造规范名（从原始文件名 + 用户补充的元数据）。 */
export function planRename(files, ruleset, metaByFile = {}) {
  return files.map((file) => {
    const result = validateFilename(file.name, ruleset);
    const meta = { ...result.tokens, ext: (file.name.split('.').pop() || 'png').toLowerCase(), ...metaByFile[file.name] };
    const target = buildName(ruleset, meta);
    return {
      from: file.name,
      to: target,
      changed: target !== file.name,
      currentValid: result.valid,
      findings: result.findings,
    };
  });
}

export { applyCase, normalizeSeparators };
