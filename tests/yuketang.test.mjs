#!/usr/bin/env node
/**
 * 雨课堂特别版集成测试：在无头 Chromium 里跑 special 构建，验证
 *   强制静音 / 目录下一集 / 停住续播 / 选择题作答 / 非视频项跳过。
 *   node tests/yuketang.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const harness = join(here, 'yuketang-harness.html');

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
    console.log('skip: 没找到 Chrome/Edge，跳过雨课堂集成测试');
    process.exit(0);
}

const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--allow-file-access-from-files',
    '--virtual-time-budget=5000',
    '--dump-dom',
    'file:///' + harness.replace(/\\/g, '/')
];

const res = spawnSync(browser, args, { encoding: 'utf8', timeout: 60000 });
const dom = (res.stdout || '') + (res.stderr || '');

// 只看页面里 #log 的内容：--dump-dom 会把内联脚本源码也吐出来，直接全文匹配会误判
const logMatch = dom.match(/<pre id="log">([\s\S]*?)<\/pre>/);
const logText = logMatch ? logMatch[1] : '';

function grab(tag) {
    const m = logText.match(new RegExp(tag + '([^<]*)'));
    return m ? (tag + m[1]).split('\n')[0] : '';
}

const forcemute = grab('RESULT forcemute');
const advance = grab('RESULT advance');
const resume = grab('RESULT resume');
const answer = grab('RESULT answer');
const skip = grab('RESULT skip');
const nomodule = grab('RESULT no-module');
const extraAbsent = /RESULT extra absent/.test(logText);
const expectExtra = process.argv.includes('--expect-extra');

const fail = [];
if (nomodule) { fail.push('站点适配模块没有加载'); }
if (!/muted=true/.test(forcemute)) { fail.push('雨课堂应无论如何都静音：' + (forcemute || '(无输出)')); }
if (!/clicks=1\b/.test(advance)) { fail.push('播完应点一次目录下一项：' + (advance || '(无输出)')); }
if (/clicks=1,2/.test(advance)) { fail.push('播完只应点一次，不能连跳：' + advance); }
if (!/active=1/.test(advance)) { fail.push('播完后当前项应切到 1.2：' + advance); }
if (!/plays=1/.test(resume)) { fail.push('停住后应尝试续播：' + (resume || '(无输出)')); }
if (!/paused=false/.test(resume)) { fail.push('续播后不应还是暂停：' + resume); }

if (expectExtra) {
    if (extraAbsent) { fail.push('v1.6 应该有「非视频项」能力，但模块里没有'); }
    if (!/ok=true/.test(answer)) { fail.push('选择题应能作答：' + (answer || '(无输出)')); }
    if (!/picked=A/.test(answer)) { fail.push('应勾选第一个选项：' + answer); }
    if (!/submit=1/.test(answer)) { fail.push('应点一次提交：' + answer); }
    if (!/active=2/.test(skip)) { fail.push('非视频项应跳到下一项（1.3）：' + (skip || '(无输出)')); }
} else if (!extraAbsent) {
    fail.push('v1.5 不该带「非视频项」能力，但模块里有');
}

console.log('browser:', browser);
[forcemute, advance, resume, answer, skip].forEach((l) => console.log('  ' + (l || '(no line)')));
console.log('  mode:', expectExtra ? 'v1.6（含非视频项）' : 'v1.5（仅静音/下一集/续播）');

if (fail.length) {
    console.log('\nFAILED:');
    fail.forEach((f) => console.log('  - ' + f));
    process.exit(1);
}
console.log('\n雨课堂特别版集成测试通过');
