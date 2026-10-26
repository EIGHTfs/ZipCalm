// ZipCrypto（传统加密）算法模块（docs/19 §4.3 算法契约）
//
// 引擎：archiver-zip-encrypted——加密方法名 zip20。
// 兼容性：几乎所有解压工具都支持（Windows 资源管理器 / Linux unzip / 7-Zip），
// 但加密强度弱（可被暴力破解），caveat 必须如实告知用户。

export default {
  id: 'zip20',
  name: 'ZipCrypto（传统）',
  description: '传统 Zip 加密，兼容性最好但强度弱',

  compatibility: {
    sevenZip: true,
    winZip: true,
    macArchiveUtility: true,
    winExplorer: true,
    linuxUnzip: true,
  },
  caveat: '几乎所有工具可解，但加密强度弱（可被破解），敏感数据请选 AES-256',

  available() {
    return true;
  },

  engine: {
    archiverFormat: 'zip-encrypted',
    encryptionMethod: 'zip20',
  },
};
