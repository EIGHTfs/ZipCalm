// 乱码文件名的识别与还原（**跨格式共享**：zip / tar / 7z / rar 都受益）
//
// 原理（实测，见 docs/17 D-13）：老版 unrar（5.70）与 node-unrar-js（内置 6.1.7）等引擎，
// 在处理 RAR5 的 UTF-8 文件名时会把字节**逐个**转成 Unicode 私有区字符，并在开头插一个 U+FFFE 标记：
//
//   原始字节  e4 b8 ad e6 96 87 …（"中文…"）
//   落盘名    73 37 2f efbfbe ee83a4 ee82b8 ee82ad …
//             └s7/┘└U+FFFE┘└── U+E0XX（= 原字节 0xXX）──┘
//
// 这是**无损字节转义**：去掉 U+FFFE，把每个 U+E0xx 还原成字节 0xXX，拼回 UTF-8 即得原名。
//
// ⚠️ 前置条件：引擎必须在 `en_US.UTF-8`（或 zh_CN.UTF-8）下运行。默认 locale 与 **C.UTF-8** 都会
// 输出有损的 `?`（字节已丢，不可还原）—— 这是实测踩到的陷阱。
//
// 判定**宁严勿松**：宁可漏还原（用户还能手动改），也不能误改正常文件名。
// 三重校验全过才还原：① 含 U+FFFE 标记 ② 解码结果是合法 UTF-8 ③ 往返一致（重新编码 == 原始字节）。

/** 私有区字节替身的码点范围：U+E000..U+E0FF 对应原始字节 0x00..0xFF */
const PUA_BYTE_BASE = 0xe000;
const PUA_BYTE_MAX = 0xe0ff;
/** 转义标记：U+FFFE（非字符，正常文件名不可能包含） */
const ESCAPE_MARKER = '\uFFFE';

/** 名字里是否带转义标记（**硬门槛**：没有标记一律不动） */
export function hasEscapeMarker(name) {
  return String(name || '').includes(ESCAPE_MARKER);
}

/**
 * 按 PUA 转义规则还原成字节，再解成 UTF-8 字符串。
 * @param {string} name
 * @returns {string} 还原结果（调用方必须自己再做校验，本函数不做判断）
 */
export function decodePuaEscaped(name) {
  const cleaned = String(name || '').replaceAll(ESCAPE_MARKER, '');
  const bytes = [];
  for (const ch of cleaned) {
    const cp = ch.codePointAt(0);
    if (cp >= PUA_BYTE_BASE && cp <= PUA_BYTE_MAX) bytes.push(cp - PUA_BYTE_BASE);
    else if (cp < 0x80) bytes.push(cp);
    else bytes.push(...Buffer.from(ch, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** 把转义名还原出的原始字节序列（供报告里贴 hex） */
export function escapedBytesHex(name) {
  const cleaned = String(name || '').replaceAll(ESCAPE_MARKER, '');
  const bytes = [];
  for (const ch of cleaned) {
    const cp = ch.codePointAt(0);
    if (cp >= PUA_BYTE_BASE && cp <= PUA_BYTE_MAX) bytes.push(cp - PUA_BYTE_BASE);
    else if (cp < 0x80) bytes.push(cp);
    else bytes.push(...Buffer.from(ch, 'utf8'));
  }
  return Buffer.from(bytes).toString('hex');
}

/**
 * 判定单条名字是否应还原（三重校验）。
 * @param {string} name
 * @returns {{name: string, repaired: boolean, reason: string|null, hex?: string}}
 */
export function repairName(name) {
  const original = String(name || '');
  // ① 硬门槛：必须含 U+FFFE 标记（正常名即使含合法私有区字符也不会被误改）
  if (!hasEscapeMarker(original)) return { name: original, repaired: false, reason: null };
  const hex = escapedBytesHex(original);
  const candidate = decodePuaEscaped(original);
  // ② 必须是合法 UTF-8（解出替换符说明字节非法）
  if (!candidate || candidate.includes('\uFFFD')) {
    return { name: original, repaired: false, reason: 'invalid-utf8', hex };
  }
  // ③ 往返一致：把结果按 UTF-8 重新编码，必须等于原始字节序列
  if (Buffer.from(candidate, 'utf8').toString('hex') !== hex) {
    return { name: original, repaired: false, reason: 'roundtrip-mismatch', hex };
  }
  // 路径结构必须仍然正常（不允许还原出空段 / . / ..，防止藏在转义里的越界）
  //
  // 注意：**目录条目名带尾部 '/'**（收集阶段就是用尾斜杠标记目录的），
  // 不能把那个尾斜杠当成「空段」判成非法 —— 否则凡是被转义的目录名都永远还原不了，
  // 而它的子文件却能还原，结果是目录与子项名字对不上、结构错位（实测踩到）。
  const hadTrailingSlash = candidate.endsWith('/');
  const body = hadTrailingSlash ? candidate.slice(0, -1) : candidate;
  if (body.length === 0) return { name: original, repaired: false, reason: 'unsafe-path', hex };
  const segments = body.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { name: original, repaired: false, reason: 'unsafe-path', hex };
  }
  const decoded = hadTrailingSlash ? `${body}/` : body;
  if (decoded === original) return { name: original, repaired: false, reason: null };
  return { name: decoded, repaired: true, reason: null, hex };
}

/**
 * 批量还原一组条目名，并处理"还原后撞名"。
 *
 * 撞名策略：**保留原名**（不静默覆盖、不静默改名），把冲突记进 conflicts 交给调用方记日志/报告。
 *
 * @param {Array<{name: string}>} entries
 * @returns {{entries: Array, repaired: number, conflicts: Array<{from: string, to: string, reason: string}>}}
 */
export function repairEntries(entries) {
  const conflicts = [];
  const taken = new Set(entries.map((entry) => String(entry.name || '')));
  let repaired = 0;

  const next = entries.map((entry) => {
    const verdict = repairName(entry.name);
    if (!verdict.repaired) return entry;
    // 同一批里还原后与他人（原始名或已还原名）撞名 → 放弃这次还原
    if (taken.has(verdict.name) && verdict.name !== entry.name) {
      conflicts.push({ from: entry.name, to: verdict.name, reason: 'target-exists' });
      return entry;
    }
    taken.delete(String(entry.name || ''));
    taken.add(verdict.name);
    repaired += 1;
    return { ...entry, name: verdict.name, nameRepairedFrom: entry.name };
  });

  return { entries: next, repaired, conflicts };
}
