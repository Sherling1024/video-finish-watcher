// ==UserScript==
// @name         视频播放完成提醒
// @name:en      Video Finish Watcher
// @namespace    https://github.com/Sherling1024/video-finish-watcher
// @version      1.0.0
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
        pauseOthers: true     // 完成后暂停同页其它正在播的视频
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

    return {
        DEFAULT_CONFIG: DEFAULT_CONFIG,
        normalizeConfig: normalizeConfig,
        createWatcher: createWatcher,
        createDeduper: createDeduper,
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

        // 面板开着的话刷新一下状态
        if (panelRefresh) { panelRefresh(); }
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

        // 换源 / 重新加载 → 状态机复位
        var onLoad = function () { rec.watcher.rearm(); };
        video.addEventListener('loadstart', onLoad, { passive: true });
        video.addEventListener('emptied', onLoad, { passive: true });
        rec.listeners.push(['loadstart', onLoad], ['emptied', onLoad]);
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

    function applyConfig() {
        // 配置变了：把新配置推给所有已挂载的判定器
        for (var i = 0; i < mounted.length; i++) {
            try { mounted[i].rec.watcher.setConfig(cfg); } catch (e) { }
        }
        scan();
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
})();
