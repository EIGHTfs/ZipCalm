// AES-256 加密算法模块（docs/19 §4.3 算法契约）
//
// 引擎：archiver-zip-encrypted（纯 JS，aes-js）——加密方法名 aes256。
// 兼容性事实来自实测与 docs/18 §附二：7-Zip / WinZip / macOS 归档工具可解；
// Linux Info-ZIP unzip 6.00 与 Windows 资源管理器**解不开**（资源管理器能看列表）。

export default {
  id: 'aes256',
  name: 'AES-256',
  description: 'WinZip 2003 标准（AES-256），安全性最高',

  compatibility: {
    sevenZip: true,
    winZip: true,
    macArchiveUtility: true,
    winExplorer: false, // 能看列表不能解压
    linuxUnzip: false, // Info-ZIP unzip 6.00 不支持
  },
  caveat: 'Linux unzip 6.00 与 Windows 资源管理器无法解开；7-Zip / WinZip / macOS 可解',

  // 纯 JS 实现，无外部依赖，恒可用
  available() {
    return true;
  },

  // 引擎适配：能力插件 prepareCreate 把它展开进格式插件的 create 选项
  engine: {
    archiverFormat: 'zip-encrypted',
    encryptionMethod: 'aes256',
  },
};
