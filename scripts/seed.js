/**
 * 样例资产生成器。
 *
 * 刻意包含「合规」与「不合规」两类样本，用于演示资产检查的检出能力：
 *  - 合规样本：符合 game-ui 规范、带透明通道、命名规范
 *  - 大写/中文/禁用词/超长：命名规范类问题
 *  - 纯色空白、极小尺寸、被截断的损坏文件：完整性类问题
 *  - 内容重复：感知哈希去重
 *
 * 用法：node scripts/seed.js
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'workspace', 'uploads', 'sample-assets');

function gradientSvg(w, h, c1, c2, seed = 1) {
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <circle cx="${w * 0.35}" cy="${h * 0.4}" r="${Math.min(w, h) * 0.22}" fill="rgba(255,255,255,.55)"/>
  <rect x="${w * 0.55}" y="${h * 0.55}" width="${w * 0.28}" height="${h * 0.28}" fill="rgba(0,0,0,.25)" transform="rotate(${seed * 12} ${w * 0.69} ${h * 0.69})"/>
</svg>`;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const created = [];

  const write = async (name, buf) => {
    fs.writeFileSync(path.join(OUT, name), buf);
    created.push({ name, bytes: buf.length });
  };

  // ---- 合规样本 ----
  await write(
    'icon_fire_normal_512x512.png',
    await sharp(Buffer.from(gradientSvg(512, 512, '#ff8a4c', '#d6336c', 1))).png({ compressionLevel: 9 }).toBuffer()
  );
  await write(
    'icon_ice_normal_512x512.png',
    await sharp(Buffer.from(gradientSvg(512, 512, '#2e86ab', '#09254a', 2))).png({ compressionLevel: 9 }).toBuffer()
  );
  await write(
    'icon_shield_hover_256x256.webp',
    await sharp(Buffer.from(gradientSvg(256, 256, '#68a85c', '#0c282c', 3))).webp({ quality: 88 }).toBuffer()
  );

  // ---- 命名规范问题样本 ----
  await write(
    'ICON_Water_512x512.png',
    await sharp(Buffer.from(gradientSvg(512, 512, '#9c84ff', '#60d6ff', 4))).png().toBuffer()
  );
  await write(
    '图标_最终版.png',
    await sharp(Buffer.from(gradientSvg(256, 256, '#b0bec5', '#263238', 5))).png().toBuffer()
  );
  await write(
    'icon_test_temp_512x512.png',
    await sharp(Buffer.from(gradientSvg(512, 512, '#f7dbb0', '#8c583e', 6))).png().toBuffer()
  );
  await write(
    'icon_arcane_normal_with_a_very_long_suffix_that_exceeds_the_limit_512x512.png',
    await sharp(Buffer.from(gradientSvg(512, 512, '#ff3d81', '#16163d', 7))).png().toBuffer()
  );

  // ---- 完整性问题样本 ----
  // 纯色空白（导出失败典型）
  await write('icon_blank_normal_512x512.png', await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer());
  // 极小尺寸
  await write('icon_tiny_normal_4x4.png', await sharp(Buffer.from(gradientSvg(4, 4, '#ff0000', '#0000ff', 8))).png().toBuffer());
  // 内容重复（与 icon_fire 同图不同名）
  await write(
    'icon_fire_copy_512x512.png',
    await sharp(Buffer.from(gradientSvg(512, 512, '#ff8a4c', '#d6336c', 1))).png({ compressionLevel: 9 }).toBuffer()
  );
  // 被截断的损坏文件：元数据还能读，像素数据不全
  const goodPng = await sharp(Buffer.from(gradientSvg(512, 512, '#2e86ab', '#09254a', 9))).png().toBuffer();
  await write('icon_broken_normal_512x512.png', goodPng.subarray(0, Math.floor(goodPng.length * 0.45)));
  // JPG 伪装成 png 扩展名 / 无透明通道
  await write(
    'icon_opaque_normal_512x512.png',
    await sharp(Buffer.from(gradientSvg(512, 512, '#ffb3d1', '#6088ff', 10))).jpeg({ quality: 90 }).toBuffer()
  );

  const totalBytes = created.reduce((s, c) => s + c.bytes, 0);
  console.log(`\n样例资产已生成：${created.length} 个文件 → ${OUT}`);
  console.log(`合计 ${(totalBytes / 1024).toFixed(1)} KB\n`);
  for (const c of created) console.log(`  ${c.name.padEnd(64)} ${(c.bytes / 1024).toFixed(1)} KB`);
  console.log('\n提示：在控制台「资产检查」页把输入源切到「工作区目录」，子目录填 uploads/sample-assets，即可看到检出效果。\n');
}

main().catch((err) => {
  console.error('生成样例资产失败：', err);
  process.exit(1);
});
