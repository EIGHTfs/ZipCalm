// M4 验收脚本的**夹具与恶意样本构造**（从 test-m4-formats.mjs 拆出：主脚本过长会被审计命中）
//
// 这里的东西有两个共同点：① 都是"造数据"，与断言流程无关；② 逻辑一旦错会直接让往返/zip-slip 用例失真，
// 所以集中在一处、注释写清为什么这么造（尤其是"手写 ustar 头"的理由）。
//
// 裸数字都提成了具名常量：ZIP/tar 的字段偏移与签名值是**格式规范的一部分**（ZIP APPNOTE 4.3.6 / POSIX ustar），
// 写成名字才能和规范逐条对照，否则满屏 0x04034b50、26、46 没人敢改。

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

/** 夹具随机种子：固定值保证每次生成的假数据完全一致（失败可复现） */
const FIXTURE_SEED = 20261016;
/** xorshift32 的三个移位量与归一化除数（算法常量，不是业务参数） */
const XORSHIFT_SHIFTS = { a: 13, b: 17, c: 5 };
const XORSHIFT_RANGE = 0xffffffff;

/** ZIP 记录签名与定长（ZIP APPNOTE：本地头 30B / 中央目录项 46B / EOCD 22B） */
const ZIP_SIGNATURE = { localFile: 0x04034b50, centralEntry: 0x02014b50, endOfCentralDir: 0x06054b50 };
const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_CENTRAL_ENTRY_BYTES = 46;
const ZIP_EOCD_BYTES = 22;
const ZIP_VERSION_EXTRACT = 20;
const ZIP_VERSION_CREATE = 0x031e;
const ZIP_FLAG_DEFLATE = 0x0008;
/** DOS 时间/日期编码：年份基准 1980、各字段 16 位 */
const DOS_YEAR_BASE = 1980;
const DOS_FIELD_MASK = 0xffff;
const FILE_MODE_0644 = 0o100644;
/** tar 头里的 mode 字段只放权限位（不含 S_IFREG），所以是 0644 而不是 0o100644 */
const TAR_MODE_0644 = 0o644;

/** tar 头定长与字段偏移（POSIX ustar，全部按字节偏移） */
const TAR_HEADER_BYTES = 512;
const TAR_FIELD = {
  name: 0,
  mode: 100,
  uid: 108,
  gid: 116,
  size: 124,
  mtime: 136,
  checksum: 148,
  typeflag: 156,
  magic: 257,
  version: 263,
};
const TAR_TRAILER_BYTES = 1024; // 两个 512 零块 = 归档结束标记

/** 确定性伪随机（同一种子每次生成完全一样的夹具，便于复现失败） */
export function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << XORSHIFT_SHIFTS.a; state >>>= 0;
    state ^= state >>> XORSHIFT_SHIFTS.b;
    state ^= state << XORSHIFT_SHIFTS.c; state >>>= 0;
    return state / XORSHIFT_RANGE;
  };
}

/** 递归列文件：相对路径（POSIX 分隔符）→ 绝对路径 */
export async function walkFiles(dir, base = dir, acc = new Map()) {
  let dirents = [];
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const dirent of dirents) {
    const abs = path.join(dir, dirent.name);
    if (dirent.isDirectory()) await walkFiles(abs, base, acc);
    else if (dirent.isFile()) acc.set(path.relative(base, abs).split(path.sep).join('/'), abs);
  }
  return acc;
}

export async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

/** 整棵树的逐文件 hash（往返验证的核心证据：解压后逐文件比对） */
export async function hashTree(dir) {
  const fileMap = await walkFiles(dir);
  const hashes = new Map();
  for (const [relative, abs] of fileMap) hashes.set(relative, await sha256File(abs));
  return hashes;
}

/** 夹具目录布局：含中文目录名与空格目录名，覆盖编码边界 */
const FIXTURE_LAYOUT = [
  { dir: '', count: 2, minSize: 0, maxSize: 400 },
  { dir: '子目录/深层', count: 6, minSize: 1024, maxSize: 65536 },
  { dir: '中文 目录/带空格', count: 4, minSize: 1, maxSize: 4096 },
];

/**
 * 造确定性假数据。
 * @param {string} workDir 本次测试的工作目录（会被整体清空后重建）
 */
export async function prepareFixture(workDir) {
  const srcDir = path.join(workDir, 'src');
  // 整个工作目录都清掉：上一轮的解压产物会让这一轮「首次解压」撞 TARGET_EXISTS
  await fsp.rm(workDir, { recursive: true, force: true });
  await fsp.mkdir(srcDir, { recursive: true });

  const random = createRandom(FIXTURE_SEED);
  let index = 0;
  for (const group of FIXTURE_LAYOUT) {
    const target = path.join(srcDir, group.dir);
    await fsp.mkdir(target, { recursive: true });
    for (let i = 0; i < group.count; i += 1) {
      const size = Math.floor(group.minSize + random() * Math.max(1, group.maxSize - group.minSize));
      const bytes = Buffer.alloc(size);
      for (let offset = 0; offset < size; offset += 1) bytes[offset] = Math.floor(random() * 256);
      await fsp.writeFile(path.join(target, `file-${String(index).padStart(2, '0')}-${size}B.bin`), bytes);
      index += 1;
    }
  }
  return srcDir;
}

/** DOS 时间/日期字段（ZIP 头里各占 2 字节） */
function dosTimestamp(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & DOS_FIELD_MASK;
  const day = (((date.getFullYear() - DOS_YEAR_BASE) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & DOS_FIELD_MASK;
  return { time, day };
}

/** ZIP 本地文件头（30 字节定长 + 名字 + 压缩数据） */
function buildZipLocalHeader({ nameBytes, contentBytes, compressed, crc, time, day }) {
  const local = Buffer.alloc(ZIP_LOCAL_HEADER_BYTES);
  local.writeUInt32LE(ZIP_SIGNATURE.localFile, 0);
  local.writeUInt16LE(ZIP_VERSION_EXTRACT, 4);
  local.writeUInt16LE(ZIP_FLAG_DEFLATE, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(contentBytes.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  return Buffer.concat([local, nameBytes, compressed]);
}

/** ZIP 中央目录项（46 字节定长 + 名字）；offset 为该条目本地头在文件内的偏移 */
function buildZipCentralEntry({ nameBytes, contentBytes, compressed, crc, time, day, offset }) {
  const central = Buffer.alloc(ZIP_CENTRAL_ENTRY_BYTES);
  central.writeUInt32LE(ZIP_SIGNATURE.centralEntry, 0);
  central.writeUInt16LE(ZIP_VERSION_CREATE, 4);
  central.writeUInt16LE(ZIP_VERSION_EXTRACT, 6);
  central.writeUInt16LE(ZIP_FLAG_DEFLATE, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(day, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(contentBytes.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE((FILE_MODE_0644 << 16) >>> 0, 38);
  central.writeUInt32LE(offset, 42);
  return Buffer.concat([central, nameBytes]);
}

/** 手写 ZIP 记录（archiver 会把 `../` 规范化，造不出真样本） */
export async function writeRawZip(destPath, entries) {
  const { time, day } = dosTimestamp(new Date());
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const contentBytes = Buffer.from(entry.content || 'evil', 'utf8');
    const compressed = zlib.deflateRawSync(contentBytes);
    const crc = zlib.crc32(contentBytes) >>> 0;
    localChunks.push(buildZipLocalHeader({ nameBytes, contentBytes, compressed, crc, time, day }));
    centralChunks.push(buildZipCentralEntry({ nameBytes, contentBytes, compressed, crc, time, day, offset }));
    offset += ZIP_LOCAL_HEADER_BYTES + nameBytes.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(ZIP_EOCD_BYTES);
  eocd.writeUInt32LE(ZIP_SIGNATURE.endOfCentralDir, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.writeFile(destPath, Buffer.concat([...localChunks, centralBuf, eocd]));
}

/** 把字符串写进 ustar 头：八进制、11 位 + NUL 结尾（POSIX 数字字段格式） */
function writeOctalField(header, offset, value, width, digits) {
  header.write(`${value.toString(8).padStart(digits, '0')}\0`, offset, width, 'ascii');
}

/**
 * 手写最小 tar 头（只用于**造恶意样本**）：node-tar 的写入 API 不接受任意条目名，
 * 而 zip-slip 用例必须真的把 `../`、绝对路径写进归档里 —— 所以这里自己拼 512 字节 ustar 头。
 * 只服务测试，生产代码的 tar 读写完全交给 node-tar。
 */
function tarHeader(name, size) {
  const header = Buffer.alloc(TAR_HEADER_BYTES);
  header.write(name, TAR_FIELD.name, 100, 'utf8');
  writeOctalField(header, TAR_FIELD.mode, TAR_MODE_0644, 8, 7);
  writeOctalField(header, TAR_FIELD.uid, 0, 8, 7);
  writeOctalField(header, TAR_FIELD.gid, 0, 8, 7);
  writeOctalField(header, TAR_FIELD.size, size, 12, 11);
  writeOctalField(header, TAR_FIELD.mtime, Math.floor(Date.now() / 1000), 12, 11);
  header.write('        ', TAR_FIELD.checksum, 8, 'ascii'); // 校验和先占位，算完再回填
  header.write('0', TAR_FIELD.typeflag, 1, 'ascii');
  header.write('ustar\0', TAR_FIELD.magic, 6, 'ascii');
  header.write('00', TAR_FIELD.version, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  // 校验和字段自身的 8 字节按空格参与求和，最终写成 6 位八进制 + NUL + 空格
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, TAR_FIELD.checksum, 8, 'ascii');
  return header;
}

function tarEntry(name, content) {
  const contentBytes = Buffer.from(content, 'utf8');
  const padded = Buffer.alloc(Math.ceil(contentBytes.length / TAR_HEADER_BYTES) * TAR_HEADER_BYTES);
  contentBytes.copy(padded);
  return Buffer.concat([tarHeader(name, contentBytes.length), padded]);
}

/** 写恶意 tar（按格式套压缩层）：条目名可为 `../x` 或 `/abs/x` */
export async function writeRawTar(destPath, compression, entries) {
  const body = Buffer.concat([
    ...entries.map(([name, content]) => tarEntry(name, content)),
    Buffer.alloc(TAR_TRAILER_BYTES),
  ]);
  const payload = compression === 'gzip' ? zlib.gzipSync(body)
    : compression === 'zstd' ? zlib.zstdCompressSync(body)
      : body;
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.writeFile(destPath, payload);
}
