#!/usr/bin/env node
/**
 * 把 src 里的文件拼成可直接安装的用户脚本。
 *   node build.mjs                  → dist/video-finish-watcher.user.js        （普通版，任意站点）
 *   node build.mjs special [ver]    → dist/video-finish-watcher-special.user.js（雨课堂特别版）
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));

const special = process.argv[2] === 'special';
const version = special ? (process.argv[3] || `${pkg.version}-special`) : pkg.version;

const meta = special ? `// ==UserScript==
// @name         视频播放完成提醒 · 雨课堂特别版
// @name:en      Video Finish Watcher (Yuketang Special Edition)
// @namespace    https://github.com/Sherling1024/video-finish-watcher
// @version      ${version}
// @description  雨课堂专用：视频默认静音、目录自动下一集、停住自动续播、非视频项自动跳过
// @description:en  Yuketang tweaks: always mute, auto-advance the course list, auto-resume playback.
// @author       Sherling1024
// @homepageURL  https://github.com/Sherling1024/video-finish-watcher
// @supportURL   https://github.com/Sherling1024/video-finish-watcher/issues
// @match        *://*.yuketang.cn/*
// @match        *://yuketang.cn/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==
` : `// ==UserScript==
// @name         视频播放完成提醒
// @name:en      Video Finish Watcher
// @namespace    https://github.com/Sherling1024/video-finish-watcher
// @version      ${version}
// @description  网页视频播放结束后响铃 + 系统通知 + 标题闪烁
// @description:en  Ring a bell and notify when a web video finishes playing.
// @author       Sherling1024
// @homepageURL  https://github.com/Sherling1024/video-finish-watcher
// @supportURL   https://github.com/Sherling1024/video-finish-watcher/issues
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==
`;

const core = await readFile(join(here, 'src', 'core.js'), 'utf8');
const ui = await readFile(join(here, 'src', 'ui.js'), 'utf8');
const parts = [meta, core, '', ui];
if (special) {
    parts.push('', await readFile(join(here, 'src', 'site-yuketang.js'), 'utf8'));
}
const out = parts.join('\n');

const distDir = join(here, 'dist');
await mkdir(distDir, { recursive: true });
const file = special ? 'video-finish-watcher-special.user.js' : 'video-finish-watcher.user.js';
await writeFile(join(distDir, file), out, 'utf8');

console.log(`built dist/${file} (v${version}, ${(out.length / 1024).toFixed(1)} KB)`);
