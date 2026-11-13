# 视频播放完成提醒 · Video Finish Watcher

一个用户脚本（Tampermonkey / Violentmonkey）：**网页视频一播完，就响铃 + 弹系统通知 + 标题闪烁**，让你可以放心切到别的窗口干别的事。

不是「监测进度条弹个 toast」这种花架子——它解决的是具体场景：挂着网课 / 讲座 / 长视频，人在另一个窗口写代码，播完了得知道。

## 它怎么判断「播完了」

只看 `ended` 事件是不牢靠的：很多站点（尤其是自己接管了播放器的）在片尾会先 `pause()`，`ended` 根本不派发；直播、循环播放、广告又都不该提醒。所以判定分三层：

| 情况 | 处理 |
| --- | --- |
| `ended` 事件到达 | 直接判定完成 |
| 播放中 `duration - currentTime ≤ 0.6s` | 兜底判定为完成（站点吞掉 `ended` 时靠这条） |
| 暂停时已停在片尾（`≤0.05s`） | 判定为完成 |
| `duration` 未知 / `Infinity`（直播） | 不提醒 |
| 时长 < 20 秒（广告、预览、动图视频） | 不提醒 |
| `loop` 循环播放 | 不提醒 |
| 拖回开头重播 / 用户往回 seek | 重新武装，下次播完照样提醒 |

同一个视频实例只提醒一次；同一页 2.5 秒内只提醒一次（防止多播放器同时触发连响）。

## 安装

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox）或 Violentmonkey。
2. 打开 [`dist/video-finish-watcher.user.js`](dist/video-finish-watcher.user.js) 的 raw 链接，脚本管理器会弹出安装页，点「安装」。
3. 随便打开一个带视频的页面，按 `Alt+Shift+V` 打开面板，点一次「通知授权」——浏览器要求通知权限必须由用户点击触发。

## 用法

- **不用做任何事**：页面里出现 `<video>` 就自动开始监听，SPA 换页、动态插入的视频也会被重新扫描（MutationObserver + 3 秒兜底）。
- `Alt+Shift+V` 打开/关闭设置面板：

| 设置 | 说明 |
| --- | --- |
| 启用 | 总开关 |
| 系统通知 | 弹桌面通知（还需要浏览器授权） |
| 标题闪烁 | 页面在后台时标签页标题闪「🔔 视频播放完成」，切回来自动恢复 |
| 完成后暂停其它视频 | 适合一页多个播放器，避免背景视频继续响 |
| 音量 | 铃声 0–100% |
| 试听铃声 | 立刻放一遍当前铃声 |

配置存在 `localStorage['vfw:config']`（按站点隔离），刷新后保留。

## 铃声

没有音频文件，用 Web Audio 现场合成：每轮三声 **A5 → D6 → A5**，默认两轮。浏览器的自动播放策略要求音频由手势激活，脚本会在你第一次点击/按键时预热 `AudioContext`，之后的自动响铃才不会被静音。

## 已知限制

- **跨域 iframe 里的视频**：脚本在每个 frame 里都会运行，但通知/铃声由实际包含 `<video>` 的那个 frame 负责；主页面依赖 `Notification` 权限，跨域 iframe 里的 `Notification` 可能被浏览器禁用（此时仍有铃声与标题闪烁）。
- **DRM / Canvas 渲染的播放器**（Netflix 这类）：没有可访问的 `<video>` 元素或 `duration` 被屏蔽，脚本无法判定。
- **iOS Safari**：不支持 `Notification` 构造器，只剩铃声与标题闪烁。
- 通知权限被拒绝时不会反复骚扰，面板里会显示「通知被拒绝」。
- 部分站点的 `<video>` 在 `file://` 或沙箱 iframe 里，`localStorage` 不可用，配置退回默认值（不影响提醒）。

## 开发

```bash
node build.mjs                 # src/core.js + src/ui.js → dist/*.user.js
node tests/core.test.cjs       # 19 条纯逻辑单测（判定状态机 / 配置夹取 / 铃声序列 / 去重）
node tests/browser.test.mjs    # 无头 Edge/Chrome 真跑一遍：播完是否响铃 + 通知
```

找不到 Chrome/Edge 时浏览器测试会自动跳过。

```
src/core.js     纯逻辑：配置归一化、播完判定状态机、铃声节奏、文案（可在 Node 里直接测）
src/ui.js       DOM 装配：扫描 video、音频、通知、标题闪烁、设置面板
build.mjs       把上面两个文件拼成带 UserScript 头的单文件
tests/          单测 + 无头浏览器集成测试 + 测试页
```

`core.js` 用 UMD 包装，浏览器里挂 `window.VFW`，Node 里 `require()` 得到同一个对象——测试跑的就是线上那份判定代码。

## 更新日志

- **v1.0.0** — 首个版本：三层播完判定、Web Audio 合成铃声、系统通知、标题闪烁、设置面板、广告/直播/循环过滤。

## License

MIT
