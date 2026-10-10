/**
 * 本地模拟渲染器（local-mock）。
 *
 * 存在的意义：让「批量生成 -> 格式转换 -> 资产检查 -> 打包」整条流水线在**没有外部密钥**的
 * 环境下依然可以完整跑通与验收（CI、演示、客户 POC）。它不是随机噪声，而是根据 prompt
 * 的哈希做确定性程序化渲染（渐变 + 分形噪声 + 几何构图 + 元数据水印），
 * 因此同一 prompt + seed 永远产出同一张图 —— 这一点对回归测试很关键。
 */

import sharp from 'sharp';
import { BaseAdapter } from './base.js';
import { hashString, mulberry32 } from '../util/misc.js';

const PALETTES = [
  { name: 'sunset', stops: [[255, 138, 76], [214, 51, 108], [76, 40, 130]] },
  { name: 'ocean', stops: [[46, 134, 171], [22, 78, 99], [9, 30, 66]] },
  { name: 'forest', stops: [[104, 168, 92], [38, 92, 66], [12, 40, 44]] },
  { name: 'neon', stops: [[255, 61, 129], [120, 63, 244], [22, 22, 61]] },
  { name: 'sand', stops: [[247, 219, 176], [222, 165, 116], [140, 88, 62]] },
  { name: 'steel', stops: [[176, 190, 197], [96, 125, 139], [38, 50, 56]] },
  { name: 'candy', stops: [[255, 179, 209], [156, 132, 255], [96, 214, 255]] },
];

const SHAPES = ['orb', 'grid', 'wave', 'shards', 'rings'];

export class MockAdapter extends BaseAdapter {
  get capabilities() {
    return {
      text2img: true,
      img2img: true,
      negativePrompt: true,
      seedControl: true,
      batchNative: true,
      async: false,
      maxBatchSize: 8,
      supportedSizes: ['512x512', '768x768', '1024x1024', '1536x1536', '1920x1080', '1080x1920'],
      supportedModels: this.models,
      note: '程序化确定性渲染，用于流水线联调与回归验证',
    };
  }

  buildPayload(req) {
    const seed = req.seed >= 0 ? req.seed : hashString(`${req.prompt}|${req.model}`) % 2 ** 31;
    return { ...req, seed, paletteIndex: hashString(req.prompt) % PALETTES.length };
  }

  async submit(payload, ctx = {}) {
    const images = [];
    for (let i = 0; i < payload.batchSize; i += 1) {
      ctx.signal?.throwIfAborted?.();
      await sleep(40 + (payload.steps % 60));
      images.push({
        data: await this.render(payload, payload.seed + i * 7919, i),
        mime: 'image/png',
        seed: payload.seed + i * 7919,
        meta: { renderer: 'mock', model: payload.model, palette: PALETTES[payload.paletteIndex].name },
      });
      ctx.onStep?.(i + 1, payload.batchSize);
    }
    return { images, raw: { mock: true, count: images.length } };
  }

  /** 确定性程序化渲染。 */
  async render(payload, seed, batchIndex) {
    const { width, height } = payload;
    const rnd = mulberry32(seed);
    const palette = PALETTES[(payload.paletteIndex + batchIndex) % PALETTES.length];
    const shape = SHAPES[Math.floor(rnd() * SHAPES.length)];
    const [c1, c2, c3] = palette.stops;

    const svg = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="rgb(${c1.join(',')})"/>
      <stop offset="52%" stop-color="rgb(${c2.join(',')})"/>
      <stop offset="100%" stop-color="rgb(${c3.join(',')})"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.45" r="0.62">
      <stop offset="0%" stop-color="rgba(255,255,255,${(0.34 + rnd() * 0.3).toFixed(2)})"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
    </radialGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="${(width * 0.012).toFixed(1)}"/></filter>
    <filter id="noise">
      <feTurbulence type="fractalNoise" baseFrequency="${(0.4 + rnd() * 0.6).toFixed(3)}" numOctaves="${2 + Math.floor(rnd() * 3)}" seed="${seed % 9999}"/>
      <feColorMatrix type="saturate" values="0"/>
    </filter>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  ${this.shapeLayer(shape, width, height, rnd, c1, c2, c3)}
  <rect width="100%" height="100%" fill="url(#glow)" style="mix-blend-mode:screen"/>
  <rect width="100%" height="100%" filter="url(#noise)" opacity="0.09" style="mix-blend-mode:overlay"/>
</svg>`;

    return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  }

  shapeLayer(shape, w, h, rnd, c1, c2, c3) {
    const parts = [];
    const light = `rgba(255,255,255,0.82)`;
    const dark = `rgba(0,0,0,0.32)`;
    if (shape === 'orb') {
      for (let i = 0; i < 5; i += 1) {
        const r = (Math.min(w, h) / 2) * (0.16 + rnd() * 0.5);
        parts.push(`<circle cx="${(w * (0.2 + rnd() * 0.6)).toFixed(0)}" cy="${(h * (0.2 + rnd() * 0.6)).toFixed(0)}" r="${r.toFixed(0)}" fill="none" stroke="${i % 2 ? light : dark}" stroke-width="${(2 + rnd() * 6).toFixed(1)}" filter="url(#soft)"/>`);
      }
    } else if (shape === 'grid') {
      const step = Math.min(w, h) / (6 + Math.floor(rnd() * 6));
      parts.push(`<g stroke="${light}" stroke-width="1.4" opacity="0.5">`);
      for (let x = step; x < w; x += step) parts.push(`<line x1="${x.toFixed(0)}" y1="0" x2="${x.toFixed(0)}" y2="${h}"/>`);
      for (let y = step; y < h; y += step) parts.push(`<line x1="0" y1="${y.toFixed(0)}" x2="${w}" y2="${y.toFixed(0)}"/>`);
      parts.push('</g>');
      parts.push(`<rect x="${(w * 0.2).toFixed(0)}" y="${(h * 0.2).toFixed(0)}" width="${(w * 0.6).toFixed(0)}" height="${(h * 0.6).toFixed(0)}" fill="none" stroke="${light}" stroke-width="${(3 + rnd() * 5).toFixed(1)}"/>`);
    } else if (shape === 'wave') {
      for (let k = 0; k < 6; k += 1) {
        const y0 = h * (0.2 + k * 0.12);
        const amp = h * (0.03 + rnd() * 0.09);
        const d = Array.from({ length: 33 }, (_, i) => {
          const x = (w * i) / 32;
          const y = y0 + Math.sin((i / 32) * Math.PI * (2 + rnd() * 3) + k) * amp;
          return `${i ? 'L' : 'M'}${x.toFixed(0)},${y.toFixed(0)}`;
        }).join(' ');
        parts.push(`<path d="${d}" fill="none" stroke="${k % 2 ? light : dark}" stroke-width="${(2 + rnd() * 5).toFixed(1)}"/>`);
      }
    } else if (shape === 'shards') {
      for (let i = 0; i < 14; i += 1) {
        const pts = Array.from({ length: 3 }, () => `${(rnd() * w).toFixed(0)},${(rnd() * h).toFixed(0)}`).join(' ');
        parts.push(`<polygon points="${pts}" fill="${i % 3 === 0 ? light : 'rgba(255,255,255,0.16)'}" opacity="${(0.2 + rnd() * 0.5).toFixed(2)}"/>`);
      }
    } else {
      for (let i = 0; i < 9; i += 1) {
        const p = rnd();
        parts.push(`<circle cx="${(w * (0.15 + rnd() * 0.7)).toFixed(0)}" cy="${(h * (0.15 + rnd() * 0.7)).toFixed(0)}" r="${(Math.min(w, h) * (0.04 + p * 0.36)).toFixed(0)}" fill="none" stroke="${p > 0.5 ? light : dark}" stroke-width="${(2 + p * 7).toFixed(1)}" opacity="${(0.35 + p * 0.5).toFixed(2)}"/>`);
      }
    }
    return parts.join('\n');
  }

  async probe() {
    await sleep(15);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
