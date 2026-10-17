// 归档验收脚本共用的**夹具与恶意样本构造**（M2 往返/zip-slip 与 M4 四格式都用它）
//
// 这里的东西有两个共同点：① 都是"造数据"，与断言流程无关；② 逻辑一旦错会直接让往返/zip-slip 用例失真，
// 所以集中在一处、注释写清为什么这么造（尤其是"手写 ustar 头"的理由）。
// M2 曾经把同一套 ZIP 记录写法抄在自己文件里 —— 合并到这里后两份实现不会再漂移。
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
/** xorshift32 的三个移位量与归一化除数（算法常量，不是业务参数）；逐条具名以便对照算法说明 */
const XORSHIFT_SHIFT_A = 13;
const XORSHIFT_SHIFT_B = 17;
const XORSHIFT_SHIFT_C = 5;
const XORSHIFT_RANGE = 0xffffffff;
/** 假数据字节取值范围（0~255）与文件名里序号的对齐宽度 */
const BYTE_VALUES = 256;
const INDEX_PAD_WIDTH = 2;

/** ZIP 记录签名与定长（ZIP APPNOTE：本地头 30B / 中央目录项 46B / EOCD 22B） */
const ZIP_SIGNATURE = { localFile: 0x04034b50, centralEntry: 0x02014b50, endOfCentralDir: 0x06054b50 };
const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_CENTRAL_ENTRY_BYTES = 46;
const ZIP_EOCD_BYTES = 22;
const ZIP_VERSION_EXTRACT = 20;
const ZIP_VERSION_CREATE = 0x031e;
/** 压缩方法号（ZIP APPNOTE 4.4.5）：0=store、8=deflate（符号链接条目用 store） */
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
/** unix 外置属性高 16 位 = st_mode：普通文件 0644、符号链接 0777 */
const SYMLINK_MODE_0777 = 0o120777;
/** 条目没写 content 时的占位载荷（只为让记录合法，不影响用例判定） */
const DEFAULT_ENTRY_CONTENT = 'evil';
/** DOS 时间/日期编码：年份基准 1980、各字段 16 位 */
const DOS_YEAR_BASE = 1980;
const DOS_FIELD_MASK = 0xffff;
/** DOS 时间位域（MS-DOS 格式：时 5 位 | 分 6 位 | 秒/2 5 位） */
const DOS_HOUR_SHIFT = 11;
const DOS_MINUTE_SHIFT = 5;
const DOS_SECONDS_DIVISOR = 2;
/** DOS 日期位域（年-1980 7 位 | 月 4 位 | 日 5 位） */
const DOS_YEAR_SHIFT = 9;
const DOS_MONTH_SHIFT = 5;
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
/** ustar 数字字段的固定宽度（含结尾的 NUL/空格）与八进制位数 */
const TAR_NAME_WIDTH = 100;
const OCTAL_FIELD_SMALL = { width: 8, digits: 7 }; // mode / uid / gid
const OCTAL_FIELD_SIZE = { width: 12, digits: 11 }; // size / mtime
const TAR_CHECKSUM_FIELD = { width: 8, digits: 6 }; // 校验和：6 位八进制 + NUL + 空格
const TAR_TYPEFLAG_WIDTH = 1;
const TAR_MAGIC_WIDTH = 6;
const TAR_VERSION_WIDTH = 2;
const MS_PER_SECOND = 1000;

/** 确定性伪随机（同一种子每次生成完全一样的夹具，便于复现失败） */
export function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << XORSHIFT_SHIFT_A; state >>>= 0;
    state ^= state >>> XORSHIFT_SHIFT_B;
    state ^= state << XORSHIFT_SHIFT_C; state >>>= 0;
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
      for (let offset = 0; offset < size; offset += 1) bytes[offset] = Math.floor(random() * BYTE_VALUES);
      await fsp.writeFile(path.join(target, `file-${String(index).padStart(INDEX_PAD_WIDTH, '0')}-${size}B.bin`), bytes);
      index += 1;
    }
  }
  return srcDir;
}

/** DOS 时间/日期字段（ZIP 头里各占 2 字节） */
function dosTimestamp(date) {
  const time = ((date.getHours() << DOS_HOUR_SHIFT)
    | (date.getMinutes() << DOS_MINUTE_SHIFT)
    | Math.floor(date.getSeconds() / DOS_SECONDS_DIVISOR)) & DOS_FIELD_MASK;
  const day = (((date.getFullYear() - DOS_YEAR_BASE) << DOS_YEAR_SHIFT)
    | ((date.getMonth() + 1) << DOS_MONTH_SHIFT)
    | date.getDate()) & DOS_FIELD_MASK;
  return { time, day };
}

/** 中央目录项里这两个偏移单独具名：对象属性里的裸数字仍会被判为魔数（其余字段带 Size/Length 后缀已被豁免） */
const ZIP_CENTRAL_EXTERNAL_ATTRS_OFFSET = 38;
const ZIP_CENTRAL_LOCAL_HEADER_OFFSET = 42;

/** ZIP 本地文件头字段偏移（ZIP APPNOTE 4.3.7） */
const ZIP_LOCAL_FIELD = {
  signature: 0,
  versionNeeded: 4,
  method: 8,
  time: 10,
  date: 12,
  crc: 14,
  compressedSize: 18,
  uncompressedSize: 22,
  nameLength: 26,
};

/** ZIP 中央目录项字段偏移（ZIP APPNOTE 4.3.12） */
const ZIP_CENTRAL_FIELD = {
  signature: 0,
  versionMadeBy: 4,
  versionNeeded: 6,
  method: 10,
  time: 12,
  date: 14,
  crc: 16,
  compressedSize: 20,
  uncompressedSize: 24,
  nameLength: 28,
  externalAttrs: ZIP_CENTRAL_EXTERNAL_ATTRS_OFFSET,
  localHeaderOffset: ZIP_CENTRAL_LOCAL_HEADER_OFFSET,
};

/** ZIP 结尾记录（EOCD）字段偏移（ZIP APPNOTE 4.3.16） */
const ZIP_EOCD_FIELD = { signature: 0, entriesOnDisk: 8, totalEntries: 10, centralSize: 12, centralOffset: 16 };

/** ZIP 本地文件头（30 字节定长 + 名字 + 压缩数据） */
function buildZipLocalHeader({ nameBytes, contentBytes, compressed, crc, time, day, method }) {
  const local = Buffer.alloc(ZIP_LOCAL_HEADER_BYTES);
  local.writeUInt32LE(ZIP_SIGNATURE.localFile, ZIP_LOCAL_FIELD.signature);
  local.writeUInt16LE(ZIP_VERSION_EXTRACT, ZIP_LOCAL_FIELD.versionNeeded);
  local.writeUInt16LE(method, ZIP_LOCAL_FIELD.method);
  local.writeUInt16LE(time, ZIP_LOCAL_FIELD.time);
  local.writeUInt16LE(day, ZIP_LOCAL_FIELD.date);
  local.writeUInt32LE(crc, ZIP_LOCAL_FIELD.crc);
  local.writeUInt32LE(compressed.length, ZIP_LOCAL_FIELD.compressedSize);
  local.writeUInt32LE(contentBytes.length, ZIP_LOCAL_FIELD.uncompressedSize);
  local.writeUInt16LE(nameBytes.length, ZIP_LOCAL_FIELD.nameLength);
  return Buffer.concat([local, nameBytes, compressed]);
}

/** ZIP 中央目录项（46 字节定长 + 名字）；offset 为该条目本地头在文件内的偏移 */
function buildZipCentralEntry({ nameBytes, contentBytes, compressed, crc, time, day, offset, method, externalAttr }) {
  const central = Buffer.alloc(ZIP_CENTRAL_ENTRY_BYTES);
  central.writeUInt32LE(ZIP_SIGNATURE.centralEntry, ZIP_CENTRAL_FIELD.signature);
  central.writeUInt16LE(ZIP_VERSION_CREATE, ZIP_CENTRAL_FIELD.versionMadeBy);
  central.writeUInt16LE(ZIP_VERSION_EXTRACT, ZIP_CENTRAL_FIELD.versionNeeded);
  central.writeUInt16LE(method, ZIP_CENTRAL_FIELD.method);
  central.writeUInt16LE(time, ZIP_CENTRAL_FIELD.time);
  central.writeUInt16LE(day, ZIP_CENTRAL_FIELD.date);
  central.writeUInt32LE(crc, ZIP_CENTRAL_FIELD.crc);
  central.writeUInt32LE(compressed.length, ZIP_CENTRAL_FIELD.compressedSize);
  central.writeUInt32LE(contentBytes.length, ZIP_CENTRAL_FIELD.uncompressedSize);
  central.writeUInt16LE(nameBytes.length, ZIP_CENTRAL_FIELD.nameLength);
  central.writeUInt32LE(externalAttr, ZIP_CENTRAL_FIELD.externalAttrs);
  central.writeUInt32LE(offset, ZIP_CENTRAL_FIELD.localHeaderOffset);
  return Buffer.concat([central, nameBytes]);
}

/**
 * 条目 → ZIP 记录需要的四项（载荷 / 压缩数据 / 方法号 / unix 外置属性）。
 * 符号链接条目按规范用 store 且标记 0777 权限位 —— zip-slip 的"符号链接逃逸"样本靠这个才真实。
 */
function zipEntryMeta(entry) {
  const isSymlink = entry.type === 'symlink';
  const contentBytes = Buffer.from(isSymlink ? entry.target : (entry.content || DEFAULT_ENTRY_CONTENT), 'utf8');
  const method = isSymlink ? ZIP_METHOD_STORE : ZIP_METHOD_DEFLATE;
  return {
    contentBytes,
    method,
    compressed: method === ZIP_METHOD_DEFLATE ? zlib.deflateRawSync(contentBytes) : contentBytes,
    externalAttr: ((isSymlink ? SYMLINK_MODE_0777 : FILE_MODE_0644) << 16) >>> 0,
  };
}

/** 手写 ZIP 记录（archiver 会把 `../` 规范化，造不出真样本） */
export async function writeRawZip(destPath, entries) {
  const { time, day } = dosTimestamp(new Date());
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const meta = zipEntryMeta(entry);
    const crc = zlib.crc32(meta.contentBytes) >>> 0;
    localChunks.push(buildZipLocalHeader({ nameBytes, ...meta, crc, time, day }));
    centralChunks.push(buildZipCentralEntry({ nameBytes, ...meta, crc, time, day, offset }));
    offset += ZIP_LOCAL_HEADER_BYTES + nameBytes.length + meta.compressed.length;
  }

  const centralBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(ZIP_EOCD_BYTES);
  eocd.writeUInt32LE(ZIP_SIGNATURE.endOfCentralDir, ZIP_EOCD_FIELD.signature);
  eocd.writeUInt16LE(entries.length, ZIP_EOCD_FIELD.entriesOnDisk);
  eocd.writeUInt16LE(entries.length, ZIP_EOCD_FIELD.totalEntries);
  eocd.writeUInt32LE(centralBuf.length, ZIP_EOCD_FIELD.centralSize);
  eocd.writeUInt32LE(offset, ZIP_EOCD_FIELD.centralOffset);

  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.writeFile(destPath, Buffer.concat([...localChunks, centralBuf, eocd]));
}

/** 把字符串写进 ustar 头：八进制、位数 + NUL 结尾（POSIX 数字字段格式） */
function writeOctalField(header, offset, value, { width, digits }) {
  header.write(`${value.toString(8).padStart(digits, '0')}\0`, offset, width, 'ascii');
}

/**
 * 手写最小 tar 头（只用于**造恶意样本**）：node-tar 的写入 API 不接受任意条目名，
 * 而 zip-slip 用例必须真的把 `../`、绝对路径写进归档里 —— 所以这里自己拼 512 字节 ustar 头。
 * 只服务测试，生产代码的 tar 读写完全交给 node-tar。
 */
function tarHeader(name, size) {
  const header = Buffer.alloc(TAR_HEADER_BYTES);
  header.write(name, TAR_FIELD.name, TAR_NAME_WIDTH, 'utf8');
  writeOctalField(header, TAR_FIELD.mode, TAR_MODE_0644, OCTAL_FIELD_SMALL);
  writeOctalField(header, TAR_FIELD.uid, 0, OCTAL_FIELD_SMALL);
  writeOctalField(header, TAR_FIELD.gid, 0, OCTAL_FIELD_SMALL);
  writeOctalField(header, TAR_FIELD.size, size, OCTAL_FIELD_SIZE);
  writeOctalField(header, TAR_FIELD.mtime, Math.floor(Date.now() / MS_PER_SECOND), OCTAL_FIELD_SIZE);
  header.write('        ', TAR_FIELD.checksum, TAR_CHECKSUM_FIELD.width, 'ascii'); // 校验和先占位，算完再回填
  header.write('0', TAR_FIELD.typeflag, TAR_TYPEFLAG_WIDTH, 'ascii');
  header.write('ustar\0', TAR_FIELD.magic, TAR_MAGIC_WIDTH, 'ascii');
  header.write('00', TAR_FIELD.version, TAR_VERSION_WIDTH, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  // 校验和字段自身的 8 字节按空格参与求和，最终写成 6 位八进制 + NUL + 空格
  header.write(`${sum.toString(8).padStart(TAR_CHECKSUM_FIELD.digits, '0')}\0 `, TAR_FIELD.checksum, TAR_CHECKSUM_FIELD.width, 'ascii');
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
