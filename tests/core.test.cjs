/**
 * core.js 的无浏览器测试：node tests/core.test.cjs
 */
const assert = require('node:assert/strict');
const VFW = require('../src/core.js');

let passed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log('  ok  ' + name);
    } catch (err) {
        failures.push([name, err]);
        console.log('  FAIL ' + name + ' — ' + err.message);
    }
}

/** 造一个视频快照 */
function snap(o) {
    return Object.assign({
        currentTime: 0, duration: 600, ended: false,
        paused: false, seeking: false, loop: false, muted: false
    }, o);
}

console.log('normalizeConfig');
test('缺省值来自 DEFAULT_CONFIG', () => {
    const c = VFW.normalizeConfig(null);
    assert.equal(c.enabled, true);
    assert.equal(c.volume, VFW.DEFAULT_CONFIG.volume);
    assert.equal(c.minDurationSec, 20);
});
test('越界值被夹取', () => {
    const c = VFW.normalizeConfig({ volume: 5, ringCount: 99, thresholdSec: -3, minDurationSec: 99999 });
    assert.equal(c.volume, 1);
    assert.equal(c.ringCount, 5);
    assert.equal(c.thresholdSec, 0);
    assert.equal(c.minDurationSec, 3600);
});
test('非数字回落默认值', () => {
    const c = VFW.normalizeConfig({ volume: 'abc', ringCount: null });
    assert.equal(c.volume, VFW.DEFAULT_CONFIG.volume);
    assert.equal(c.ringCount, VFW.DEFAULT_CONFIG.ringCount);
});

console.log('createWatcher');
test('播放到 ended 只触发一次', () => {
    const w = VFW.createWatcher({});
    assert.equal(w.tick(snap({ currentTime: 300 })), null);
    const ev = w.tick(snap({ currentTime: 600, ended: true }));
    assert.ok(ev, '应该触发');
    assert.equal(ev.reason, 'ended');
    assert.equal(ev.progress, 1);
    assert.equal(w.tick(snap({ currentTime: 600, ended: true })), null, '第二次不再触发');
});
test('站点吞掉 ended 时用片尾进度兜底', () => {
    const w = VFW.createWatcher({ thresholdSec: 0.6 });
    assert.equal(w.tick(snap({ currentTime: 599.0 })), null);
    const ev = w.tick(snap({ currentTime: 599.6 }));
    assert.ok(ev);
    assert.equal(ev.reason, 'near-end');
});
test('太短的视频（广告）不提醒', () => {
    const w = VFW.createWatcher({ minDurationSec: 20 });
    assert.equal(w.tick(snap({ duration: 15, currentTime: 15, ended: true })), null);
});
test('直播流 duration=Infinity 不提醒', () => {
    const w = VFW.createWatcher({});
    assert.equal(w.tick(snap({ duration: Infinity, currentTime: 100, ended: true })), null);
});
test('loop 视频不提醒', () => {
    const w = VFW.createWatcher({});
    assert.equal(w.tick(snap({ loop: true, currentTime: 600, ended: true })), null);
});
test('重播后重新武装', () => {
    const w = VFW.createWatcher({});
    assert.ok(w.tick(snap({ currentTime: 600, ended: true })));
    assert.equal(w.armed, false);
    w.tick(snap({ currentTime: 0.5 }));           // 从头重播
    assert.equal(w.armed, true);
    assert.ok(w.tick(snap({ currentTime: 600, ended: true })), '重播后应再次提醒');
});
test('拖回开头也重新武装', () => {
    const w = VFW.createWatcher({});
    w.tick(snap({ currentTime: 600, ended: true }));
    w.tick(snap({ currentTime: 120 }));            // 往回拖
    assert.equal(w.armed, true);
});
test('暂停在片尾也算播完', () => {
    const w = VFW.createWatcher({});
    w.tick(snap({ currentTime: 598 }));
    const ev = w.tick(snap({ currentTime: 600, paused: true }));
    assert.ok(ev);
    assert.equal(ev.reason, 'paused-at-end');
});
test('seeking 过程中不触发', () => {
    const w = VFW.createWatcher({});
    assert.equal(w.tick(snap({ currentTime: 600, seeking: true, ended: true })), null);
});
test('总开关关闭时静默', () => {
    const w = VFW.createWatcher({ enabled: false });
    assert.equal(w.tick(snap({ currentTime: 600, ended: true })), null);
});
test('setConfig 立即生效', () => {
    const w = VFW.createWatcher({ minDurationSec: 20 });
    w.setConfig({ minDurationSec: 0 });
    assert.ok(w.tick(snap({ duration: 15, currentTime: 15, ended: true })));
});

console.log('buildRingPattern');
test('轮数 × 3 声，时间递增', () => {
    const p = VFW.buildRingPattern({ ringCount: 2, volume: 0.5 });
    assert.equal(p.length, 6);
    for (let i = 1; i < p.length; i++) {
        assert.ok(p[i].atMs > p[i - 1].atMs, '音符应按时间递增');
    }
    assert.ok(p[0].peak > 0);
});
test('音量归零时 peak 仍为可听见的正数下限', () => {
    const p = VFW.buildRingPattern({ ringCount: 1, volume: 0 });
    assert.ok(p.every(n => n.peak >= 0));
});

console.log('formatClock / describeFinish');
test('时间格式', () => {
    assert.equal(VFW.formatClock(0), '0:00');
    assert.equal(VFW.formatClock(65), '1:05');
    assert.equal(VFW.formatClock(3725), '1:02:05');
    assert.equal(VFW.formatClock(NaN), '0:00');
});
test('通知正文带时长', () => {
    assert.equal(VFW.describeFinish('某视频', { duration: 754 }), '某视频 · 12:34');
    assert.equal(VFW.describeFinish('', { duration: NaN }), '视频');
    assert.equal(VFW.describeFinish('  ', null), '视频');
});

console.log('shouldAutoMute');
test('开着自动静音、有声、没播完 → 静音', () => {
    assert.equal(VFW.shouldAutoMute({ enabled: true, autoMute: true, muted: false, ended: false }), true);
});
test('已经是静音的就不动手', () => {
    assert.equal(VFW.shouldAutoMute({ enabled: true, autoMute: true, muted: true }), false);
});
test('用户自己取消过静音 → 尊重用户', () => {
    assert.equal(VFW.shouldAutoMute({ enabled: true, autoMute: true, userUnmuted: true }), false);
});
test('播完了 / 功能关了 / 总开关关了都不动手', () => {
    assert.equal(VFW.shouldAutoMute({ enabled: true, autoMute: true, ended: true }), false);
    assert.equal(VFW.shouldAutoMute({ enabled: true, autoMute: false }), false);
    assert.equal(VFW.shouldAutoMute({ enabled: false, autoMute: true }), false);
    assert.equal(VFW.shouldAutoMute(null), false);
});

console.log('matchNextLabel');
test('认得常见的中文「下一个」文案', () => {
    assert.equal(VFW.matchNextLabel('下一集'), '下一集');
    assert.equal(VFW.matchNextLabel('  下一期 '), '下一期');
    assert.equal(VFW.matchNextLabel('播放下一话'), '下一话');
    assert.equal(VFW.matchNextLabel('下一个视频'), '下一个视频');
});
test('认得英文 next 且要求整词', () => {
    assert.equal(VFW.matchNextLabel('Next episode'), 'next episode');
    assert.equal(VFW.matchNextLabel('next'), 'next');
    assert.equal(VFW.matchNextLabel('context'), null);
    assert.equal(VFW.matchNextLabel('nextjs 教程'), null);
});
test('不认「上一个」和长文本', () => {
    assert.equal(VFW.matchNextLabel('上一集'), null);
    assert.equal(VFW.matchNextLabel('Previous'), null);
    assert.equal(VFW.matchNextLabel('这是一段很长的视频简介，说明下一个小时该干点什么，长度明显超过阈值'), null);
    assert.equal(VFW.matchNextLabel(''), null);
    assert.equal(VFW.matchNextLabel(null), null);
});

console.log('shouldAutoNext');
test('开着自动连播、这个视频还没点过 → 点', () => {
    assert.equal(VFW.shouldAutoNext({ enabled: true, autoNext: true, clickedForThisVideo: false, lastClickAt: -Infinity, now: 1000 }), true);
});
test('同一个视频只点一次', () => {
    assert.equal(VFW.shouldAutoNext({ enabled: true, autoNext: true, clickedForThisVideo: true, now: 1000 }), false);
});
test('8 秒内不连点', () => {
    assert.equal(VFW.shouldAutoNext({ enabled: true, autoNext: true, lastClickAt: 1000, now: 5000 }), false);
    assert.equal(VFW.shouldAutoNext({ enabled: true, autoNext: true, lastClickAt: 1000, now: 12000 }), true);
});
test('功能关闭时不动手', () => {
    assert.equal(VFW.shouldAutoNext({ enabled: true, autoNext: false }), false);
    assert.equal(VFW.shouldAutoNext({ enabled: false, autoNext: true }), false);
});

console.log('雨课堂特别版：站点识别');
test('yuketang.cn 各子域都算', () => {
    assert.equal(VFW.isYuketangHost('scut.yuketang.cn'), true);
    assert.equal(VFW.isYuketangHost('www.yuketang.cn:443'), true);
    assert.equal(VFW.isYuketangHost('yuketang.cn'), true);
    assert.equal(VFW.isYuketangHost('YUKETANG.CN'), true);
});
test('长得像但不同的域不算', () => {
    assert.equal(VFW.isYuketangHost('yuketang.cn.evil.com'), false);
    assert.equal(VFW.isYuketangHost('notyuketang.cn'), false);
    assert.equal(VFW.isYuketangHost('bilibili.com'), false);
    assert.equal(VFW.isYuketangHost(''), false);
    assert.equal(VFW.isYuketangHost(null), false);
});

console.log('shouldResume');
test('播到一半被暂停 → 续播', () => {
    assert.equal(VFW.shouldResume({ enabled: true, paused: true, ended: false, currentTime: 120, duration: 600, now: 1000 }), true);
});
test('正在播 / 已播完 / 还没开始都不管', () => {
    assert.equal(VFW.shouldResume({ enabled: true, paused: false, currentTime: 120, duration: 600 }), false);
    assert.equal(VFW.shouldResume({ enabled: true, paused: true, ended: true, currentTime: 600, duration: 600 }), false);
    assert.equal(VFW.shouldResume({ enabled: true, paused: true, currentTime: 0, duration: 600 }), false);
    assert.equal(VFW.shouldResume({ enabled: true, paused: true, currentTime: 599.5, duration: 600 }), false);
});
test('冷却时间与重试次数上限', () => {
    const base = { enabled: true, paused: true, currentTime: 120, duration: 600 };
    const st = (o) => VFW.shouldResume(Object.assign({}, base, o));
    assert.equal(st({ lastAttemptAt: 900, now: 1000 }), false);
    assert.equal(st({ lastAttemptAt: 1000, now: 4000 }), true);
    assert.equal(st({ attempts: 5, now: 4000 }), false);
    assert.equal(st({ enabled: false, now: 4000 }), false);
    assert.equal(st({ duration: NaN, now: 4000 }), false);
});

console.log('findCurrentIndex / pickNextIndex');
test('标题精确匹配优先于包含匹配', () => {
    const labels = ['1.1 绪论', '1.10 小结', '1.2 方法'];
    assert.equal(VFW.findCurrentIndex(labels, '1.10 小结'), 1);
    assert.equal(VFW.findCurrentIndex(['1.1 绪论', '1.10 小结'], '1.1'), 0, '包含匹配不会错跳到 1.10');
    assert.equal(VFW.findCurrentIndex(labels, '2.5 不存在'), -1);
    assert.equal(VFW.findCurrentIndex([], 'x'), -1);
});
test('下一项：末尾返回 null', () => {
    assert.equal(VFW.pickNextIndex(3, 0), 1);
    assert.equal(VFW.pickNextIndex(3, 1), 2);
    assert.equal(VFW.pickNextIndex(3, 2), null);
    assert.equal(VFW.pickNextIndex(3, -1), 0);
    assert.equal(VFW.pickNextIndex(0, 0), null);
});

console.log('createDeduper');test('窗口内只放行一次', () => {
    const d = VFW.createDeduper(2000);
    assert.equal(d(1000), true);
    assert.equal(d(1500), false);
    assert.equal(d(3500), true);
});

console.log('');
if (failures.length) {
    console.log(`${failures.length} failed, ${passed} passed`);
    process.exit(1);
} else {
    console.log(`all ${passed} tests passed`);
}
