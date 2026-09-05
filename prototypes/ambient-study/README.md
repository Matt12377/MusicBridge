# 背景双状态独立预览

在仓库根运行 `python3 -m http.server 4186 --bind 127.0.0.1 --directory prototypes`，打开 `http://127.0.0.1:4186/ambient-study/`。

- 未播放：使用生成的连续曲面背景。
- 播放中：使用当前示意曲目的封面作为整窗背景；暂停保留，切歌交叉淡入。
- 可操作：封面选择、播放/暂停、前后切歌、默认状态恢复、背景单独查看、主页/收藏列表、搜索、队列、歌单折叠与说明弹窗。
- 其他导航保留视觉入口并明确提示未实现，不连接正式服务。
- URL 参数 `?state=playing` 可直接进入蓝色封面播放示意状态。

素材：`assets/default-scene.png` 为本轮图像生成产物；示意封面和 Bootstrap 图标复用相邻 `sakura-glass/assets`，来源与许可见其 `CREDITS.md`。封面照片不是实际专辑封面。

本预览不接入 IPC、用户数据库、Provider、Roon 或真实音频。正式 Electron 代码未改变。
