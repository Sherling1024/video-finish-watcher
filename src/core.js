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
        autoNext: false       // 播完后自动点击「下一集 / 下一个视频」
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

    return {
        DEFAULT_CONFIG: DEFAULT_CONFIG,
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
