// 压缩格式清单（前后端共用的唯一来源）
//
// 依据：docs/M0/插件契约.md §六「四个格式对号入座」+ docs/M0/数据模型.md §一。
// 这里只放「契约级」的静态元数据（id / 扩展名 / MIME / 显示名 / 级别范围）；
// 运行期可用性（available）必须由后端 GET /api/v1/formats 返回，前端不猜。

export const FORMAT_IDS = Object.freeze({
  ZIP: 'zip',
  TAR: 'tar',
  TARGZ: 'targz',
  TARZST: 'tarzst',
});

/** zstd 支持的压缩级别上限（zstd 规范值；与格式包 levelRange 保持一致） */
const ZSTD_MAX_LEVEL = 19;

export const FORMATS = Object.freeze([
  {
    id: FORMAT_IDS.ZIP,
    name: 'ZIP',
    ext: '.zip',
    extAliases: [],
    mime: 'application/zip',
    defaultLevel: 6,
    levelRange: [0, 9],
  },
  {
    id: FORMAT_IDS.TAR,
    name: 'TAR',
    ext: '.tar',
    extAliases: [],
    mime: 'application/x-tar',
    defaultLevel: null, // tar 本身不压缩，无级别概念
    levelRange: null,
  },
  {
    id: FORMAT_IDS.TARGZ,
    name: 'TAR.GZ',
    ext: '.tar.gz',
    extAliases: ['.tgz'],
    mime: 'application/gzip',
    defaultLevel: 6,
    levelRange: [0, 9],
  },
  {
    id: FORMAT_IDS.TARZST,
    name: 'TAR.ZST',
    ext: '.tar.zst',
    extAliases: ['.tzst'],
    mime: 'application/zstd',
    defaultLevel: 3,
    levelRange: [1, ZSTD_MAX_LEVEL],
  },
]);

export const FORMAT_VALUES = Object.freeze(FORMATS.map((item) => item.id));

// 默认格式：docs/08 第八节「默认值预设合理：格式 zip」
export const FORMAT_DEFAULT = FORMAT_IDS.ZIP;

// 按 id 索引
const FORMAT_BY_ID = new Map(FORMATS.map((item) => [item.id, item]));

// 扩展名索引：复合扩展名整体入表（.tar.gz 不拆成 .gz），保证「最长匹配优先」
const FORMAT_BY_EXT = new Map();
for (const format of FORMATS) {
  for (const ext of [format.ext, ...format.extAliases]) {
    FORMAT_BY_EXT.set(ext.toLowerCase(), format);
  }
}

export function isFormatId(value) {
  return FORMAT_VALUES.includes(value);
}

export function getFormat(id) {
  return FORMAT_BY_ID.get(id) || null;
}

export function getFormatExt(id) {
  const format = getFormat(id);
  return format ? format.ext : null;
}

export function getFormatMime(id) {
  const format = getFormat(id);
  return format ? format.mime : 'application/octet-stream';
}

// 扩展名 → 格式 id：按「扩展名长度降序」匹配，避免 .gz 抢走 .tar.gz（对齐插件契约 §五 匹配优先级）
export function getFormatIdByExt(ext) {
  if (typeof ext !== 'string' || ext === '') return null;
  const lower = ext.toLowerCase();
  const candidates = [...FORMAT_BY_EXT.keys()].sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    if (lower === candidate || lower.endsWith(candidate)) {
      return FORMAT_BY_EXT.get(candidate).id;
    }
  }
  return null;
}
