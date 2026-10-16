// 密码哈希（scrypt，Node 内置，零依赖）
//
// 为什么不用明文比较、也不引 bcrypt：NAS 上不想再引原生编译依赖（项目原则：优先成熟库，但
// 这里的"成熟库"bcrypt/argon2 都要原生编译，在本机 noexec/NFS 环境下风险高）。
// Node 内置 scrypt 属标准方案，格式自带参数，便于将来升级参数而不破坏老哈希。
//
// 存储格式：scrypt$N$r$p$<salt-base64>$<hash-base64>
// 只存哈希与随机盐，不存明文（INV-16）。

import crypto from 'node:crypto';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptAsync(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

/**
 * 生成密码哈希。
 * @param {string} password 明文
 * @returns {Promise<string>} scrypt$ 开头的字符串
 */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('hashPassword 需要非空字符串');
  }
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(password, salt, SCRYPT_PARAMS);
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/** 解析 scrypt$ 哈希串 → 派生参数；格式不对返回 null（不抛错，调用方按"校验失败"处理） */
function parseScryptHash(stored) {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;

  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const params = {
    N: Number.parseInt(nRaw, 10),
    r: Number.parseInt(rRaw, 10),
    p: Number.parseInt(pRaw, 10),
    keylen: Buffer.from(hashB64, 'base64').length,
  };
  const valid = Number.isInteger(params.N) && Number.isInteger(params.r) && Number.isInteger(params.p) && params.keylen > 0;
  return valid ? { params, saltB64, hashB64 } : null;
}

/**
 * 校验密码（timing-safe 比较）。
 * @param {string} password 明文
 * @param {string} stored 存储的哈希（scrypt$ 格式）
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parsed = parseScryptHash(stored);
  if (!parsed) return false;

  try {
    const derived = await scryptAsync(password, Buffer.from(parsed.saltB64, 'base64'), parsed.params);
    const expected = Buffer.from(parsed.hashB64, 'base64');
    if (expected.length !== derived.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** 生成不透明随机串（session id / bearer token 的明文形态） */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** 只存储哈希：日志与磁盘里都不会出现可用于登录的明文（INV-16） */
export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
