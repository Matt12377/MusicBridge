# Git 工作树约定

后续工作树放在对应主工作区的 `worktree/` 下，用 Git 登记，分支使用 `codex/` 前缀。

当前 Mac 主工作区是 `/Volumes/LifeWeave/VSCode/MusicBridge`，本轮 4.1 在其已登记的 `worktree/v4` 中交付。主工作区已经有 `worktree/`，沿用该目录；其旧分支及未提交文件保持原样。

当前 iOS 主工作区是 `/Volumes/LifeWeave/VSCode/MusicBridge-ios-latency`，已建立 `worktree/` 和目录说明。既有同级 Duo 工作树保留，只整合其五个界面文件的实现提交。

从对应主工作区执行，先确认下一任务的基线提交：

```sh
git worktree list
git worktree add -b codex/功能名称 worktree/功能名称 已确认的基线提交
```

同一分支只在一个工作树中检出；已有合适工作树时优先复用。不要用复制普通目录替代 Git 工作树，不在其他任务的检出中切换分支、清理或重置。

新工作树中的构建、缓存、DerivedData、测试结果和临时文件，继续写到外置 `LifeWeave/Developer` 目录。本约定不授权移动或删除旧工作树。
