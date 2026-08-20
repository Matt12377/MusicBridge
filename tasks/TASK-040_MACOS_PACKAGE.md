# TASK-040 — DMG、签名、公证与干净机

## 目标

生成可安装的 macOS Beta 包，完成签名、公证和干净用户验证。

## 规则

- 不加入自动更新。
- 固定 bundle id、版本与第三方许可证。
- 构建过程不打包 `.env`、日志、fixture secrets。
- 记录 arm64/universal 决策。

## Exit Gate

DMG 安装、首次启动、Roon 配对、扫码登录、播放和卸载均通过。
