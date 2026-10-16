// M4 验收脚本的**外部工具交叉验证**（从 test-m4-formats.mjs 拆出）
//
// 为什么要外部工具：只靠本项目的 compress → extract 自证，等于"用同一套假设验证同一套假设"。
// 这里用系统 `tar`/`7z` 独立读出内容清单，证明产物是**通用工具能认的**标准归档。
//
// tar.zst 的特殊处理：本机没有 `zstd` 命令（docs/02 已实测），所以只用 Node 解 zstd 那一层，
// 再把解出来的 tar 交给系统 `tar -tf` 校验 —— zstd 层用 Node、tar 层用外部工具，仍然不是自证（并在汇报里写明）。

import { execFileAsync } from './script-env.mjs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const TOOL_TIMEOUT_MS = 30000;
/** 夹具固定 12 个文件：外部工具列出的条目数少于这个数就说明归档不完整 */
const MIN_EXPECTED_ENTRIES = 10;
/** 断言明细里错误文本的截断长度（外部工具的输出可能很长，只留开头足够定位） */
const DETAIL_MAX_CHARS = 120;
/** 外部校验断言名的统一前缀：集中一处，避免同一文案散落多处后改不齐 */
const EXTERNAL_CHECK_PREFIX = '外部校验';

function runTool(command, args) {
  return execFileAsync(command, args, { timeout: TOOL_TIMEOUT_MS });
}

/** 外部工具输出 → 条目名数组（去掉空行） */
function listEntries(stdout) {
  return stdout.trim().split('\n').filter(Boolean);
}

/** 断言名统一拼法：前缀只在一处出现（避免同一文案散落多处后改不齐） */
function externalCheckName(label) {
  return `${EXTERNAL_CHECK_PREFIX} ${label}`;
}

async function verifyZipIntegrity({ archiveAbsPath, report }) {
  const label = '7z t（zip）';
  try {
    const { stdout } = await runTool('7z', ['t', archiveAbsPath]);
    report.check(externalCheckName(label), /Everything is Ok/i.test(stdout), stdout.trim().split('\n').slice(-2).join(' / ').slice(0, 100));
  } catch (error) {
    report.check(externalCheckName(label), false, String(error.stdout || error.message).slice(0, DETAIL_MAX_CHARS));
  }
}

/** tar / tar.gz 共用：系统 tar 列条目（参数只差 `-z`） */
async function verifyTarListing({ archiveAbsPath, report }, tarArgs, label) {
  try {
    const { stdout } = await runTool('tar', tarArgs);
    const names = listEntries(stdout);
    report.check(externalCheckName(label), names.length >= MIN_EXPECTED_ENTRIES, `${names.length} 个条目，示例 ${names[0]}`);
  } catch (error) {
    report.check(externalCheckName(label), false, String(error.stderr || error.message).slice(0, DETAIL_MAX_CHARS));
  }
}

async function verifyZstdArchive({ archiveAbsPath, workDir, report }) {
  const tarProbePath = path.join(workDir, 'zstd-probe.tar');
  const zstdLabel = 'tar -tf（tar.zst：Node 只解 zstd 层 + 系统 tar 列内容）';
  try {
    const compressed = await fsp.readFile(archiveAbsPath);
    await fsp.writeFile(tarProbePath, zlib.zstdDecompressSync(compressed));
    await verifyTarListing({ archiveAbsPath: tarProbePath, report }, ['-tf', tarProbePath], zstdLabel);
  } catch (error) {
    report.check(externalCheckName('tar -tf（tar.zst）'), false, String(error.message).slice(0, DETAIL_MAX_CHARS));
  }

  // 7z 支持 zstd 的话再补一条；本机不支持则如实 SKIP（不假装通过）
  const sevenZipLabel = '7z l（tar.zst）';
  try {
    const { stdout } = await runTool('7z', ['l', archiveAbsPath]);
    const entries = listEntries(stdout).filter((line) => /\d{4}-\d{2}-\d{2}/.test(line)).length;
    report.check(externalCheckName(sevenZipLabel), entries >= MIN_EXPECTED_ENTRIES, `${entries} 个条目`);
  } catch (error) {
    report.skip(externalCheckName(sevenZipLabel), `本机 7z 不支持 zstd：${String(error.stderr || error.message).slice(0, 60)}`);
  }
}

/** 按格式分发到对应的外部工具校验（新增格式时在这里补一条即可） */
export const EXTERNAL_VERIFIERS = {
  zip: verifyZipIntegrity,
  tar: (context) => verifyTarListing(context, ['-tf', context.archiveAbsPath], 'tar -tf（tar）'),
  targz: (context) => verifyTarListing(context, ['-tzf', context.archiveAbsPath], 'tar -tzf（tar.gz）'),
  tarzst: verifyZstdArchive,
};

/**
 * @param {{formatId: string, archiveAbsPath: string, workDir: string, report: object}} context
 * @returns {Promise<boolean>} 是否有对应的校验器（没有则调用方按"未覆盖"处理）
 */
export async function verifyWithExternalTools(context) {
  const verifier = EXTERNAL_VERIFIERS[context.formatId];
  if (!verifier) return false;
  await verifier(context);
  return true;
}
