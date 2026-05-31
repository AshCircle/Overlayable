// Overlayable 플레이스홀더 아이콘 생성기.
// 외부 의존성 없이 Node 내장 zlib만으로 PNG를 인코딩한다.
// 사용법: node scripts/gen-icons.mjs
// 결과물: icons/icon-16.png, icons/icon-48.png, icons/icon-128.png
//
// 디자인: 둥근 모서리의 인디고 배경(#4F46E5) 위에 살짝 어긋나게 겹친
// 두 장의 반투명 흰 사각형으로 "오버레이"를 은유한다. 추후 교체 가능.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(__dirname, '..', 'icons');

// ---- 색 정의 (RGBA, 0~255) ----
const BG = [79, 70, 229, 255]; // #4F46E5 인디고
const CARD_BACK = [255, 255, 255, 110]; // 뒤쪽 카드 (반투명 흰색)
const CARD_FRONT = [255, 255, 255, 230]; // 앞쪽 카드 (거의 불투명 흰색)
const TRANSPARENT = [0, 0, 0, 0];

// 알파 블렌딩: src를 dst 위에 올린다 (둘 다 [r,g,b,a]).
function over(src, dst) {
  const sa = src[3] / 255;
  const da = dst[3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return [0, 0, 0, 0];
  const blend = (s, d) => Math.round((s * sa + d * da * (1 - sa)) / oa);
  return [blend(src[0], dst[0]), blend(src[1], dst[1]), blend(src[2], dst[2]), Math.round(oa * 255)];
}

// size×size RGBA 픽셀 버퍼 생성.
function renderIcon(size) {
  const px = new Array(size * size);
  const radius = size * 0.18; // 둥근 모서리 반지름

  // 둥근 사각형 내부 판정 (배경 영역).
  const inRoundedRect = (x, y, x0, y0, x1, y1, r) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    // 모서리 원 영역 체크
    const corners = [
      [x0 + r, y0 + r],
      [x1 - r, y0 + r],
      [x0 + r, y1 - r],
      [x1 - r, y1 - r],
    ];
    const nearLeft = x < x0 + r;
    const nearRight = x > x1 - r;
    const nearTop = y < y0 + r;
    const nearBottom = y > y1 - r;
    if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
      const cx = nearLeft ? corners[0][0] : corners[1][0];
      const cy = nearTop ? corners[0][1] : corners[2][1];
      return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    }
    return true;
  };

  // 카드(겹친 사각형) 기하: 중앙 기준으로 두 장 배치.
  const cardSize = size * 0.42;
  const cardR = Math.max(1, size * 0.07);
  const cx = size / 2;
  const cy = size / 2;
  const offset = size * 0.09;

  // 뒤쪽 카드: 좌상단으로 이동
  const backX0 = cx - cardSize / 2 - offset;
  const backY0 = cy - cardSize / 2 - offset;
  // 앞쪽 카드: 우하단으로 이동
  const frontX0 = cx - cardSize / 2 + offset;
  const frontY0 = cy - cardSize / 2 + offset;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 픽셀 중심 좌표 사용
      const fx = x + 0.5;
      const fy = y + 0.5;
      let color = TRANSPARENT;

      // 1) 배경 (둥근 사각형 전체)
      if (inRoundedRect(fx, fy, 0.5, 0.5, size - 0.5, size - 0.5, radius)) {
        color = BG.slice();
      }

      // 2) 뒤쪽 카드
      if (inRoundedRect(fx, fy, backX0, backY0, backX0 + cardSize, backY0 + cardSize, cardR)) {
        color = over(CARD_BACK, color);
      }

      // 3) 앞쪽 카드
      if (inRoundedRect(fx, fy, frontX0, frontY0, frontX0 + cardSize, frontY0 + cardSize, cardR)) {
        color = over(CARD_FRONT, color);
      }

      px[y * size + x] = color;
    }
  }
  return px;
}

// ---- PNG 인코딩 (truecolor + alpha, 8-bit) ----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type 6 = truecolor + alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 각 스캔라인 앞에 필터 바이트(0) 추가
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixels[y * size + x];
      const o = y * (stride + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }

  const idat = deflateSync(raw, { level: 9 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(ICONS_DIR, { recursive: true });
for (const size of [16, 48, 128]) {
  const png = encodePng(size, renderIcon(size));
  const out = join(ICONS_DIR, `icon-${size}.png`);
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}
