/**
 * 演示环境启动器。
 *
 * 解决一个具体问题：空环境下直接起服务，访客点「命名与资产检查」会因为
 * `uploads/sample-assets` 不存在而直接报错 —— 而这个功能恰恰是演示的重点。
 * 所以启动前先跑一次样例资产生成（幂等，重复执行只是覆盖同样 12 个文件），
 * 再以演示模式拉起服务。
 *
 * 演示模式（AIART_DEMO=1）会：隐藏服务器目录结构、拒绝写入 API Key、配置改动不落盘。
 * 详见 README「部署为在线演示」。
 *
 * 用法：node scripts/start-demo.js
 */

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, AIART_DEMO: process.env.AIART_DEMO || '1' };

console.log('[demo] 准备样例资产（uploads/sample-assets）…');
const seed = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'seed.js')], {
  cwd: ROOT,
  stdio: 'inherit',
  env,
});
if (seed.status !== 0) {
  // 样例资产生成失败不该阻断服务启动：访客仍可使用生成/转换/打包链路
  console.warn('[demo] 样例资产生成失败，继续启动服务（资产检查需自行上传文件）');
}

console.log(`[demo] 以演示模式启动服务，PORT=${env.PORT || '(未设置，将用默认 8848)'}`);
const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  cwd: ROOT,
  stdio: 'inherit',
  env,
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code) => process.exit(code ?? 0));
