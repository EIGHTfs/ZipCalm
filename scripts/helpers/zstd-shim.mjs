#!/usr/bin/env node
//
// zstd 命令垫片（**仅用于测试**：验证「Node 内置不可用时回退系统 zstd 命令」这条链路）
//
// 本机没有系统 zstd（docs/02 实测），所以回退链没法用真二进制验证。
// 这个垫片实现 zstd CLI 的最小可用表面（`-N` 级别 / `-d` 解压 / `-q` 安静 / `-c` 输出到 stdout），
// 内部直接用 node:zlib 的 zstd 做同样的活 —— 于是"回退到外部命令"的代码路径可以被端到端验证：
//   ZIPCALM_DISABLE_BUILTIN_ZSTD=1 ZC_ZSTD_BIN=<本垫片> → 服务仍应能跑 .tar.zst 往返。
//
// 用法（服务端会在 create/extract 里这样调）：
//   zstd-shim -3 -q -c      # 压缩
//   zstd-shim -d -q -c      # 解压

import zlib from 'node:zlib';

const args = process.argv.slice(2);
const decompress = args.includes('-d');
const levelArg = args.find((item) => /^-\d+$/.test(item));
const level = levelArg ? Number.parseInt(levelArg.slice(1), 10) : 3;

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('error', (error) => {
  process.stderr.write(`zstd-shim stdin error: ${error.message}\n`);
  process.exit(1);
});
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  try {
    const output = decompress
      ? zlib.zstdDecompressSync(input)
      : zlib.zstdCompressSync(input, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } });
    process.stdout.write(output);
  } catch (error) {
    process.stderr.write(`zstd-shim failed: ${error.message}\n`);
    process.exit(1);
  }
});
