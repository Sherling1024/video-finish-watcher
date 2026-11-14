/*!
 * video-finish-watcher · 雨课堂特别版（scut.yuketang.cn）
 *   1. 无论如何默认静音
 *   2. 目录里的「下一集」、停住就续播
 *   3. 非视频项（讨论/课件）尝试作答，答不了就跳过
 * 只在 yuketang.cn 上生效；普通版不含这个文件。
 */
(function () {
    'use strict';

    var VFW = window.VFW;
    var H = window.__VFW_HOOKS__;
    if (!VFW || !H) { return; }
    // 正常情况按域名判断；测试页用 __VFW_FORCE_YT__ 强制打开
    if (!window.__VFW_FORCE_YT__ && !VFW.isYuketangHost(location.hostname)) { return; }
    if (window.__VFW_YT_LOADED__) { return; }
    window.__VFW_YT_LOADED__ = true;

    // 交给我们自己找「下一集」，别让通用逻辑再点一次（会连跳两集）
    window.__VFW_YT_OWN_NEXT__ = true;

    var cfg = H.config();

    // ---------------- 1. 强制静音 ----------------

    H.setForceMute(!!cfg.ytForceMute);

    // 每次 play 前再压一次：雨课堂换集时会重新打开声音
    document.addEventListener('play', function (e) {
        var v = e.target;
        if (!v || v.tagName !== 'VIDEO') { return; }
        if (!H.config().ytForceMute) { return; }
        try { if (!v.muted) { v.muted = true; } } catch (err) { /* ignore */ }
    }, true);

    // ---------------- 用户意图：最近有没有动过鼠标/键盘 ----------------

    var lastUserAt = 0;
    ['pointerdown', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(function (name) {
        window.addEventListener(name, function () { lastUserAt = Date.now(); }, { capture: true, passive: true });
    });

    function userJustActed(ms) {
        return (Date.now() - lastUserAt) < (ms || 1200);
    }

    // ---------------- 目录：当前项 / 下一项 ----------------

    var ACTIVE_SELECTORS = [
        '[class*="active"]', '[class*="Active"]', '[class*="current"]', '[class*="Current"]',
        '[class*="selected"]', '[class*="Selected"]', '[aria-current="true"]', '[class*="playing"]'
    ];

    function textOf(el) {
        try { return (el.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e) { return ''; }
    }

    /** 左侧目录里被高亮的那一项（取面积最小的候选，避免拿到整个章节容器）。 */
    function activeItem() {
        var best = null, bestArea = Infinity;
        for (var s = 0; s < ACTIVE_SELECTORS.length; s++) {
            var list;
            try { list = document.querySelectorAll(ACTIVE_SELECTORS[s]); } catch (e) { continue; }
            for (var i = 0; i < list.length; i++) {
                var el = list[i];
                if (!H.visible(el)) { continue; }
                var r;
                try { r = el.getBoundingClientRect(); } catch (e) { continue; }
                if (r.left > window.innerWidth * 0.6) { continue; }   // 目录在左半边
                if (r.width > window.innerWidth * 0.45) { continue; } // 整块容器跳过
                if (r.height > 260) { continue; }
                var t = textOf(el);
                if (!t || t.length > 90) { continue; }
                var area = r.width * r.height;
                if (area < bestArea) { best = el; bestArea = area; }
            }
        }
        return best;
    }

    function nextSiblingItem(cur) {
        if (!cur || !cur.parentNode) { return null; }
        var sibs;
        try { sibs = Array.prototype.slice.call(cur.parentNode.children); } catch (e) { return null; }
        var i = sibs.indexOf(cur);
        for (var j = i + 1; j < sibs.length; j++) {
            var el = sibs[j];
            if (!el || el.nodeType !== 1) { continue; }
            if (!H.visible(el)) { continue; }
            if (!textOf(el)) { continue; }
            return el;
        }
        return null;
    }

    /** 目录里的下一项；认不出当前项时退回「下一节」按钮。 */
    function nextItem() {
        var cur = activeItem();
        var sib = nextSiblingItem(cur);
        if (sib) { return sib; }
        return H.findNextControl(null);
    }

    var lastAdvanceAt = 0;

    function advance(why) {
        if (Date.now() - lastAdvanceAt < 2500) { return false; }
        if (!H.config().enabled) { return false; }
        var el = nextItem();
        if (!el) { log('advance: no next item (' + why + ')'); return false; }
        lastAdvanceAt = Date.now();
        log('advance: ' + why + ' -> ' + (textOf(el).slice(0, 30) || el.className || el.tagName));
        H.click(el);
        return true;
    }

    // 播完 → 直接点目录的下一项（比通用逻辑可靠）
    document.addEventListener('ended', function (e) {
        var v = e.target;
        if (!v || v.tagName !== 'VIDEO') { return; }
        if (!H.config().autoNext) { return; }
        setTimeout(function () { advance('ended'); }, 500);
    }, true);

    // ---------------- 2. 停住就继续播 ----------------

    var resumeState = new WeakMap();   // video -> { last, attempts }

    function resumeTick() {
        if (!H.config().ytAutoResume || !H.config().enabled) { return; }
        if (document.hidden) { return; }            // 切到后台时站点自己会暂停，别对着干
        if (userJustActed(1500)) { return; }        // 用户刚点过：大概是主动暂停

        var list = H.videos();
        for (var i = 0; i < list.length; i++) {
            var v = list[i];
            if (!v.isConnected || v.ended || !v.paused) {
                if (!v.paused) { resumeState.delete(v); }
                continue;
            }
            var st = resumeState.get(v) || { last: -Infinity, attempts: 0 };
            var ok = VFW.shouldResume({
                enabled: true,
                paused: v.paused,
                ended: v.ended,
                currentTime: v.currentTime,
                duration: v.duration,
                attempts: st.attempts,
                lastAttemptAt: st.last,
                now: Date.now(),
                maxAttempts: 4,
                cooldownMs: 2500
            });
            if (!ok) { continue; }
            st.last = Date.now();
            st.attempts += 1;
            resumeState.set(v, st);
            log('resume attempt #' + st.attempts + ' @' + Math.round(v.currentTime) + 's');
            try {
                var p = v.play();
                if (p && typeof p.catch === 'function') { p.catch(function () { }); }
            } catch (e) { /* ignore */ }
        }
    }

    // ---------------- 调度 ----------------

    function log(msg) {
        try {
            if (!window.__VFW_YT_LOG__) { return; }
            (window.__VFW_YT_LOG__ = window.__VFW_YT_LOG__).push([Date.now(), msg]);
            if (window.__VFW_YT_LOG__.length > 200) { window.__VFW_YT_LOG__.shift(); }
        } catch (e) { /* ignore */ }
    }

    setInterval(function () {
        try { resumeTick(); } catch (e) { /* ignore */ }
    }, 1200);

    // 调试入口：控制台 __VFW_YT__.dump()
    window.__VFW_YT__ = {
        dump: function () {
            var cur = activeItem();
            var nxt = nextItem();
            var vids = Array.prototype.map.call(H.videos(), function (v) {
                return { paused: v.paused, t: Math.round(v.currentTime || 0), d: Math.round(v.duration || 0), muted: v.muted };
            });
            return { current: cur ? textOf(cur).slice(0, 40) : null, next: nxt ? textOf(nxt).slice(0, 40) : null, videos: vids };
        },
        next: function () { return advance('manual'); },
        // 给测试用：把「用户刚动过」的时间戳清掉，让续播判定跑起来
        _test: {
            resetUser: function () { lastUserAt = -Infinity; },
            resumeTick: resumeTick,
            activeItem: activeItem,
            nextItem: nextItem,
            resetAdvance: function () { lastAdvanceAt = 0; }
        }
    };
})();
