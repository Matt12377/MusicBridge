# Roon 续播封面与前后切歌修复

## 身份与范围

- Owner 反馈：应用只播放一首本地歌曲后，Roon 自行续播时，曲名/歌词跟随但封面缺失、上一首/下一首禁用；明确同意替换并重新打开本机安装版。
- 工作树：`worktree/v3-ui`；分支：`codex/roon-continuation-controls`。
- Base：`492b19026f51ffabd56d3bed28f6a453da34a4d5`，开始前已核对与远端歌词分支一致。
- 实现提交：`578c1be448f3389656fa341a053dc88e1a969f29`；结果报告由后续独立提交记录，下一分支基线为该报告提交 HEAD。
- 本轮不推送、不合并；保留原有未跟踪 `apps/desktop/test-results/`、`prototypes/metafine-study/`。

## 原因与修复

1. 原来的原生续播跟随逻辑只投影标题、艺人、专辑与时长；无法匹配应用队列时有意丢弃旧封面，但没有获取当前封面的链路。现在从固定版本 Roon Transport 的 `now_playing.image_key` 读取有界内部图片键，经公共图片服务转成作用域内不透明引用；复用受控图片加载、验证与缓存，不搜索猜测专辑，不暴露原始键，也不创建可播放实体。
2. `canNext/canPrevious` 原来完全取决于应用队列位置；队列外索引为 -1，按钮被禁用，控制函数也立即返回。现在应用队列有邻项时仍按原顺序播放；没有邻项且仍是同一所选 Zone 的本地播放时，根据 Roon 实际导航能力发出原生控制。
3. 原生切换不先 stop、不重播旧歌曲、不伪造队列位置或成功曲名。曲目与封面由后续 Transport 观测更新；能力不可用时不发送命令，失败保留原状态并沿用现有错误处理。
4. 同一首歌的迟到封面和导航能力变化也更新界面；错误 Zone/旧 revision/loading 观测不接管当前曲目。网易云与应用内混合队列原逻辑保留。

## 验证

全部使用 Node 22.23.2 / pnpm 10.17.1，串行运行，测试并发 1；外置 LifeWeave APFS 已核对挂载、可写。所有日志和构建结果均在外置卷。

| 检查 | 结果 | 证据范围 |
|---|---|---|
| 新增控制器回归测试修复前 | 3 个测试按预期失败，exit 1 | 捕获缺失封面、禁用导航及未派发控制 |
| Core 相关回归 | 222/222，exit 0 | adapter、公共图片服务、controller、混合队列、Display 歌词、runtime、utility IPC；非完整仓库回归 |
| Core 与 Desktop 类型检查 | exit 0 | 含 E2E 类型检查 |
| Core/Desktop 生产构建 | exit 0 | 安装包所用产物 |
| Electron 续播界面 E2E | 1/1，exit 0 | 合成 IPC；队列外封面成功解码、全屏与底栏导航启用、点击 next/previous 正确派发 |
| Control Plane / Boundaries / diff check | exit 0 | 静态与边界 |
| macOS arm64 打包 | exit 0 | publish never；ad-hoc，非公证发布 |
| 构建包/安装包签名完整性 | exit 0 | codesign deep strict |
| 构建包/安装包隔离启动 | 各 exit 0，ready/markerSeen/closed 为 true | 外置独立用户目录，mock keychain、合成 Core |
| 普通正式版启动 | 通过 | 原生窗口显示真实歌单、首页、所选输出；未改账号凭据 |
| 真实歌曲自然结束后的续播 | 未执行 | 不用合成测试或普通启动替代，待 Owner 实机复测 |

测试中间问题：新增 E2E 控制桩最初返回 `{ok:true}` 而不是既有合同要求的播放快照，导致点击后状态被清空；修正合成返回值后通过。Core 初次类型检查捕获测试记录中可选字段与 undefined 不兼容，修正测试类型后通过。均未为测试放宽产品合同。

主要日志位于 `/Volumes/LifeWeave/Developer/CommandLine/tmp/`：

- `mb-continuation-red.log`、`mb-continuation-final-tests.log`。
- `mb-continuation-types.log`、`mb-continuation-final-desktop-types.log`、`mb-continuation-build.log`。
- `mb-continuation-e2e-final.log` 与 `mb-continuation-e2e-final-results/`。
- `musicbridge-continuation-loQsoZ/package.log`、`packaged-startup.log`、`installed-startup.log`。

## 安装

- 安装路径：`/Applications/Music Bridge for Roon.app`。
- 正常菜单退出当前旧开发版；安装路径原包未运行。新包先复制到精确暂存路径并校验，再移动旧包到完整备份，暂存包改为正式路径。未删除用户数据或备份。
- 旧包备份：`/Volumes/LifeWeave/Developer/CommandLine/Backups/MusicBridge/2026-09-20-continuation-WwjFWB/Music Bridge for Roon.app`。
- 构建包与安装包 `Contents/Resources/app.asar` SHA-256 一致：`fb0e1bca67efaec3beb5a818183e94524b2f745936de91e7e272a89402c45a8d`。
- 普通安装版已重新打开；没有再次播放或切换真实歌曲。此前启动的开发版与此安装版身份不同，本次已明确关闭旧开发版。

## 保留边界

- Roon 本身不给封面、图片服务失败或不允许某项导航时，不伪造封面/可用能力。
- 单曲自然结束、Roon Radio/队列连续切换的真实设备行为仍待复测；本轮未做真实听感、远端 CI、Owner 验收。
- 本轮没有增加应用冷启动自动接管任意 Roon 外部播放；当前跟随仍从应用已启动的本地播放上下文开始。
