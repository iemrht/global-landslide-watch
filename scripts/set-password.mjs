// 用法：pnpm set-password  （按提示输入新密码，输入时不显示）
// 只把 SHA-256 摘要写进 src/StaticAccessGate.tsx，明文不会进入代码或仓库。
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';

function ask(prompt) {
  return new Promise((resolve) => {
    stdout.write(prompt);
    let value = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') { stdin.setRawMode?.(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); resolve(value); }
      else if (ch === '\u0003') process.exit(1);
      else if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
      else value += ch;
    };
    stdin.on('data', onData);
  });
}

const first = await ask('新密码：');
const second = await ask('再输一次：');
if (!first || first !== second) { console.error('两次输入不一致或为空，未修改。'); process.exit(1); }
const hash = createHash('sha256').update(first, 'utf8').digest('hex');
const file = new URL('../src/StaticAccessGate.tsx', import.meta.url);
const source = readFileSync(file, 'utf8');
const next = source.replace(/const PASSWORD_SHA256 = '[0-9a-f_A-Z]+';/, `const PASSWORD_SHA256 = '${hash}';`);
if (next === source) { console.error('没有找到密码配置行，未修改。'); process.exit(1); }
writeFileSync(file, next);
console.log('已更新访问密码。提交并推送后，网站重新部署即生效。');
