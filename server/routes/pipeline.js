/**
 * 流水线接口：批量生成 / 格式转换 / 资产检查 / 一键全链路交付 / 打包。
 *
 * 统一约定：
 *  - 提交类接口一律「立即返回任务快照 + 202」，真正的执行在队列里异步进行，
 *    前端通过 SSE 订阅 /api/jobs/:id/events 拿进度，避免长连接被网关掐断；
 *  - 所有接口的错误都在响应信封的 code 字段里可判定，前端无需解析 message。
 */

import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import { jobQueue } from '../core/queue.js';
import { withWorkspacePath } from '../core/store.js';
import { absPath } from '../core/config.js';
import { newJobId } from '../util/misc.js';
import { runGenerate, planItems, predictFilenames } from '../pipeline/generate.js';
import { convertAssets } from '../pipeline/convert.js';
import { inspectAssets, DEFAULT_RULES } from '../pipeline/inspect.js';
import { packAssets } from '../pipeline/pack.js';
import { planRename, getPreset } from '../pipeline/naming.js';
import { resolveInputFiles, pickPayload } from './inputs.js';
import { providers } from '../adapters/index.js';

const OUTPUT_ROOT = () => absPath('outputs');
const PACKAGE_ROOT = () => absPath('packages');

/** 为新任务创建一个带时间戳的输出目录，保证不同任务产物天然隔离。 */
function jobOutputDir(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const dir = path.join(OUTPUT_ROOT(), `${prefix}_${stamp}_${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function registerPipelineRoutes(router) {
  // ---------------------------------------------------------------- 生成计划预演
  router.post('/api/generate/plan', async (ctx) => {
    const payload = pickPayload(ctx);
    const plan = planItems(payload);
    const adapter = providers.get(payload.providerId || providers.activeId);
    const estimated = plan.totalImages * Math.max(1200, (adapter.timeoutMs || 30000) / 10);
    const predicted = predictFilenames(plan.items, plan.ruleset, payload.naming?.tokens || {});
    return {
      items: plan.items,
      totalImages: plan.totalImages,
      matrixDims: plan.matrixDims,
      prompts: plan.prompts,
      providerId: adapter.id,
      providerLabel: adapter.label,
      ruleset: { id: plan.ruleset.id, label: plan.ruleset.label, pattern: plan.ruleset.pattern },
      preview: plan.items.slice(0, 8).map((i, idx) => ({
        label: i.label,
        prompt: i.prompt.slice(0, 120),
        size: `${i.width}x${i.height}`,
        batchSize: i.batchSize,
        fileName: predicted[idx],
      })),
      estimate: { images: plan.totalImages, queueSeconds: Math.round(estimated / 1000), note: '按经验值粗估，实际受提供方并发与算力影响' },
    };
  });

  // ---------------------------------------------------------------- 批量生成
  router.post('/api/generate', async (ctx) => {
    const payload = pickPayload(ctx);
    const plan = planItems(payload);
    const providerId = payload.providerId || providers.activeId;
    const adapter = providers.get(providerId);
    if (adapter.def.enabled === false) {
      throw new AppError('E_PROVIDER_NOT_CONFIGURED', `提供方「${adapter.label}」当前为禁用状态，请先在「提供方」页启用或切换`, {
        details: { providerId, hint: '也可将 active 切到 local-mock 做本地联调' },
      });
    }

    const outDir = jobOutputDir('gen');
    const jobId = newJobId();
    const job = jobQueue.enqueue(
      {
        id: jobId,
        name: payload.name || `批量生成 · ${plan.prompts} 提示词 × ${plan.totalImages} 张`,
        kind: 'generate',
        providerId,
        traceId: ctx.traceId,
        requestedBy: ctx.headers_user || 'local',
        payload: { total: plan.totalImages, plannedItems: plan.items.length, providerId, outDir },
      },
      async (jctx) => {
        const { results, summary, counts } = await runGenerate(payload, { ...jctx, outDir });
        return { counts, result: { summary, outDir, results: results.slice(0, 50) } };
      }
    );

    return withAccepted(job, { planned: plan, outDir });
  });

  // ---------------------------------------------------------------- 格式转换
  router.post('/api/convert', async (ctx) => {
    const payload = pickPayload(ctx, { format: 'webp', quality: 85 });
    const input = resolveInputFiles(ctx, payload.inputSpec || { source: payload.source || 'upload' });
    if (input.warnings.length) ctx.locals.warnings = input.warnings;

    const outDir = jobOutputDir('conv');
    const jobId = newJobId();
    const job = jobQueue.enqueue(
      {
        id: jobId,
        name: payload.name || `格式转换 · ${input.files.length} 个资产 → ${String(payload.format || 'webp').toUpperCase()}`,
        kind: 'convert',
        traceId: ctx.traceId,
        payload: { total: input.files.length, origin: input.origin, outDir, format: payload.format },
      },
      async (jctx) => {
        const res = await convertAssets(input.files, outDir, payload, {
          ...jctx,
          onOutput: (o) => {
            jctx.onArtifact({
              id: o.relPath,
              type: 'image',
              file: o.file,
              relPath: o.relPath,
              path: o.path,
              bytes: o.bytes,
              bytesText: o.bytesText,
              width: o.width,
              height: o.height,
              format: o.format,
              variant: o.variant,
              source: 'convert',
            });
          },
        });
        return {
          counts: res.counts,
          result: {
            savings: res.savings,
            durationMs: res.durationMs,
            format: res.format,
            failures: res.results.filter((r) => r.status === 'failed').slice(0, 30),
          },
        };
      }
    );
    return withAccepted(job, { files: input.files.length, origin: input.origin, outDir });
  });

  // ---------------------------------------------------------------- 资产检查
  router.post('/api/assets/inspect', async (ctx) => {
    const payload = pickPayload(ctx, { namingPreset: 'game-ui' });
    const input = resolveInputFiles(ctx, payload.inputSpec || { source: payload.source || 'upload' });
    const rules = { ...DEFAULT_RULES, ...(payload.rules || {}), namingPreset: payload.rules?.namingPreset || payload.namingPreset || 'game-ui' };

    const jobId = newJobId();
    const job = jobQueue.enqueue(
      {
        id: jobId,
        name: payload.name || `资产检查 · ${input.files.length} 个资产`,
        kind: 'inspect',
        traceId: ctx.traceId,
        payload: { total: input.files.length, origin: input.origin, ruleset: rules.namingPreset },
      },
      async (jctx) => {
        const { results, summary, duplicates, ruleset } = await inspectAssets(input.files, rules, jctx);
        return {
          counts: { total: input.files.length, succeeded: summary.passed, failed: summary.failed, skipped: 0 },
          result: {
            summary,
            duplicates: duplicates.slice(0, 50),
            ruleset: { id: ruleset.id, label: ruleset.label, pattern: ruleset.pattern },
            origin: input.origin,
            // 逐结果附上「相对工作区根」的路径，前端据此安全地取缩略图（不外传服务器绝对路径）
            results: results.map((r, i) => ({
              fileName: r.fileName,
              relPath: r.relPath,
              ok: r.ok,
              score: r.score,
              meta: r.meta,
              findings: r.findings,
              workspacePath: withWorkspacePath({ path: input.files[i]?.path }).workspacePath,
            })),
          },
        };
      }
    );
    return withAccepted(job, { files: input.files.length, origin: input.origin });
  });

  // ---------------------------------------------------------------- 命名重命名（同步，无 IO 风险）
  router.post('/api/assets/rename-plan', async (ctx) => {
    const payload = pickPayload(ctx);
    let names = payload.filenames || [];
    if (!names.length) {
      const input = resolveInputFiles(ctx, payload.inputSpec || { source: payload.source || 'workspace', subdir: 'outputs' }, );
      names = input.files.map((f) => f.relPath.split('/').pop());
    }
    const ruleset = payload.customRules || getPreset(payload.preset || 'game-ui');
    if (!ruleset) throw new AppError('E_NAMING_RULE_INVALID', `规范集「${payload.preset}」不存在`);
    const plan = planRename(names.map((n) => ({ name: n })), ruleset, payload.metaByFile || {});
    const conflicts = plan.filter((p) => p.changed && plan.some((q) => q !== p && q.to === p.to));
    return {
      preset: { id: ruleset.id, label: ruleset.label, pattern: ruleset.pattern, case: ruleset.case },
      plan,
      summary: {
        total: plan.length,
        needRename: plan.filter((p) => p.changed).length,
        valid: plan.filter((p) => p.currentValid).length,
        conflicts: conflicts.length,
      },
    };
  });

  // ---------------------------------------------------------------- 打包
  router.post('/api/packages', async (ctx) => {
    const payload = pickPayload(ctx, { packageName: 'ai-art-delivery' });
    const spec = payload.inputSpec || { source: payload.source || 'job' };
    const input = resolveInputFiles(ctx, spec);

    // 允许只挑部分产物打包（例如只交付质检通过的）
    let files = input.files;
    if (payload.onlyPassed && Array.isArray(payload.passedRelPaths)) {
      const keep = new Set(payload.passedRelPaths);
      files = files.filter((f) => keep.has(f.relPath));
    }

    const outDir = PACKAGE_ROOT();
    const jobId = newJobId();
    const job = jobQueue.enqueue(
      {
        id: jobId,
        name: payload.name || `打包交付 · ${payload.packageName || 'delivery'} ${payload.version || 'v1.0.0'}（${files.length} 项）`,
        kind: 'pack',
        traceId: ctx.traceId,
        payload: { total: files.length, origin: input.origin, outDir },
      },
      async (jctx) => {
        const res = await packAssets({ ...payload, files }, { ...jctx, outDir });
        jctx.onArtifact({
          id: res.package.id,
          type: 'package',
          file: res.package.file,
          relPath: res.package.relPath,
          path: res.package.path,
          bytes: res.package.bytes,
          bytesText: res.package.bytesText,
          sha256: res.package.sha256,
          assetCount: res.package.assetCount,
          source: 'pack',
        });
        return {
          counts: res.counts,
          result: {
            package: res.package,
            precheck: res.precheck ? { summary: res.precheck.summary, blocked: res.precheck.blocked } : null,
          },
        };
      }
    );
    return withAccepted(job, { files: files.length, origin: input.origin });
  });

  // ---------------------------------------------------------------- 一键全链路交付
  router.post('/api/pipeline/delivery', async (ctx) => {
    const payload = pickPayload(ctx);
    const plan = planItems(payload.generate || payload);
    const providerId = (payload.generate || payload).providerId || providers.activeId;
    const adapter = providers.get(providerId);
    if (adapter.def.enabled === false) {
      throw new AppError('E_PROVIDER_NOT_CONFIGURED', `提供方「${adapter.label}」当前为禁用状态`);
    }

    const outDir = jobOutputDir('deliver');
    const jobId = newJobId();
    const stages = [];

    const job = jobQueue.enqueue(
      {
        id: jobId,
        name: payload.name || `一键交付 · ${plan.totalImages} 张资产（生成→转换→质检→打包）`,
        kind: 'delivery',
        providerId,
        traceId: ctx.traceId,
        payload: { total: plan.totalImages, outDir, stages: ['生成', '格式转换', '资产检查', '打包'] },
      },
      async (jctx) => {
        // 阶段权重：生成 62% / 转换 14% / 质检 16% / 打包 8%
        const gen = await runGenerate(payload.generate || payload, {
          ...jctx,
          outDir,
          onProgress: (p, s) => jctx.onProgress(p * 0.62, `[1/4 生成] ${s}`),
        });
        if (!gen.artifacts.length) {
          throw new AppError('E_PIPELINE_STEP_FAILED', '生成阶段未产出任何资产，后续阶段已终止', { details: { byCode: gen.summary.byCode } });
        }
        stages.push({ stage: '生成', ok: true, produced: gen.artifacts.length, summary: gen.summary });

        // 2. 转换
        let outputs = gen.artifacts.map((a) => ({ path: a.path, relPath: a.relPath }));
        let convSummary = null;
        if (payload.convert) {
          const conv = await convertAssets(outputs, outDir, payload.convert, {
            ...jctx,
            onProgress: (p, s) => jctx.onProgress(62 + p * 0.14, `[2/4 转换] ${s}`),
            onOutput: (o) => {
              jctx.onArtifact({
                id: o.relPath,
                type: 'image',
                file: o.file,
                relPath: o.relPath,
                path: o.path,
                bytes: o.bytes,
                bytesText: o.bytesText,
                width: o.width,
                height: o.height,
                format: o.format,
                variant: o.variant,
                source: 'convert',
              });
            },
          });
          convSummary = { counts: conv.counts, savings: conv.savings };
          outputs = conv.outputs.map((o) => ({ path: o.path, relPath: o.relPath }));
          stages.push({ stage: '格式转换', ok: conv.counts.failed === 0, produced: outputs.length, summary: convSummary });
        } else {
          stages.push({ stage: '格式转换', ok: true, skipped: true, produced: outputs.length });
        }

        // 3. 质检
        const qa = await inspectAssets(outputs, { ...DEFAULT_RULES, ...(payload.inspect || {}) }, {
          signal: jctx.signal,
          onProgress: (p, s) => jctx.onProgress?.(76 + p * 0.16, `[3/4 质检] ${s}`),
        });
        stages.push({ stage: '资产检查', ok: qa.summary.failed === 0, produced: qa.summary.passed, summary: qa.summary });

        const blocked = qa.results.filter((r) => !r.ok).map((r) => r.relPath || r.fileName);
        const strict = payload.pack?.precheck?.strict;
        if (strict && blocked.length) {
          throw new AppError('E_STAGE_PRECHECK_FAILED', `质检发现 ${blocked.length} 个问题资产，严格模式下终止交付`, {
            details: { blocked: blocked.slice(0, 20), byRule: qa.summary.byRule },
          });
        }

        // 4. 打包
        const packInput = {
          ...(payload.pack || {}),
          packageName: payload.pack?.packageName || 'ai-art-delivery',
          files: outputs,
          precheck: { enabled: true, strict: false, ...(payload.pack?.precheck || {}) },
        };
        const packed = await packAssets(packInput, {
          ...jctx,
          outDir: PACKAGE_ROOT(),
          onProgress: (p, s) => jctx.onProgress(92 + p * 0.08, `[4/4 打包] ${s}`),
        });
        jctx.onArtifact({
          id: packed.package.id,
          type: 'package',
          file: packed.package.file,
          relPath: packed.package.relPath,
          path: packed.package.path,
          bytes: packed.package.bytes,
          bytesText: packed.package.bytesText,
          sha256: packed.package.sha256,
          assetCount: packed.package.assetCount,
          source: 'pack',
        });
        stages.push({ stage: '打包', ok: true, produced: packed.package.assetCount, summary: { package: packed.package } });

        const totalFailed = (gen.summary.failedItems || 0) + (convSummary?.counts.failed || 0) + qa.summary.failed;
        return {
          counts: { total: plan.totalImages, succeeded: packed.package.assetCount, failed: Math.max(0, plan.totalImages - packed.package.assetCount), skipped: 0 },
          result: {
            stages,
            generate: gen.summary,
            convert: convSummary,
            inspect: { summary: qa.summary, topIssues: qa.summary.byRule.slice(0, 10) },
            package: packed.package,
            outDir,
            totalIssues: totalFailed,
          },
        };
      }
    );

    return withAccepted(job, { planned: plan, outDir });
  });
}

function withAccepted(job, extra = {}) {
  return {
    accepted: true,
    job,
    subscribe: `/api/jobs/${job.id}/events`,
    detail: `/api/jobs/${job.id}`,
    ...extra,
  };
}

export { jobOutputDir };
