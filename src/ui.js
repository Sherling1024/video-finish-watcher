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

    // ---------------- 自动静音 ----------------

    var userUnmuted = new WeakSet();   // 用户自己取消过静音的视频，之后不再强行静音

    function maybeMute(video) {
        var rec = videos.get(video);
        if (!rec) { return; }
        var want = VFW.shouldAutoMute({
            enabled: cfg.enabled,
            autoMute: cfg.autoMute,
            muted: !!video.muted,
            ended: !!video.ended,
            userUnmuted: userUnmuted.has(video)
        });
        if (!want) { return; }
        try {
            video.muted = true;
            rec.mutedByUs = true;
        } catch (e) { /* 某些源不允许改 muted */ }
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
})();
