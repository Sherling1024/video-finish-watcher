#!/usr/bin/env node
/**
 * 在无头 Chromium 里真跑一遍用户脚本，验证「播完 → 响铃 + 通知」这条链路。
 *   node tests/browser.test.mjs
 * 找不到浏览器时跳过（退出码 0），方便在 CI 里无浏览器环境直接跑。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const harness = join(here, 'browser-harness.html');

const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

const browser = candidates.find((p) => existsSync(p));
if (!browser) {
    console.log('skip: 没找到 Chrome/Edge，跳过浏览器集成测试');
    process.exit(0);
}

const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--allow-file-access-from-files',
    '--virtual-time-budget=4000',
    '--dump-dom',
    'file:///' + harness.replace(/\\/g, '/')
];

const res = spawnSync(browser, args, { encoding: 'utf8', timeout: 60000 });
const dom = (res.stdout || '') + (res.stderr || '');

function grab(tag) {
    const m = dom.match(new RegExp(tag + '[^<\\\\]*'));
    return m ? m[0] : '';
}

const mid = grab('RESULT mid');
const end = grab('RESULT end');
const again = grab('RESULT again');
const premute = grab('RESULT premute');
const mute = grab('RESULT mute');
const unmute = grab('RESULT unmute');

const fail = [];
if (!/muted=false/.test(premute)) { fail.push('播放前不该是静音的：' + premute); }
if (!/muted=true/.test(mute)) { fail.push('一播放就应被自动静音：' + (mute || '(无输出)')); }
if (!/muted=false/.test(unmute)) { fail.push('用户取消静音后不该再被强行静音：' + (unmute || '(无输出)')); }
if (!/osc=0 notify=0/.test(mid)) { fail.push('播放中途不应提醒，实际：' + (mid || '(无输出)')); }
if (!/notify=1/.test(end)) { fail.push('播完应发出 1 条通知，实际：' + (end || '(无输出)')); }
if (end && /osc=0/.test(end)) { fail.push('播完应响铃，实际未创建任何音符：' + end); }
if (!/body=.+·.+/.test(end)) { fail.push('通知正文应含片名与时长：' + end); }
if (again && !/notify=1/.test(again)) { fail.push('重复的 ended 不应再次提醒：' + again); }

console.log('browser:', browser);
console.log(' ', premute || '(no premute line)');
console.log(' ', mute || '(no mute line)');
console.log(' ', unmute || '(no unmute line)');
console.log(' ', mid || '(no mid line)');
console.log(' ', end || '(no end line)');
console.log(' ', again || '(no again line)');

if (fail.length) {
    console.log('\nFAILED:');
    fail.forEach((f) => console.log('  - ' + f));
    process.exit(1);
}
console.log('\n浏览器集成测试通过');
