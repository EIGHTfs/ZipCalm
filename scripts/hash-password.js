#!/usr/bin/env node
//
// 生成密码哈希（scrypt），用于写进 storage/config.json 的 auth.passwordHash
//
// 用法：
//   node scripts/hash-password.js '你的密码'
//   node scripts/hash-password.js            # 不传参数则交互式读取（隐藏输入）
//
// 输出形如：scrypt$16384$8$1$<salt>$<hash>
// 注意：只把哈希写进配置；明文不要落到任何文件里（INV-16）。

import { hashPassword } from '../server/core/auth/password.js';

/** 交互式读取密码（不回显）；非 TTY 时退回读取 stdin 第一行 */
function readPasswordHidden(prompt) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    return new Promise((resolve, reject) => {
      process.stdin.on('data', (chunk) => chunks.push(chunk));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').split('\n')[0]));
      process.stdin.on('error', reject);
    });
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(prompt);

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let input = '';
    const onData = (char) => {
      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(input);
        return;
      }
      if (char === '\u0003') {
        // Ctrl+C
        stdin.setRawMode(false);
        stdout.write('\n');
        reject(new Error('已取消'));
        return;
      }
      if (char === '\u007f' || char === '\b') {
        input = input.slice(0, -1);
        return;
      }
      input += char;
    };
    stdin.on('data', onData);
  });
}

async function main() {
  let password = process.argv[2];
  if (!password) {
    password = await readPasswordHidden('请输入密码（不回显）：');
  }
  if (!password || password.length === 0) {
    process.stderr.write('密码不能为空。\n');
    process.exit(2);
  }
  const hash = await hashPassword(password);
  process.stdout.write(`${hash}\n`);
  process.stderr.write('提示：把上面这行填进 storage/config.json 的 auth.passwordHash（该目录已 gitignore）。\n');
}

main().catch((error) => {
  process.stderr.write(`生成失败：${error.message}\n`);
  process.exit(1);
});
