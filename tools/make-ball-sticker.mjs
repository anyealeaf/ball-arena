/* 制作小球贴图：把角色立绘的头部裁成圆形贴图（带 alpha 遮罩）。
 *
 * 为什么预先裁好而不是运行时裁：
 *   立绘 1943 KB，而头部贴图只需 256×256（几十 KB）。
 *   预先裁好既省流量，也避免每帧做圆形裁剪。
 *
 * 为什么导出带 alpha 的圆圈而不是让渲染层 clip：
 *   渲染层每帧对每球做 clip 会拖慢，而且边缘会有锯齿。
 *   做进贴图后渲染层只需 drawImage 一次。
 *
 * 用法：node tools/make-ball-sticker.mjs
 */
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(GAME, 'assets', 'src');
const OUT_DIR = join(GAME, 'assets', 'characters');

/* 裁切参数：头部中心与半径，按“占图像宽度的比例”给出，
 * 这样换一张分辨率的立绘时不用重算像素值。
 *
 * 坐标基准：原图 832 宽 × 1216 高（竖图，半身像）。
 * 参数是逐步扫出来的（见 tools/preview-sticker.mjs 的对比图）：
 *   早期把 cy 取在 0.19~0.23 是额头位置，圆圈总切掉头顶；
 *   正确区间是 cy≈0.29（脸中心），半径 0.195 恰好包住头顶发饰到下巴。
 */
const JOBS = [
  {
    id: 'yuncai',
    name: '晕彩',
    src: join(SRC_DIR, 'yuncai_full.png'),
    cx: 0.49, cy: 0.29, r: 0.195,
    out: join(OUT_DIR, 'yuncai_head.png'),
    size: 256,
    bg: '#21222c'          // 压平用的底色，取自立绘的深色背景
  }
];

/** 生成圆形 alpha 遮罩（硬边圆，由后续 alpha 模糊做抗锯齿）。
 *  不用径向渐变：渐变在极端像素上会残留半透明（实测最外侧 alpha=192）。 */
function circleMask(size) {
  const r = size / 2;
  const svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${r}" cy="${r}" r="${r}" fill="#fff"/>
  </svg>`;
  return Buffer.from(svg);
}

/**
 * 用圆形遮罩裁切，并把圆边做轻微羽化。
 *
 * 实现要点：**显式构造 alpha 通道**，而不是用 `blend: 'dest-in'` 合成。
 * dest-in 之后再读 raw 缓冲会把预乘 alpha 与直通 alpha 搞混
 * （实测四角本该透明却读出 alpha=255）。这里改为：
 *   颜色 = 原图 RGB（已经压平，不透明）
 *   alpha = 圆形遮罩的灰度，再整体轻模糊
 */
async function cutCircle(srcBuffer, size, sigma = 0.7) {
  const { data: rgb } = await sharp(srcBuffer)
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });

  /* 遮罩画在"放大一圈"的画布上（四周各留 PAD 像素），模糊后再裁回来。
     两个要点：
       ① blur() 在图像边界会做像素外推，直接模糊正好贴边的圆会让最外圈
          保持不透明（实测 alpha=255，本该是 0），所以四周要留余量；
       ② 圆的半径要比画布半宽小一点点（INNER），否则羽化后圆外仍残留
          微量 alpha（实测最外可达 11），贴到场上会有一圈脏边。 */
  const PAD = 3;
  const INNER = 1.5;
  const M = size + PAD * 2;
  const cx = M / 2, radius = size / 2 - INNER;
  const maskSvg = Buffer.from(
    `<svg width="${M}" height="${M}" viewBox="0 0 ${M} ${M}">
       <circle cx="${cx}" cy="${cx}" r="${radius}" fill="#fff"/></svg>`);

  const maskRaw = await sharp(maskSvg).greyscale().raw().toBuffer();
  /* 关键：blur() 会把单通道提升成 3 通道（输出长度变成 3 倍），
     必须用 extractChannel(0) 取回单通道，否则 joinChannel 拿到错位数据，
     alpha 会呈现"隔行不透明"的怪异条纹。 */
  const blurred = await sharp(maskRaw, { raw: { width: M, height: M, channels: 1 } })
    .blur(sigma)
    .extractChannel(0)
    .extract({ left: PAD, top: PAD, width: size, height: size })
    .raw().toBuffer();
  if (blurred.length !== size * size) {
    throw new Error(`alpha 通道长度异常：${blurred.length}，期望 ${size * size}`);
  }

  return sharp(rgb, { raw: { width: size, height: size, channels: 3 } })
    .joinChannel(blurred, { raw: { width: size, height: size, channels: 1 } })
    .png()
    .toBuffer();
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  for (const job of JOBS) {
    const meta = await sharp(job.src).metadata();
    const W = meta.width, H = meta.height;
    const size = job.size;

    // 以面部中心为圆心的正方形裁切区
    const side = Math.round(job.r * 2 * W);
    let left = Math.round(job.cx * W - side / 2);
    let top = Math.round(job.cy * H - side / 2);
    // 贴边时向内收，保证裁切区完整落在图内
    left = Math.max(0, Math.min(W - side, left));
    top = Math.max(0, Math.min(H - side, top));

    /* 先把原画压到不透明底色，再上圆形遮罩。
       为什么要先压平：原画边缘本身带一点透明（发光/柔边），
       与遮罩用 dest-in 相乘后仍会残留半透明像素
       （实测最外侧 alpha=192，本该是 0），贴到场上会露出一圈脏边。
       底色取立绘自身的深色背景，颜色过渡自然。 */
    const flattened = await sharp(job.src)
      .flatten({ background: job.bg || '#21222c' })
      .extract({ left, top, width: side, height: side })
      .resize(size, size, { fit: 'cover' })
      .png()
      .toBuffer();

    // 圆形裁切 + 圆边羽化
    const cut = await cutCircle(flattened, size, 0.7);
    await sharp(cut).png({ compressionLevel: 9 }).toFile(job.out);

    const outMeta = await sharp(job.out).metadata();
    console.log(
      `${job.name}: 原图 ${W}×${H} → 裁切 (${left},${top}) ${side}×${side} → ` +
      `贴图 ${outMeta.width}×${outMeta.height}（alpha=${outMeta.hasAlpha}）`
    );
    console.log(`  输出：${job.out.replace(GAME, 'game')}`);
  }
}

main().catch(e => { console.error('失败：', e.message); process.exit(1); });
