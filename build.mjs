#!/usr/bin/env node
/**
 * 把 src/core.js + src/ui.js 拼成可直接安装的用户脚本。
 *   node build.mjs
 * 输出：dist/video-finish-watcher.user.js
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));

const meta = `// ==UserScript==
// @name         视频播放完成提醒
// @name:en      Video Finish Watcher
// @namespace    https://github.com/Sherling1024/video-finish-watcher
// @version      ${pkg.version}
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

const out = [meta, core, '', ui].join('\n');
await mkdir(join(here, 'dist'), { recursive: true });
await writeFile(join(here, 'dist', 'video-finish-watcher.user.js'), out, 'utf8');

console.log(`built dist/video-finish-watcher.user.js (v${pkg.version}, ${(out.length / 1024).toFixed(1)} KB)`);
