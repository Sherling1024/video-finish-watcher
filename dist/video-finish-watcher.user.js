// ==UserScript==
// @name         视频播放完成提醒
// @name:en      Video Finish Watcher
// @namespace    https://github.com/Sherling1024/video-finish-watcher
// @version      1.2.0
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

/*!
 * video-finish-watcher · 核心逻辑（纯函数，无 DOM 依赖，可在 Node 中直接测试）
 * 被 build.mjs 拼接进最终的用户脚本：浏览器与 Node 共用同一份判定代码。
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) { module.exports = api; }
    else { root.VFW = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var DEFAULT_CONFIG = {
        enabled: true,        // 总开关
        volume: 0.55,         // 铃声音量 0~1
        ringCount: 2,         // 响几轮（每轮 3 声）
        thresholdSec: 0.6,    // 距离片尾多少秒算「已经播完」（兜底，防止站点吞掉 ended）
        minDurationSec: 20,   // 短于此长度的视频不提醒（过滤广告 / 预览 / 动图视频）
        notify: true,         // 系统通知
        flashTitle: true,     // 标签页标题闪烁
        pauseOthers: true,    // 完成后暂停同页其它正在播的视频
        autoMute: true,       // 视频一开始播放就自动静音（用户手动取消静音后不再强行静音）
        autoNext: true,       // 播完后自动点击「下一集 / 下一个视频」
        ytForceMute: true,    // 雨课堂特别版：无论如何都静音
        ytAutoResume: true,   // 雨课堂特别版：视频停住就继续播
        ytSkipNonVideo: true, // 雨课堂特别版：非视频项（讨论/课件）自动跳过
        ytAutoAnswer: true    // 雨课堂特别版：选择题尝试自动作答
    };

    var LIMITS = {
        volume: [0, 1],
        ringCount: [1, 5],
        thresholdSec: [0, 10],
        minDurationSec: [0, 3600]
    };

    function num(value, dflt) {
        if (value === null || value === undefined || value === '') { return dflt; }
        var n = Number(value);
        return isFinite(n) ? n : dflt;
    }

    function clampIn(value, range, dflt) {
        var n = num(value, dflt);
        if (n < range[0]) { return range[0]; }
        if (n > range[1]) { return range[1]; }
        return n;
    }

    /** 把外部传入（localStorage / 旧版本）的配置补齐、夹取到合法范围。 */
    function normalizeConfig(raw) {
        var src = raw && typeof raw === 'object' ? raw : {};
        var out = {};
        out.enabled = src.enabled === undefined ? DEFAULT_CONFIG.enabled : !!src.enabled;
        out.notify = src.notify === undefined ? DEFAULT_CONFIG.notify : !!src.notify;
        out.flashTitle = src.flashTitle === undefined ? DEFAULT_CONFIG.flashTitle : !!src.flashTitle;
        out.pauseOthers = src.pauseOthers === undefined ? DEFAULT_CONFIG.pauseOthers : !!src.pauseOthers;
        out.autoMute = src.autoMute === undefined ? DEFAULT_CONFIG.autoMute : !!src.autoMute;
        out.autoNext = src.autoNext === undefined ? DEFAULT_CONFIG.autoNext : !!src.autoNext;
        out.ytForceMute = src.ytForceMute === undefined ? DEFAULT_CONFIG.ytForceMute : !!src.ytForceMute;
        out.ytAutoResume = src.ytAutoResume === undefined ? DEFAULT_CONFIG.ytAutoResume : !!src.ytAutoResume;
        out.ytSkipNonVideo = src.ytSkipNonVideo === undefined ? DEFAULT_CONFIG.ytSkipNonVideo : !!src.ytSkipNonVideo;
        out.ytAutoAnswer = src.ytAutoAnswer === undefined ? DEFAULT_CONFIG.ytAutoAnswer : !!src.ytAutoAnswer;
        out.volume = clampIn(src.volume, LIMITS.volume, DEFAULT_CONFIG.volume);
        out.ringCount = Math.round(clampIn(src.ringCount, LIMITS.ringCount, DEFAULT_CONFIG.ringCount));
        out.thresholdSec = clampIn(src.thresholdSec, LIMITS.thresholdSec, DEFAULT_CONFIG.thresholdSec);
        out.minDurationSec = clampIn(src.minDurationSec, LIMITS.minDurationSec, DEFAULT_CONFIG.minDurationSec);
        return out;
    }

    /**
     * 单个视频的「播完」判定状态机。
     * 用法：每个 <video> 一个实例，在 timeupdate / ended / play 时调用 tick()。
     * 返回事件对象表示「本次播放刚刚播完」，只会返回一次；用户重播或拖回开头会重新武装。
     *
     * @param {object} config 已归一化的配置
     */
    function createWatcher(config) {
        var cfg = normalizeConfig(config);
        var armed = true;      // 可以触发提醒
        var lastTime = 0;

        function rearm() { armed = true; }

        /**
         * @param {object} info 来自 video 元素的快照
         *   { currentTime, duration, ended, paused, seeking, loop, muted, readyState }
         * @returns {null | { reason: string, currentTime: number, duration: number, progress: number }}
         */
        function tick(info) {
            if (!cfg.enabled || !info) { return null; }

            var duration = num(info.duration, NaN);
            var current = num(info.currentTime, 0);

            // 元数据没就绪 / 直播流（duration 为 Infinity）/ 太短的片段：不参与判定
            if (!isFinite(duration) || duration <= 0) { lastTime = current; return null; }
            if (duration < cfg.minDurationSec) { lastTime = current; return null; }
            if (info.loop) { lastTime = current; return null; }

            // 往回拖 / 重新开始：重新武装
            if (current < lastTime - 2) { rearm(); }
            // 从头重播（含 seek 到 0 后再次播放）
            if (current <= 1 && !info.paused) { rearm(); }

            var fired = null;
            var remain = duration - current;

            if (info.ended) {
                fired = { reason: 'ended' };
            } else if (!info.paused && !info.seeking && remain <= cfg.thresholdSec && current > cfg.thresholdSec) {
                // 有些站点在片尾前把自己接管了，ended 不再派发，用进度兜底
                fired = { reason: 'near-end' };
            } else if (info.paused && remain <= 0.05 && current > cfg.thresholdSec) {
                // 有的播放器到片尾直接暂停，不置 ended
                fired = { reason: 'paused-at-end' };
            }

            lastTime = current;

            if (!fired || !armed) { return null; }
            if (info.seeking) { return null; }

            armed = false;
            fired.currentTime = current;
            fired.duration = duration;
            fired.progress = duration > 0 ? current / duration : 1;
            return fired;
        }

        return {
            tick: tick,
            rearm: rearm,
            get armed() { return armed; },
            get config() { return cfg; },
            setConfig: function (next) { cfg = normalizeConfig(next); }
        };
    }

    /**
     * 生成铃声节奏：每轮 3 声（A5 → D6 → A5），轮与轮之间留一点间隔。
     * @returns {Array<{ freq: number, atMs: number, durMs: number, peak: number }>}
     */
    function buildRingPattern(config) {
        var cfg = normalizeConfig(config);
        var notes = [880.0, 1174.66, 880.0];
        var perNote = 190;
        var noteGap = 70;
        var roundGap = 420;
        var pattern = [];
        var t = 0;
        for (var r = 0; r < cfg.ringCount; r++) {
            for (var i = 0; i < notes.length; i++) {
                pattern.push({
                    freq: notes[i],
                    atMs: t,
                    durMs: perNote,
                    peak: cfg.volume * (i === 1 ? 1 : 0.85)
                });
                t += perNote + noteGap;
            }
            t += roundGap;
        }
        return pattern;
    }

    /** 通知正文：留一点上下文，方便事后回想是哪个视频。 */
    function describeFinish(title, event) {
        var name = String(title || '').trim() || '视频';
        var dur = event && isFinite(event.duration) ? formatClock(event.duration) : '';
        return dur ? (name + ' · ' + dur) : name;
    }

    function formatClock(seconds) {
        var s = Math.max(0, Math.round(num(seconds, 0)));
        var h = Math.floor(s / 3600);
        var m = Math.floor((s % 3600) / 60);
        var sec = s % 60;
        var mm = (h > 0 && m < 10 ? '0' : '') + m;
        var ss = (sec < 10 ? '0' : '') + sec;
        return (h > 0 ? h + ':' : '') + mm + ':' + ss;
    }

    /** 页面上可能有多个视频：给同一个「完成」只提醒一次，避免 1 秒内连响两遍。 */
    function createDeduper(windowMs) {
        var span = num(windowMs, 2500);
        var last = -Infinity;
        return function (now) {
            var t = num(now, Date.now());
            if (t - last < span) { return false; }
            last = t;
            return true;
        };
    }

    // ---------------- 自动静音 ----------------

    /**
     * 要不要把这个视频静音。
     * 规则：功能开着、没播完、现在有声、而且不是用户自己取消过静音 —— 才动手。
     *
     * @param {object} state { enabled, autoMute, muted, ended, userUnmuted }
     */
    function shouldAutoMute(state) {
        var s = state || {};
        if (!s.enabled || !s.autoMute) { return false; }
        if (s.ended) { return false; }
        if (s.muted) { return false; }
        if (s.userUnmuted) { return false; }
        return true;
    }

    // ---------------- 自动连播 ----------------

    var NEXT_LABELS = [
        '下一集', '下一期', '下一话', '下一章', '下一个视频', '下一个', '下一段',
        '下一p', 'next episode', 'next video', 'next part', 'play next', 'up next', 'next'
    ];
    var PREV_LABELS = ['上一集', '上一期', '上一话', '上一个', 'previous', 'prev', '上一p'];

    /**
     * 从一个按钮/链接的文案（或 aria-label / title）里认出「下一个视频」。
     * 认出来返回命中的关键词，认不出返回 null。
     * 太长的文案一般是视频标题/简介，直接排除，避免误点。
     */
    function matchNextLabel(raw) {
        var t = String(raw || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!t || t.length > 24) { return null; }
        for (var i = 0; i < PREV_LABELS.length; i++) {
            if (t.indexOf(PREV_LABELS[i].toLowerCase()) >= 0) { return null; }
        }
        for (var j = 0; j < NEXT_LABELS.length; j++) {
            var label = NEXT_LABELS[j].toLowerCase();
            if (/[a-z]/.test(label)) {
                // 英文关键词要求整词，免得 next 匹配到 context、nextjs 之类
                if (new RegExp('(^|[^a-z])' + label + '($|[^a-z])').test(t)) { return label; }
            } else if (t.indexOf(label) >= 0) {
                return label;
            }
        }
        return null;
    }

    /**
     * 这次「播完」该不该顺手点下一集。
     * @param {object} state { enabled, autoNext, clickedForThisVideo, lastClickAt, now, windowMs }
     */
    function shouldAutoNext(state) {
        var s = state || {};
        if (!s.enabled || !s.autoNext) { return false; }
        if (s.clickedForThisVideo) { return false; }
        var span = num(s.windowMs, 8000);
        var last = num(s.lastClickAt, -Infinity);
        if (num(s.now, Date.now()) - last < span) { return false; }
        return true;
    }

    // ---------------- 站点适配（雨课堂特别版） ----------------

    /** 是否雨课堂站点（scut.yuketang.cn / www.yuketang.cn / yuketang.cn 都算）。 */
    function isYuketangHost(host) {
        var h = String(host || '').toLowerCase().replace(/:\d+$/, '');
        if (!h) { return false; }
        return h === 'yuketang.cn' || /(^|\.)yuketang\.cn$/.test(h);
    }

    /**
     * 视频「停住」了要不要替用户继续播。
     * 只在「播到一半被暂停」时介入：刚开头（换集重载）和片尾都不管，避免和播放器抢。
     *
     * @param {object} state { enabled, paused, ended, currentTime, duration,
     *                         attempts, maxAttempts, lastAttemptAt, now, cooldownMs }
     */
    function shouldResume(state) {
        var s = state || {};
        if (!s.enabled) { return false; }
        if (!s.paused || s.ended) { return false; }
        var dur = num(s.duration, NaN);
        if (!isFinite(dur) || dur <= 0) { return false; }
        var cur = num(s.currentTime, 0);
        if (cur <= 0.05) { return false; }
        if (dur - cur <= 1) { return false; }
        if (num(s.attempts, 0) >= num(s.maxAttempts, 5)) { return false; }
        var now = num(s.now, Date.now());
        var last = num(s.lastAttemptAt, -Infinity);
        if (now - last < num(s.cooldownMs, 2500)) { return false; }
        return true;
    }

    /**
     * 在一串目录标题里找出「当前正在学的那一项」，找不到返回 -1。
     * 精确相等优先，其次才是包含关系，避免「1.1」错配到「1.10」。
     */
    function findCurrentIndex(labels, needle) {
        var list = labels || [];
        var n = String(needle || '').replace(/\s+/g, ' ').trim();
        if (!n) { return -1; }
        var i, t;
        for (i = 0; i < list.length; i++) {
            t = String(list[i] || '').replace(/\s+/g, ' ').trim();
            if (t && t === n) { return i; }
        }
        for (i = 0; i < list.length; i++) {
            t = String(list[i] || '').replace(/\s+/g, ' ').trim();
            if (!t || t.length < 2) { continue; }
            if (t.indexOf(n) >= 0 || n.indexOf(t) >= 0) { return i; }
        }
        return -1;
    }

    /**
     * 目录里的下一项；到末尾返回 null（课程学完就不要再点了）。
     * @param {number} total 目录项总数
     * @param {number} currentIndex 当前项下标（-1 表示没认出来）
     */
    function pickNextIndex(total, currentIndex) {
        var n = Math.round(num(total, 0));
        var i = Math.round(num(currentIndex, -1));
        if (n <= 0) { return null; }
        if (i < -1 || i >= n - 1) { return null; }
        return i + 1;
    }

    return {
        DEFAULT_CONFIG: DEFAULT_CONFIG,
        isYuketangHost: isYuketangHost,
        shouldResume: shouldResume,
        findCurrentIndex: findCurrentIndex,
        pickNextIndex: pickNextIndex,
        normalizeConfig: normalizeConfig,
        createWatcher: createWatcher,
        createDeduper: createDeduper,
        shouldAutoMute: shouldAutoMute,
        shouldAutoNext: shouldAutoNext,
        matchNextLabel: matchNextLabel,
        buildRingPattern: buildRingPattern,
        describeFinish: describeFinish,
        formatClock: formatClock
    };
});


/*!
 * video-finish-watcher · 浏览器侧装配（DOM / 音频 / 通知 / 设置面板）
 * 依赖 core.js 暴露的 window.VFW（构建后同一份文件中）。
 */
(function () {
    'use strict';

    var VFW = window.VFW;
    if (!VFW) { return; }
    if (window.__VFW_UI_LOADED__) { return; }
    window.__VFW_UI_LOADED__ = true;

    var CONFIG_KEY = 'vfw:config';
    var ytMode = VFW.isYuketangHost(location.hostname);
    var isTop = (function () {
        try { return window.top === window.self; } catch (e) { return false; }
    })();

    // ---------------- 配置 ----------------

    function loadConfig() {
        var raw = null;
        try { raw = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null'); } catch (e) { raw = null; }
        return VFW.normalizeConfig(raw);
    }

    function saveConfig(cfg) {
        try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (e) { /* 隐私模式等忽略 */ }
    }

    var cfg = loadConfig();

    // ---------------- 铃声 ----------------

    var audioCtx = null;
    var primed = false;

    function ensureAudio() {
        if (!audioCtx) {
            var Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) { return null; }
            try { audioCtx = new Ctx(); } catch (e) { return null; }
        }
        if (audioCtx.state === 'suspended') { audioCtx.resume().catch(function () { }); }
        return audioCtx;
    }

    // 浏览器要求音频由用户手势激活：先挂一个一次性监听把上下文「预热」出来
    function primeAudio() {
        if (primed) { return; }
        primed = true;
        var ctx = ensureAudio();
        if (!ctx) { return; }
        if (ctx.state === 'suspended') { ctx.resume().catch(function () { }); }
    }

    ['pointerdown', 'keydown', 'touchstart'].forEach(function (evt) {
        window.addEventListener(evt, primeAudio, { capture: true, passive: true, once: true });
    });

    function ring() {
        var ctx = ensureAudio();
        if (!ctx) { return false; }
        var pattern = VFW.buildRingPattern(cfg);
        var t0 = ctx.currentTime + 0.02;
        pattern.forEach(function (note) {
            var osc = ctx.createOscillator();
            var gain = ctx.createGain();
            var start = t0 + note.atMs / 1000;
            var end = start + note.durMs / 1000;
            osc.type = 'sine';
            osc.frequency.setValueAtTime(note.freq, start);
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, note.peak), start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, end);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(start);
            osc.stop(end + 0.02);
        });
        return true;
    }

    function testRing() {
        primeAudio();
        return ring();
    }

    // ---------------- 通知 ----------------

    function canNotify() {
        return (typeof Notification !== 'undefined') && Notification.permission === 'granted';
    }

    function requestNotifyPermission() {
        if (typeof Notification === 'undefined') { return Promise.resolve('unsupported'); }
        if (Notification.permission !== 'default') { return Promise.resolve(Notification.permission); }
        try {
            return Promise.resolve(Notification.requestPermission());
        } catch (e) {
            return Promise.resolve('denied');
        }
    }

    function notify(body) {
        if (!cfg.notify || !canNotify()) { return false; }
        try {
            var n = new Notification('视频播放完成', {
                body: body,
                tag: 'vfw-finish',
                renotify: true,
                silent: false
            });
            n.onclick = function () {
                try { window.focus(); } catch (e) { }
                n.close();
            };
            setTimeout(function () { try { n.close(); } catch (e) { } }, 15000);
            return true;
        } catch (e) {
            return false;
        }
    }

    // ---------------- 标题闪烁 ----------------

    var flashTimer = null;
    var flashBase = null;

    function startFlash() {
        if (!cfg.flashTitle || flashTimer || document.hidden === false) { return; }
        flashBase = document.title;
        var on = false;
        flashTimer = setInterval(function () {
            on = !on;
            document.title = on ? '🔔 视频播放完成' : flashBase;
        }, 900);
    }

    function stopFlash() {
        if (!flashTimer) { return; }
        clearInterval(flashTimer);
        flashTimer = null;
        if (flashBase !== null) { document.title = flashBase; flashBase = null; }
    }

    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) { stopFlash(); }
    });

    // ---------------- 视频跟踪 ----------------

    var videos = new WeakMap();       // video -> { watcher }
    var mounted = [];                 // 便于配置变更时批量刷新
    var trackedCount = 0;
    var dedupe = VFW.createDeduper(2500);

    function titleOf(video) {
        var t = '';
        try { t = video.getAttribute('title') || video.getAttribute('aria-label') || ''; } catch (e) { }
        if (!t && isTop) { t = document.title; }
        return t;
    }

    function handleFinish(video, event) {
        if (!dedupe(Date.now())) { return; }
        var title = titleOf(video);
        var body = VFW.describeFinish(title, event);

        ring();
        notify(body);
        startFlash();

        if (cfg.pauseOthers) {
            document.querySelectorAll('video').forEach(function (v) {
                if (v !== video && !v.paused && !v.ended) {
                    try { v.pause(); } catch (e) { }
                }
            });
        }

        // 稍等一下再点「下一集」：有些站点要等片尾 UI 更新完才出现按钮
        if (cfg.autoNext) {
            setTimeout(function () { tryAutoNext(video); }, 700);
        }

        // 面板开着的话刷新一下状态
        if (panelRefresh) { panelRefresh(); }
    }

    // ---------------- 自动静音 ----------------

    var userUnmuted = new WeakSet();   // 用户自己取消过静音的视频，之后不再强行静音
    var forceMute = false;             // 雨课堂特别版：无论如何都静音（忽略「用户取消过」）

    function maybeMute(video) {
        var rec = videos.get(video);
        if (!rec) { return; }
        var want = VFW.shouldAutoMute({
            enabled: cfg.enabled,
            autoMute: cfg.autoMute,
            muted: !!video.muted,
            ended: !!video.ended,
            userUnmuted: forceMute ? false : userUnmuted.has(video)
        });
        if (!want) { return; }
        try {
            video.muted = true;
            rec.mutedByUs = true;
        } catch (e) { /* 某些源不允许改 muted */ }
    }

    // ---------------- 自动连播（下一集） ----------------

    // 常见站点的「下一个」按钮选择器，命中率比纯文案匹配高
    var NEXT_SELECTORS = [
        '.bpx-player-ctrl-next',                 // bilibili 新版播放器
        '.bilibili-player-video-btn-next',       // bilibili 旧版
        '.ytp-next-button',                      // YouTube
        '.xgplayer-big-play-next',
        'a[class*="next"][class*="player"]'
    ];

    var lastNextClickAt = -Infinity;
    var nextClickedFor = new WeakSet();

    function isVisible(el) {
        if (!el || !el.isConnected) { return false; }
        var rect = null;
        try { rect = el.getBoundingClientRect(); } catch (e) { return false; }
        if (!rect || rect.width < 4 || rect.height < 4) { return false; }
        try {
            var cs = window.getComputedStyle(el);
            if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none') { return false; }
            if (String(cs.opacity) === '0') { return false; }
        } catch (e) { /* ignore */ }
        return true;
    }

    function labelOf(el) {
        var parts = [];
        try {
            parts.push(el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-title'));
            if (!el.getAttribute('aria-label') && !el.getAttribute('title')) { parts.push(el.textContent); }
        } catch (e) { /* ignore */ }
        return parts.filter(Boolean).join(' ');
    }

    function findNextControl(video) {
        var i, el;
        for (i = 0; i < NEXT_SELECTORS.length; i++) {
            try { el = document.querySelector(NEXT_SELECTORS[i]); } catch (e) { el = null; }
            if (el && isVisible(el) && !el.disabled) { return el; }
        }

        // 先在播放器附近找，再退到整页，避免点到页面别处的「下一个」
        var roots = [];
        try {
            var near = video && video.closest ? video.closest('div,section,main,article') : null;
            if (near) { roots.push(near); }
        } catch (e) { /* ignore */ }
        roots.push(document);

        for (var r = 0; r < roots.length; r++) {
            var cands;
            try {
                cands = roots[r].querySelectorAll('button,a,[role="button"],[class*="next"],[class*="Next"]');
            } catch (e) { continue; }
            for (var c = 0; c < cands.length; c++) {
                var cand = cands[c];
                if (!isVisible(cand) || cand.disabled) { continue; }
                if (VFW.matchNextLabel(labelOf(cand))) { return cand; }
            }
        }
        return null;
    }

    function clickControl(el) {
        try { el.click(); return true; } catch (e) { /* 继续用事件兜底 */ }
        try {
            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
                el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            });
            return true;
        } catch (e) {
            return false;
        }
    }

    function tryAutoNext(video) {
        // 站点适配层（雨课堂特别版）自己有更准的「下一集」，别两边各点一次跳两集
        if (window.__VFW_YT_OWN_NEXT__) { return false; }
        var allowed = VFW.shouldAutoNext({
            enabled: cfg.enabled,
            autoNext: cfg.autoNext,
            clickedForThisVideo: nextClickedFor.has(video),
            lastClickAt: lastNextClickAt,
            now: Date.now()
        });
        if (!allowed) { return false; }
        var el = findNextControl(video);
        if (!el || !clickControl(el)) { return false; }
        nextClickedFor.add(video);
        lastNextClickAt = Date.now();
        return true;
    }

    function tickVideo(video) {
        var rec = videos.get(video);
        if (!rec) { return; }
        var event = rec.watcher.tick({
            currentTime: video.currentTime,
            duration: video.duration,
            ended: video.ended,
            paused: video.paused,
            seeking: video.seeking,
            loop: !!video.loop,
            muted: !!video.muted
        });
        if (event) { handleFinish(video, event); }
    }

    function attach(video) {
        if (videos.has(video)) { return; }
        var rec = { watcher: VFW.createWatcher(cfg), listeners: [] };
        videos.set(video, rec);
        mounted.push({ video: video, rec: rec });
        trackedCount += 1;

        var on = function (evt) { tickVideo(video); };
        ['timeupdate', 'ended', 'pause', 'seeking'].forEach(function (name) {
            video.addEventListener(name, on, { passive: true });
            rec.listeners.push([name, on]);
        });

        // 换源 / 重新加载 → 状态机复位，允许下一次自动连播
        var onLoad = function () {
            rec.watcher.rearm();
            nextClickedFor.delete(video);
        };
        video.addEventListener('loadstart', onLoad, { passive: true });
        video.addEventListener('emptied', onLoad, { passive: true });
        rec.listeners.push(['loadstart', onLoad], ['emptied', onLoad]);

        // 一开始播放就静音（抢在出声之前）
        var onMute = function () { maybeMute(video); };
        ['play', 'playing', 'loadedmetadata'].forEach(function (name) {
            video.addEventListener(name, onMute, { passive: true });
            rec.listeners.push([name, onMute]);
        });

        // 我们静音之后又被解除 → 视为用户主动要声音，这个视频不再强行静音
        var onVolume = function () {
            if (!video.muted && rec.mutedByUs) {
                rec.mutedByUs = false;
                userUnmuted.add(video);
            }
        };
        video.addEventListener('volumechange', onVolume, { passive: true });
        rec.listeners.push(['volumechange', onVolume]);
    }

    function scan() {
        var list = document.querySelectorAll('video');
        for (var i = 0; i < list.length; i++) { attach(list[i]); }
        return list.length;
    }

    function rescanSoon() {
        if (rescanPending) { return; }
        rescanPending = true;
        setTimeout(function () { rescanPending = false; scan(); }, 400);
    }
    var rescanPending = false;

    try {
        var mo = new MutationObserver(function (muts) {
            for (var i = 0; i < muts.length; i++) {
                var added = muts[i].addedNodes;
                for (var j = 0; j < added.length; j++) {
                    var node = added[j];
                    if (!node || node.nodeType !== 1) { continue; }
                    if (node.tagName === 'VIDEO' || (node.querySelector && node.querySelector('video'))) {
                        rescanSoon();
                        return;
                    }
                }
            }
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* 某些沙箱文档不支持 */ }

    // SPA 换页时 video 元素会整体重建，定时兜底重扫
    setInterval(scan, 3000);

    // ---------------- 设置面板（只在顶层窗口） ----------------

    var panel = null;
    var panelRefresh = null;

    function buildPanel() {
        var box = document.createElement('div');
        box.id = 'vfw-panel';
        box.style.cssText = [
            'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
            'width:250px', 'padding:14px 16px', 'border-radius:12px',
            'background:rgba(24,26,32,.96)', 'color:#e8e8ee',
            'font:13px/1.5 "Microsoft YaHei UI","PingFang SC",sans-serif',
            'box-shadow:0 8px 28px rgba(0,0,0,.45)', 'border:1px solid rgba(255,255,255,.12)',
            'backdrop-filter:blur(8px)', 'user-select:none'
        ].join(';');
        box.innerHTML = [
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">',
            '  <b style="font-size:14px">视频播完提醒</b>',
            '  <span data-close style="cursor:pointer;opacity:.6;font-size:16px;line-height:1">×</span>',
            '</div>',
            '<div data-status style="opacity:.75;margin-bottom:10px;font-size:12px"></div>',
            '<label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" data-k="enabled"> 启用</label>',
            '<label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" data-k="notify"> 系统通知</label>',
            '<label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" data-k="flashTitle"> 标题闪烁</label>',
            '<label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" data-k="pauseOthers"> 完成后暂停其它视频</label>',
            '<label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" data-k="autoMute"> 自动静音视频</label>',
            '<label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" data-k="autoNext"> 播完自动下一集</label>',
            ytMode ? [
                '<div style="margin:10px 0 2px;opacity:.6;font-size:12px">雨课堂特化</div>',
                '<label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" data-k="ytForceMute"> 无论如何静音</label>',
                '<label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" data-k="ytAutoResume"> 停住就继续播</label>',
                '<label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" data-k="ytSkipNonVideo"> 非视频项自动跳过</label>',
                '<label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" data-k="ytAutoAnswer"> 选择题尝试作答</label>'
            ].join('') : '',
            '<label style="display:block;margin:10px 0 2px">音量 <span data-v></span></label>',
            '<input type="range" min="0" max="100" step="5" data-k="volume" style="width:100%">',
            '<div style="display:flex;gap:8px;margin-top:12px">',
            '  <button data-test style="flex:1;padding:7px 0;border-radius:8px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.1);color:inherit;cursor:pointer">试听铃声</button>',
            '  <button data-perm style="flex:1;padding:7px 0;border-radius:8px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.1);color:inherit;cursor:pointer">通知授权</button>',
            '</div>',
            '<div style="opacity:.45;margin-top:10px;font-size:11px">Alt+Shift+V 开关面板</div>'
        ].join('');

        box.querySelector('[data-close]').addEventListener('click', function () { togglePanel(false); });

        box.querySelectorAll('input[type=checkbox]').forEach(function (el) {
            el.checked = !!cfg[el.getAttribute('data-k')];
            el.addEventListener('change', function () {
                cfg[el.getAttribute('data-k')] = el.checked;
                saveConfig(cfg);
                applyConfig();
            });
        });

        var range = box.querySelector('input[type=range][data-k=volume]');
        range.value = String(Math.round(cfg.volume * 100));
        var volLabel = box.querySelector('[data-v]');
        volLabel.textContent = Math.round(cfg.volume * 100) + '%';
        range.addEventListener('input', function () {
            cfg.volume = Number(range.value) / 100;
            volLabel.textContent = range.value + '%';
            saveConfig(cfg);
        });

        box.querySelector('[data-test]').addEventListener('click', function () { testRing(); });
        box.querySelector('[data-perm]').addEventListener('click', function () {
            requestNotifyPermission().then(refreshStatus);
        });

        function refreshStatus() {
            var permText = (typeof Notification === 'undefined') ? '不支持通知'
                : (Notification.permission === 'granted' ? '通知已授权'
                    : Notification.permission === 'denied' ? '通知被拒绝' : '通知未授权');
            var playing = 0;
            document.querySelectorAll('video').forEach(function (v) {
                if (!v.paused && !v.ended && v.duration > 0) { playing += 1; }
            });
            box.querySelector('[data-status]').textContent =
                '已监听 ' + trackedCount + ' 个视频 · 正在播放 ' + playing + ' · ' + permText;
        }

        panelRefresh = refreshStatus;
        refreshStatus();
        return box;
    }

    function togglePanel(force) {
        var show = (force === undefined) ? !(panel && panel.isConnected) : !!force;
        if (!isTop) { return; }
        if (show) {
            if (!panel) { panel = buildPanel(); }
            if (!panel.isConnected) { document.documentElement.appendChild(panel); }
            if (panelRefresh) { panelRefresh(); }
        } else if (panel && panel.isConnected) {
            panel.remove();
        }
    }

    var lastAutoMute = cfg.autoMute;

    function applyConfig() {
        // 重新打开「自动静音」时，把「用户取消过静音」的记忆清空，让功能重新生效
        if (cfg.autoMute && !lastAutoMute) { userUnmuted = new WeakSet(); }
        lastAutoMute = cfg.autoMute;

        // 配置变了：把新配置推给所有已挂载的判定器
        for (var i = 0; i < mounted.length; i++) {
            try { mounted[i].rec.watcher.setConfig(cfg); } catch (e) { }
        }
        scan();
        if (cfg.autoMute) {
            document.querySelectorAll('video').forEach(function (v) { maybeMute(v); });
        }
    }

    window.addEventListener('keydown', function (e) {
        if (e.altKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
            e.preventDefault();
            togglePanel();
        }
    }, true);

    // ---------------- 启动 ----------------

    scan();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scan, { once: true });
    }

    // 供控制台调试
    window.__VFW_DEBUG__ = {
        status: function () {
            return { tracked: trackedCount, config: cfg, notify: typeof Notification !== 'undefined' ? Notification.permission : 'unsupported' };
        },
        testRing: testRing,
        rescan: scan
    };

    // 站点适配层（special 版才带 site-*.js）在这里接进主流程
    window.__VFW_HOOKS__ = {
        config: function () { return cfg; },
        update: function (patch) {
            for (var k in patch) { if (Object.prototype.hasOwnProperty.call(patch, k)) { cfg[k] = patch[k]; } }
            saveConfig(cfg);
            applyConfig();
        },
        setForceMute: function (on) { forceMute = !!on; document.querySelectorAll('video').forEach(function (v) { maybeMute(v); }); },
        ring: ring,
        notify: notify,
        click: clickControl,
        visible: isVisible,
        labelOf: labelOf,
        findNextControl: findNextControl,
        videos: function () { return document.querySelectorAll('video'); },
        restartFlash: function () { stopFlash(); startFlash(); },
        refreshPanel: function () { if (panelRefresh) { panelRefresh(); } }
    };
})();
