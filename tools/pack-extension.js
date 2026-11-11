/* 打包 Chrome 扩展为可分发的 zip
 *
 * 只打包运行所需的文件，不带源码测试与工具：
 *   manifest.json + icons/ + src/
 *
 * 为什么不用 Compress-Archive：
 *   它会把路径分隔符写成反斜杠、并可能带上额外目录层，
 *   Chrome 解压后可能找不到 manifest.json。
 *   这里用一个纯 Node 的 zip 写入器，确保路径用正斜杠、
 *   manifest.json 位于压缩包根目录。
 *
 * 用法：node tools/pack-extension.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// Chrome 加载所需的全部文件（相对路径，正斜杠）
const INCLUDE_DIRS = ['icons', 'src'];
const INCLUDE_FILES = ['manifest.json'];
// 明确排除：桌面端用不到的辅助文件
const EXCLUDE = [/\.map$/, /\.md$/, /\.ts$/, /probe-host\.html$/];

// ── 最小 ZIP 写入器（deflate） ──
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  // 固定时间戳，让构建可复现（同一份源码产生同一个 zip）
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // 压缩反而更大时用 stored
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    // 本地文件头
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, payload);
    central.push({ nameBuf, crc, compSize: payload.length, rawSize: data.length, method, offset });
    offset += local.length + nameBuf.length + payload.length;
  }

  // 中央目录
  const cdStart = offset;
  let cdSize = 0;
  for (const e of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4); // version made by
    h.writeUInt16LE(20, 6); // version needed
    h.writeUInt16LE(0x0800, 8); // UTF-8
    h.writeUInt16LE(e.method, 10);
    h.writeUInt16LE(dosTime, 12);
    h.writeUInt16LE(dosDate, 14);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(e.compSize, 20);
    h.writeUInt32LE(e.rawSize, 24);
    h.writeUInt16LE(e.nameBuf.length, 28);
    h.writeUInt16LE(0, 30);
    h.writeUInt16LE(0, 32);
    h.writeUInt16LE(0, 34);
    h.writeUInt16LE(0, 36);
    h.writeUInt32LE(0, 38);
    h.writeUInt32LE(e.offset, 42);
    chunks.push(h, e.nameBuf);
    cdSize += h.length + e.nameBuf.length;
  }

  // 中央目录结束
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

// ── 收集文件 ──
function collect() {
  const entries = [];

  const addFile = (abs, rel) => {
    if (EXCLUDE.some((re) => re.test(rel))) return;
    const data = fs.readFileSync(abs);
    entries.push({ name: rel.replace(/\\/g, '/'), data });
  };

  for (const f of INCLUDE_FILES) {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) throw new Error('缺少必需文件: ' + f);
    addFile(abs, f);
  }

  const walk = (dir, base) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.join(base, e.name);
      if (e.isDirectory()) walk(abs, rel);
      else addFile(abs, rel);
    }
  };
  for (const d of INCLUDE_DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) throw new Error('缺少必需目录: ' + d);
    walk(abs, d);
  }

  // 按名字排序，让输出稳定
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  return entries;
}

// ── 校验：必须能从 zip 里找到 manifest 并解析 ──
function verify(zipBuf, expectedVersion) {
  const entries = collect();
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  if (!manifestEntry) throw new Error('zip 里没有 manifest.json');

  const m = JSON.parse(manifestEntry.data.toString('utf8'));
  if (m.version !== expectedVersion) {
    throw new Error(`manifest 版本不符: ${m.version} != ${expectedVersion}`);
  }
  if (!m.icons || !m.icons['128']) throw new Error('manifest 缺少图标声明');

  // 图标文件必须在 zip 里
  for (const [, rel] of Object.entries(m.icons)) {
    if (!entries.some((e) => e.name.replace(/\\/g, '/') === rel)) {
      throw new Error('zip 缺少图标: ' + rel);
    }
  }
  // content_scripts 引用的 js 必须存在
  for (const cs of m.content_scripts || []) {
    for (const js of cs.js || []) {
      if (!entries.some((e) => e.name.replace(/\\/g, '/') === js)) {
        throw new Error('zip 缺少脚本: ' + js);
      }
    }
  }
  return { manifest: m, files: entries.map((e) => e.name), size: zipBuf.length };
}

// ── main ──
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;

fs.mkdirSync(DIST, { recursive: true });
const zipName = `threshare-v${version}.zip`;
const zipPath = path.join(DIST, zipName);

const entries = collect();
const zipBuf = buildZip(entries);
fs.writeFileSync(zipPath, zipBuf);

let info;
try {
  info = verify(zipBuf, version);
} catch (e) {
  console.error('✗ 校验失败: ' + e.message);
  process.exit(1);
}

console.log(`✓ ${zipPath}`);
console.log(`  版本: v${version}`);
console.log(`  大小: ${(zipBuf.length / 1024).toFixed(1)} KB`);
console.log(`  文件: ${info.files.length} 个`);
console.log('');
for (const f of info.files) console.log('    ' + f);
