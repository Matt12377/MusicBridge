# MBM-001 私有 HTTPS 接线候选

本文件是双方可直接采用的配置和受控夹具约定。2026-10-09已启动隔离的正式Mac production Main→CoreSupervisor→原唯一Owner→HTTPS候选，使用本次自有103份WAVE与103个独立发行、实际系统safeStorage和原可信Renderer许可入口；没有替换safeStorage、鉴权、Owner或TLS。正式共享iOS SDK的macOS消费驱动已实际完成22项检查及两个独立RAM安装：103专辑和103曲目各七页、重复稳定顺序、搜索、详情、三尺寸真实封面、refresh原body/key回执及logout隔离。32项离线驱动检查另计，桌面admin revoke未在该消费者执行。Root独立回读123份驱动源码及Git blob、对应二进制和1693份声明产品源码及三个生产dist树；候选启动前、就绪、消费后和原自然关闭后输入完整一致，104份自有原件未改。App与父进程自然退出0/null，关闭后原数据库经只读immutable回读计数103/103/103。最终Source/R/CI记账继续单列，客户端系统Keychain、原生iOS页面、LAN、物理手机、真实用户库、音频及Owner验收仍未执行。唯一 HTTP 合同仍为 `packages/contracts/mobile/openapi.json`，SHA256 `ee79461bf672e78c4ac29945d794e46286c92b0f909ced85bc4534a8a6de57bb`，不增加公开字段。

## 地址与证书

- 独立移动服务默认关闭，原 Control API 和 Stream Gateway 继续绑定 loopback。
- 软件 HTTPS Gate 使用 `https://127.0.0.1:<本次实际分配端口>`；端口由服务监听结果取得，不能把占位值当成运行地址。模拟器可使用同一宿主地址，物理手机不能据此宣称已接通。
- 生产候选只允许用户在可信本地设置中选择本机现有私有接口及受控端口，主机使用私有地址字面量。允许 RFC1918 地址及明确的 Tailnet `100.64.0.0/10`；不监听任意公开地址或 `0.0.0.0`。
- `*.ts.net` 后缀本身不证明目的地址私有。Funnel、公开 DNS 地址、混合私有/公开解析结果和重绑定均不能取得私有服务资格。001 首轮使用地址字面量避免该歧义；以后支持域名必须先覆盖完整目的地址校验。
- 桌面持久保存稳定 serverId 和 TLS 身份。配对入口展示 serverId、实际私有 baseURL 和证书 SHA256，公开证书可通过本地可信通道交给客户端；私钥不离开桌面安全存储。
- 客户端验证 HTTPS、有效期、主机 SAN 和可信证书链，并核对本地采纳的精确证书 pin。使用私有自签证书时，由可信本地采纳的证书作为明确 trust anchor；禁止全局关闭 TLS 验证或忽略主机名。HTTP `getServer` 的 serverId 必须与配对时登记一致。

## 配对与权限

桌面“移动连接”设置提供启停、生成五分钟单次配对许可、查看设备和撤销入口。许可仅由可信 Main 生成，发送给 Owner 当前本地页面；不复用 Provider QR、Cookie、Roon 配对或家庭账号退出。配对码、token 和私钥不进入 Git、聊天、日志或普通 IPC。

客户端以本机 installationId、设备名、单次许可和原 Idempotency-Key 调用 `POST /mobile/v1/pairings/claim`，取得 201。刷新为 `POST /mobile/v1/auth/refresh` 的 200；当前设备退出为 `POST /mobile/v1/auth/logout` 的 204。丢回复只按同 key/body 取原回执，不能换 key 重做。撤销当前设备不注销其他手机或家庭 Roon。

access 有效期十五分钟，refresh 三十天并原子轮换。Main 持有独立移动加密上下文；唯一 Dataset Owner 持久保存受控加密状态和原回执。公开请求不能通过 datasetId、路径、Provider 引用或普通 IPC 名称证明权限。

## 只读接线

配对后调用 capabilities，再使用 albums、albums/{albumId}、tracks、tracks/{trackId} 以及 artwork/{artworkId}?size=96|256|512。搜索 q 仍在 albums/tracks 操作内。分页 limit 最大100，q最大200字符；cursor绑定服务器、设备、工作库、账号域、来源、实际库修订、排序、过滤和专辑。

读取经过当前 Owner 的权限、恢复和关闭围栏。目录返回实际登记的独立发行、曲目与精确音频事实；缺发行、时长或音频证据时明确失败，不能伪造 unknown 专辑、零时长或默认规格。图库只读取当前保存选择并编码三个真实尺寸；GET 不调用 stage/apply。001能力不宣称尚未实现的播放、转码或无损转换。

## 合成目标与就绪条件

Root 在外置任务 `checks/`、`tmp/`、`gates/` 内生成隔离 TLS 身份、许可和最少超过100首的合成已登记 Owner 库。测试客户端只信任本次确切证书，实际读取 server、claim、capabilities、多页目录、详情和三个封面尺寸，并覆盖错误 pin/SAN、无效或撤销 token、换库和改库 cursor、过期许可、refresh迟到、旧目录失效及自然关闭。

合成证书/许可/目录不会导入用户生产数据。实际地址、私钥、许可和 token 仅保留在本次外置私有材料，公开收据只记录身份摘要、无凭据的请求类型、结果和资源收口。

候选就绪须同时具备：正式服务可启动、可信桌面入口可用、Owner真实接点已接入、适用软件/HTTPS/App Gate通过、对应客户端精确版本可采用。届时在自然进度中提供候选目录与无凭据收据；真实运行层与物理手机结果继续单列。

本次有效运行目录由Root私有 `checks/MBM001_CANDIDATE_READY_REPLACEMENT69.json` 指向，运行绑定655份产品源码Git blob到Source fc3c523及全部1693份声明输入；`connection.json`仍严格只有下述五个公开字段。此前run-a3koFn因Root在同一checkout重跑Gate，导致固定worker构建收据时间戳改变，已明确撤回并经原关闭链自然退出；记录见 `checks/MBM001_CANDIDATE_WITHDRAWN66.json`，该运行不计通过。新候选run-TNbvog启动后所有编译与Gate均在独立Source镜像执行，脚本和交付文档修订不改变其声明产品输入。

运行中许可通过同uid的0700请求与响应目录采纳，文件0600、无链接、完整稳定FD校验。客户端须在requests目录外写完0600暂存文件，再原子移入单一UUID最终名称，发布闭集请求 `{schemaVersion:1,requestId:UUID,operation:"issuePairingPermit"}`；requests内的中间文件会触发安全关闭。Root调用同一frame的原 `window.musicBridgeMobile.issueMobilePairing()`，将许可只写入该UUID的私有响应。该入口不声明点击按钮；原两个App用例的按钮证据另列。不重发同requestId，最多八次，无许可、access或refresh进入聊天、日志或Git。停止文件 `{schemaVersion:1,operation:"stop"}` 同样从目录外完整原子移入；一小时上限收口原Main/HTTPS，最终检查自然退出、原材料不变及仅只读immutable回读关闭后的自有数据库。就绪收据与发布许可都不能代替iOS消费收据。

## 双端采纳的公开连接资料

桌面可信设置导出且客户端按同一表示采纳以下 JSON。全部字段只描述本台 HTTPS 身份；没有配对许可、access/refresh、私钥或 Provider 资料。

```json
{
  "schemaVersion": 1,
  "serverId": "本台持久服务器ID",
  "baseURL": "https://实际私有IPv4:实际端口",
  "certificateSha256": "证书DER完整字节的64位小写SHA256",
  "certificatePEM": "本台公开X.509证书的PEM完整文本"
}
```

`baseURL` 没有路径、query、fragment或userinfo；首轮只接字面IPv4。客户端先校验闭集资料及证书DER指纹、有效期和IP SAN，再将该精确公开证书用于当前源站的显式trust anchor。锚和pin仅对该源站生效，redirect一律拒绝。随后读取getServer，serverId必须与资料完全一致。许可仍经单独的本地可信入口采纳，不能放入该JSON或日志。字段表示见 `apps/desktop/src/shared/mobile-settings.ts`。

001目录未指定 `source` 时明确采用local；显式 `source=all` 或 `source=netease` 返回503/BUSY、retryable=false。当前没有能由该Owner证明的完整移动网易目录，不返回本地子集伪装为all。已授权library曲目缺独立发行或精确音频事实时返回有限错误；不静默漏项。
