// tar 系列的**压缩层策略**（tar / tar.gz / tar.zst 只差这一层）
//
// zstd 走「能力自探测 + 回退链」（docs/02 §二）：
//   ① Node ≥ 22.15 内置 `node:zlib` 的 zstd（零依赖、流式）—— 首选；
//   ② 系统 `zstd` 命令（`ZC_ZSTD_BIN` 可覆盖路径）；
//   ③ 都不可用 → `available()=false` 并给出原因（由上层 tarFamily 组装）。
//
// 排障开关：`ZIPCALM_DISABLE_BUILTIN_ZSTD=1` 强制禁用内置实现，用于验证回退链是否真的生效。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import zlib from 'node:zlib';

import { ERROR_CODES, apiError } from '../../../../lib/errors.js';

/** Node 内置 zstd 是否可用（可用环境变量强制禁用，便于验证回退链） */
export function builtinZstdUsable() {
  if (process.env.ZIPCALM_DISABLE_BUILTIN_ZSTD === '1') return false;
  return typeof zlib.createZstdCompress === 'function' && typeof zlib.createZstdDecompress === 'function';
}

/** 系统 zstd 命令探测：ZC_ZSTD_BIN 覆盖 → PATH 查找（找不到返回 null） */
export function findZstdBinary() {
  const override = process.env.ZC_ZSTD_BIN;
  if (override) {
    try {
      fs.accessSync(override, fs.constants.X_OK);
      return override;
    } catch {
      // 指定了但不可执行：视为不可用，不静默落到 PATH（避免"以为换了实现其实没换"）
      return null;
    }
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'zstd');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

/** 把一个外部命令包装成 Duplex（stdin 进 / stdout 出），失败即 destroy —— 回退链的流式实现 */
export function spawnDuplex(command, args, label) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const duplex = new Duplex({
    write(chunk, encoding, callback) {
      if (child.stdin.write(chunk, encoding)) callback();
      else child.stdin.once('drain', callback);
    },
    final(callback) {
      child.stdin.end();
      callback();
    },
    read() {
      child.stdout.resume();
    },
  });
  let exited = false;
  child.stdout.on('data', (chunk) => {
    if (!duplex.push(chunk)) child.stdout.pause();
  });
  child.stdout.on('end', () => {
    if (!exited) duplex.push(null);
  });
  child.on('error', (error) => duplex.destroy(apiError(ERROR_CODES.INTERNAL_ERROR, `${label} 启动失败：${error.message}`)));
  child.on('close', (code) => {
    exited = true;
    if (code !== 0) duplex.destroy(apiError(ERROR_CODES.INTERNAL_ERROR, `${label} 退出码 ${code}`));
    else duplex.push(null);
  });
  return duplex;
}

/** 压缩流（写归档时用；compression='none' 返回 undefined 表示不套压缩层） */
export function createCompressStream(compression, level) {
  if (compression === 'gzip') return zlib.createGzip({ level });
  if (compression === 'zstd') {
    if (builtinZstdUsable()) {
      return zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: level } });
    }
    const binary = findZstdBinary();
    if (!binary) throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, 'zstd 不可用：Node 内置不可用且未找到系统 zstd');
    return spawnDuplex(binary, [`-${level}`, '-q', '-c'], 'zstd');
  }
  return undefined;
}

/** 解压流（读归档时用） */
export function createDecompressStream(compression) {
  if (compression === 'gzip') return zlib.createGunzip();
  if (compression === 'zstd') {
    if (builtinZstdUsable()) return zlib.createZstdDecompress();
    const binary = findZstdBinary();
    if (!binary) throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, 'zstd 不可用：Node 内置不可用且未找到系统 zstd');
    return spawnDuplex(binary, ['-d', '-q', '-c'], 'zstd');
  }
  return undefined;
}

/** 打开归档并接上解压层（返回可读流；解析错误由调用方映射成 ARCHIVE_CORRUPTED） */
export function openArchiveStream(archivePath, compression) {
  const source = fs.createReadStream(archivePath);
  const decompressor = createDecompressStream(compression);
  if (!decompressor) return source;
  source.on('error', (error) => decompressor.destroy(error));
  return source.pipe(decompressor);
}
