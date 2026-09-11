/**
 * 最小 QR 码编码器（仅字节模式），零依赖，输出布尔矩阵。
 *
 * 为什么自己写而不是引第三方库：面板不联外网，也没有 node_modules，
 * 只需要「文本 → 矩阵」这一条路径，字节模式够用。
 *
 * 实现依据 ISO/IEC 18004。分块与纠错容量表由 python3-qrcode 的
 * RS_BLOCK_TABLE / PATTERN_POSITION_TABLE 导出，未手抄。
 */

// 每组写作 "块数,总码字,数据码字"，同版本多组用 / 分隔，版本间用空格分隔
const RS_BLOCKS = {
  L:
    '1,26,19 1,44,34 1,70,55 1,100,80 1,134,108 2,86,68 2,98,78 2,121,97 2,146,116 2,86,68/2,87,69 4,101,81 2,116,92/2,117,93 4,133,107 3,145,115/1,146,116 5,109,87/1,110,88 5,122,98/1,123,99 1,135,107/5,136,108 5,150,120/1,151,121 3,141,113/4,142,114 3,135,107/5,136,108 4,144,116/4,145,117 2,139,111/7,140,112 4,151,121/5,152,122 6,147,117/4,148,118 8,132,106/4,133,107 10,142,114/2,143,115 8,152,122/4,153,123 3,147,117/10,148,118 7,146,116/7,147,117 5,145,115/10,146,116 13,145,115/3,146,116 17,145,115 17,145,115/1,146,116 13,145,115/6,146,116 12,151,121/7,152,122 6,151,121/14,152,122 17,152,122/4,153,123 4,152,122/18,153,123 20,147,117/4,148,118 19,148,118/6,149,119',
  M:
    '1,26,16 1,44,28 1,70,44 2,50,32 2,67,43 4,43,27 4,49,31 2,60,38/2,61,39 3,58,36/2,59,37 4,69,43/1,70,44 1,80,50/4,81,51 6,58,36/2,59,37 8,59,37/1,60,38 4,64,40/5,65,41 5,65,41/5,66,42 7,73,45/3,74,46 10,74,46/1,75,47 9,69,43/4,70,44 3,70,44/11,71,45 3,67,41/13,68,42 17,68,42 17,74,46 4,75,47/14,76,48 6,73,45/14,74,46 8,75,47/13,76,48 19,74,46/4,75,47 22,73,45/3,74,46 3,73,45/23,74,46 21,73,45/7,74,46 19,75,47/10,76,48 2,74,46/29,75,47 10,74,46/23,75,47 14,74,46/21,75,47 14,74,46/23,75,47 12,75,47/26,76,48 6,75,47/34,76,48 29,74,46/14,75,47 13,74,46/32,75,47 40,75,47/7,76,48 18,75,47/31,76,48',
  Q:
    '1,26,13 1,44,22 2,35,17 2,50,24 2,33,15/2,34,16 4,43,19 2,32,14/4,33,15 4,40,18/2,41,19 4,36,16/4,37,17 6,43,19/2,44,20 4,50,22/4,51,23 4,46,20/6,47,21 8,44,20/4,45,21 11,36,16/5,37,17 5,54,24/7,55,25 15,43,19/2,44,20 1,50,22/15,51,23 17,50,22/1,51,23 17,47,21/4,48,22 15,54,24/5,55,25 17,50,22/6,51,23 7,54,24/16,55,25 11,54,24/14,55,25 11,54,24/16,55,25 7,54,24/22,55,25 28,50,22/6,51,23 8,53,23/26,54,24 4,54,24/31,55,25 1,53,23/37,54,24 15,54,24/25,55,25 42,54,24/1,55,25 10,54,24/35,55,25 29,54,24/19,55,25 44,54,24/7,55,25 39,54,24/14,55,25 46,54,24/10,55,25 49,54,24/10,55,25 48,54,24/14,55,25 43,54,24/22,55,25 34,54,24/34,55,25',
  H:
    '1,26,9 1,44,16 2,35,13 4,25,9 2,33,11/2,34,12 4,43,15 4,39,13/1,40,14 4,40,14/2,41,15 4,36,12/4,37,13 6,43,15/2,44,16 3,36,12/8,37,13 7,42,14/4,43,15 12,33,11/4,34,12 11,36,12/5,37,13 11,36,12/7,37,13 3,45,15/13,46,16 2,42,14/17,43,15 2,42,14/19,43,15 9,39,13/16,40,14 15,43,15/10,44,16 19,46,16/6,47,17 34,37,13 16,45,15/14,46,16 30,46,16/2,47,17 22,45,15/13,46,16 33,46,16/4,47,17 12,45,15/28,46,16 11,45,15/31,46,16 19,45,15/26,46,16 23,45,15/25,46,16 23,45,15/28,46,16 19,45,15/35,46,16 11,45,15/46,46,16 59,46,16/1,47,17 22,45,15/41,46,16 2,45,15/64,46,16 24,45,15/46,46,16 42,45,15/32,46,16 10,45,15/67,46,16 20,45,15/61,46,16'
}

/** 对齐图案中心坐标（版本 1 没有对齐图案） */
const ALIGN_POS = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
  [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
  [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
  [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170]
]

const EC_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 }

// 版本信息（版本 7 起才有），索引 0 对应版本 7
const VERSION_INFO = [
  0x07c94, 0x085bc, 0x09a99, 0x0a4d3, 0x0bbf6, 0x0c762, 0x0d847, 0x0e60d, 0x0f928, 0x10b78,
  0x1145d, 0x12a17, 0x13532, 0x149a6, 0x15683, 0x168c9, 0x177ec, 0x18ec4, 0x191e1, 0x1afab,
  0x1b08e, 0x1cc1a, 0x1d33f, 0x1ed75, 0x1f250, 0x209d5, 0x216f0, 0x228ba, 0x2379f, 0x24b0b,
  0x2542e, 0x26a64, 0x27541, 0x28c69
]

// ------------------------------------------------------------- GF(256) 运算

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

/** 生成多项式 (x-a^0)(x-a^1)…(x-a^(n-1))，返回系数数组（最高次在前） */
function rsGenerator(n) {
  let poly = [1]
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i])
    }
    poly = next
  }
  return poly
}

const genCache = new Map()
function generatorFor(n) {
  if (!genCache.has(n)) genCache.set(n, rsGenerator(n))
  return genCache.get(n)
}

/** 对 data 求 ecCount 个纠错码字 */
function rsEncode(data, ecCount) {
  const gen = generatorFor(ecCount)
  const rem = new Uint8Array(ecCount)
  for (const byte of data) {
    const factor = byte ^ rem[0]
    rem.copyWithin(0, 1)
    rem[ecCount - 1] = 0
    if (factor !== 0) {
      // gen[0] 恒为 1，跳过
      for (let i = 0; i < ecCount; i++) rem[i] ^= gfMul(gen[i + 1], factor)
    }
  }
  return rem
}

// ------------------------------------------------------------------ 位缓冲

class BitBuffer {
  constructor() {
    this.bytes = []
    this.length = 0
  }
  put(value, bits) {
    for (let i = bits - 1; i >= 0; i--) this.putBit(((value >>> i) & 1) === 1)
  }
  putBit(on) {
    const idx = this.length >>> 3
    if (this.bytes.length <= idx) this.bytes.push(0)
    if (on) this.bytes[idx] |= 0x80 >>> this.length % 8
    this.length++
  }
}

// ------------------------------------------------------------- 版本与分块

function parseBlocks(level, version) {
  const spec = RS_BLOCKS[level].split(' ')[version - 1]
  const out = []
  for (const group of spec.split('/')) {
    const [count, total, dataLen] = group.split(',').map(Number)
    for (let i = 0; i < count; i++) out.push({ total, dataLen })
  }
  return out
}

function dataCapacity(level, version) {
  return parseBlocks(level, version).reduce((sum, b) => sum + b.dataLen, 0)
}

/** 字节模式下字符计数字段的位宽 */
function lengthBits(version) {
  return version < 10 ? 8 : 16
}

function pickVersion(byteLen, level) {
  for (let v = 1; v <= 40; v++) {
    // 模式指示符 4 位 + 计数字段 + 数据
    const need = 4 + lengthBits(v) + byteLen * 8
    if (dataCapacity(level, v) * 8 >= need) return v
  }
  return null
}

// --------------------------------------------------------------- 码字编排

function buildCodewords(data, level, version) {
  const blocks = parseBlocks(level, version)
  const buf = new BitBuffer()
  buf.put(0b0100, 4) // 字节模式
  buf.put(data.length, lengthBits(version))
  for (const b of data) buf.put(b, 8)

  const capacityBits = dataCapacity(level, version) * 8
  // 结束符最多 4 位，容量不足时截短
  buf.put(0, Math.min(4, capacityBits - buf.length))
  while (buf.length % 8 !== 0) buf.putBit(false)

  const dataBytes = buf.bytes.slice()
  // 填充字节按 0xEC / 0x11 交替
  const pad = [0xec, 0x11]
  let pi = 0
  while (dataBytes.length < dataCapacity(level, version)) dataBytes.push(pad[pi++ % 2])

  // 按块切分并各自算纠错
  const dataParts = []
  const ecParts = []
  let offset = 0
  for (const b of blocks) {
    const part = dataBytes.slice(offset, offset + b.dataLen)
    offset += b.dataLen
    dataParts.push(part)
    ecParts.push(rsEncode(part, b.total - b.dataLen))
  }

  // 交错：先按列取遍所有块的数据码字，再取遍纠错码字
  const out = []
  const maxData = Math.max(...dataParts.map((p) => p.length))
  for (let i = 0; i < maxData; i++) {
    for (const p of dataParts) if (i < p.length) out.push(p[i])
  }
  const maxEc = Math.max(...ecParts.map((p) => p.length))
  for (let i = 0; i < maxEc; i++) {
    for (const p of ecParts) if (i < p.length) out.push(p[i])
  }
  return out
}

// ----------------------------------------------------------------- 矩阵布局

/** BCH(15,5) 格式信息 */
function formatBits(level, mask) {
  let data = (EC_BITS[level] << 3) | mask
  let value = data << 10
  for (let i = 4; i >= 0; i--) {
    if (value & (1 << (i + 10))) value ^= 0x537 << i
  }
  return ((data << 10) | value) ^ 0x5412
}

function createMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null))
}

function placeFinder(m, row, col) {
  const size = m.length
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r
      const cc = col + c
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6))
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4
      m[rr][cc] = inRing || inCore
    }
  }
}

function placeAlignment(m, version) {
  for (const row of ALIGN_POS[version - 1]) {
    for (const col of ALIGN_POS[version - 1]) {
      // 三个定位图案的位置不放对齐图案
      if (m[row][col] !== null) continue
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          m[row + r][col + c] = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)
        }
      }
    }
  }
}

function placeTiming(m) {
  const size = m.length
  for (let i = 8; i < size - 8; i++) {
    const on = i % 2 === 0
    if (m[6][i] === null) m[6][i] = on
    if (m[i][6] === null) m[i][6] = on
  }
}

function reserveFormat(m) {
  const size = m.length
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = false
    if (m[i][8] === null) m[i][8] = false
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = false
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = false
  }
  // 固定的暗模块
  m[size - 8][8] = true
}

function reserveVersion(m, version) {
  if (version < 7) return
  const size = m.length
  for (let i = 0; i < 18; i++) {
    const r = Math.floor(i / 3)
    const c = i % 3
    m[size - 11 + c][r] = false
    m[r][size - 11 + c] = false
  }
}

function maskAt(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0
    case 1: return row % 2 === 0
    case 2: return col % 3 === 0
    case 3: return (row + col) % 3 === 0
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
  }
}

/** 把码字按之字形填入未被功能图案占用的格子 */
function placeData(m, codewords, mask) {
  const size = m.length
  let bitIndex = 0
  const totalBits = codewords.length * 8
  let upward = true

  for (let right = size - 1; right > 0; right -= 2) {
    // 第 6 列是垂直 timing pattern，整列跳过
    const colRight = right <= 6 ? right - 1 : right
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step
      for (const col of [colRight, colRight - 1]) {
        if (col < 0 || m[row][col] !== null) continue
        let on = false
        if (bitIndex < totalBits) {
          on = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex % 8))) & 1) === 1
        }
        bitIndex++
        m[row][col] = on !== maskAt(mask, row, col)
      }
    }
    upward = !upward
  }
}

function writeFormat(m, level, mask) {
  const size = m.length
  const bits = formatBits(level, mask)
  const bit = (i) => ((bits >>> i) & 1) === 1

  // 第一份：沿左上角竖着往下，低位在上；第 6 行是水平 timing，要跳过
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i)
  m[7][8] = bit(6)
  m[8][8] = bit(7)
  for (let i = 8; i <= 14; i++) m[size - 15 + i][8] = bit(i)

  // 第二份：沿第 8 行，低位在最右
  for (let i = 0; i <= 7; i++) m[8][size - 1 - i] = bit(i)
  m[8][7] = bit(8)
  for (let i = 9; i <= 14; i++) m[8][14 - i] = bit(i)

  m[size - 8][8] = true
}

function writeVersion(m, version) {
  if (version < 7) return
  const size = m.length
  const bits = VERSION_INFO[version - 7]
  for (let i = 0; i < 18; i++) {
    const on = ((bits >>> i) & 1) === 1
    const r = Math.floor(i / 3)
    const c = i % 3
    m[size - 11 + c][r] = on
    m[r][size - 11 + c] = on
  }
}

// --------------------------------------------------------------- 掩码评分

function penalty(m) {
  const size = m.length
  let score = 0

  // 规则 1：同色连续 5 个以上
  const runScore = (get) => {
    let sum = 0
    for (let a = 0; a < size; a++) {
      let run = 1
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) {
          run++
        } else {
          if (run >= 5) sum += 3 + (run - 5)
          run = 1
        }
      }
      if (run >= 5) sum += 3 + (run - 5)
    }
    return sum
  }
  score += runScore((r, c) => m[r][c])
  score += runScore((c, r) => m[r][c])

  // 规则 2：2x2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c]
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3
    }
  }

  // 规则 3：形如 1:1:3:1:1 加 4 个浅色的图案
  const PAT = [true, false, true, true, true, false, true, false, false, false, false]
  const RPAT = PAT.slice().reverse()
  const matches = (get, a, start) => {
    let fwd = true
    let rev = true
    for (let i = 0; i < 11; i++) {
      const v = get(a, start + i)
      if (v !== PAT[i]) fwd = false
      if (v !== RPAT[i]) rev = false
    }
    return (fwd ? 1 : 0) + (rev ? 1 : 0)
  }
  for (let a = 0; a < size; a++) {
    for (let b = 0; b <= size - 11; b++) {
      score += 40 * matches((x, y) => m[x][y], a, b)
      score += 40 * matches((x, y) => m[y][x], a, b)
    }
  }

  // 规则 4：深色比例偏离 50%
  let dark = 0
  for (const row of m) for (const v of row) if (v) dark++
  const ratio = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10

  return score
}

// -------------------------------------------------------------------- 入口

/**
 * 编码为布尔矩阵（true = 深色模块），不含静默区。
 * @param {string} text 待编码文本（按 UTF-8 处理）
 * @param {{level?: 'L'|'M'|'Q'|'H'}} opts
 * @returns {boolean[][]}
 */
export function encode(text, opts = {}) {
  const level = opts.level || 'M'
  if (!RS_BLOCKS[level]) throw new Error('纠错级别非法：' + level)

  const data = new TextEncoder().encode(String(text))
  const version = pickVersion(data.length, level)
  if (!version) {
    throw new Error(`内容过长（${data.length} 字节），超出二维码容量`)
  }

  const codewords = buildCodewords(data, level, version)
  const size = version * 4 + 17

  // 功能图案只需铺一次，逐个掩码复用
  const base = createMatrix(size)
  placeFinder(base, 0, 0)
  placeFinder(base, size - 7, 0)
  placeFinder(base, 0, size - 7)
  placeAlignment(base, version)
  placeTiming(base)
  reserveVersion(base, version)
  reserveFormat(base)
  const reserved = base.map((row) => row.map((v) => v !== null))

  let best = null
  for (let mask = 0; mask < 8; mask++) {
    const m = base.map((row, r) => row.map((v, c) => (reserved[r][c] ? v : null)))
    placeData(m, codewords, mask)
    writeFormat(m, level, mask)
    writeVersion(m, version)
    const score = penalty(m)
    if (!best || score < best.score) best = { score, m, mask }
  }

  return best.m
}

/**
 * 渲染为 SVG 字符串。用单条 path 画所有深色模块，元素少、缩放不失真。
 * @param {string} text
 * @param {{level?: string, scale?: number, margin?: number, dark?: string, light?: string}} opts
 */
export function toSvg(text, opts = {}) {
  const m = encode(text, opts)
  const scale = opts.scale || 6
  const margin = opts.margin === undefined ? 4 : opts.margin
  const size = m.length
  const total = (size + margin * 2) * scale
  const dark = opts.dark || '#000000'
  const light = opts.light || '#ffffff'

  const parts = []
  for (let r = 0; r < size; r++) {
    let c = 0
    while (c < size) {
      if (!m[r][c]) {
        c++
        continue
      }
      // 同一行的连续深色模块合成一个矩形，path 短很多
      let end = c
      while (end + 1 < size && m[r][end + 1]) end++
      const x = (c + margin) * scale
      const y = (r + margin) * scale
      parts.push(`M${x} ${y}h${(end - c + 1) * scale}v${scale}h-${(end - c + 1) * scale}z`)
      c = end + 1
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img">` +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path d="${parts.join('')}" fill="${dark}"/>` +
    `</svg>`
  )
}
