/**
 * 控制台界面截图（用于交付验收留档，非运行时依赖）。
 * 用系统已安装的 Chrome，headless 渲染本地控制台各视图。
 *
 * 用法：node scripts/shots.mjs [baseUrl] [outDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright-core/index.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8848';
const OUT = process.argv[3] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'workspace', 'shots');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const VIEWS = [
  ['dashboard', '总览看板'],
  ['delivery', '一键全链路交付'],
  ['generate', '批量生成'],
  ['convert', '格式转换'],
  ['inspect', '命名与资产检查'],
  ['providers', 'AI 提供方'],
  ['jobs', '任务中心'],
  ['packages', '交付包'],
  ['assets', '资产库'],
  ['system', '系统与接口'],
];

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  const shots = [];
  for (const [view, label] of VIEWS) {
    await page.goto(`${BASE}/#${view}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const file = path.join(OUT, `${view}.png`);
    await page.screenshot({ path: file });
    shots.push({ view, label, file, bytes: fs.statSync(file).size });
    process.stdout.write(`  ✓ ${label.padEnd(14)} → ${path.basename(file)}  ${(fs.statSync(file).size / 1024).toFixed(0)}KB\n`);
  }

  // 任务详情抽屉：挑一个成功任务
  await page.goto(`${BASE}/#jobs`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);
  const row = page.locator('#jobsTable tbody tr').first();
  if (await row.count()) {
    await row.click();
    await page.waitForTimeout(1400);
    const file = path.join(OUT, 'job-drawer.png');
    await page.screenshot({ path: file });
    shots.push({ view: 'job-drawer', label: '任务详情', file, bytes: fs.statSync(file).size });
    process.stdout.write(`  ✓ 任务详情抽屉 → job-drawer.png\n`);
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ base: BASE, capturedAt: new Date().toISOString(), shots, errors }, null, 2));
  console.log(`\n共 ${shots.length} 张，输出目录：${OUT}`);
  console.log(`页面 JS 错误：${errors.length ? errors.slice(0, 5).join(' | ') : '无'}`);
};

main().catch((err) => {
  console.error('截图失败：', err.message);
  process.exit(1);
});
