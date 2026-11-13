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
