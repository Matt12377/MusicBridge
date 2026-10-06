# 原017之后的移动采纳待办

本登记仅记录后续工作，不新增原18任务/156AT，不在008接入手机后端。MBM-000～004均未开始。

已独立核验iOS本地候选 `Contracts/proposals/UI_V39.openapi.json`：info.version 1.2.0，50306 bytes，SHA256 28bd12d7404504f11d1ada5a21fd64cd84fc8288a48213a0cb995d88b24005b7，11个operation。iOS工作区有未提交改动；观察HEAD 5f5938b69b1f47e4ebb919f7a6476b9d4dc78b50 不认证这些新内容的远端交付。candidate仍待Mac明确采纳，不声称正式实现。

| 方法 | 候选路径 | operationId |
|---|---|---|
| GET | `/mobile/v1/ui/capabilities` | `getUIContentCapabilities` |
| GET | `/mobile/v1/ui/home/added-albums` | `listRecentlyAddedAlbums` |
| GET | `/mobile/v1/ui/netease/daily-recommendations` | `getNeteaseDailyRecommendations` |
| GET | `/mobile/v1/ui/tracks/{trackId}/lyrics` | `getExactTrackLyrics` |
| GET | `/mobile/v1/ui/netease/liked-playlist` | `getNeteaseLikedPlaylist` |
| GET | `/mobile/v1/ui/netease/liked-playlist/tracks` | `listNeteaseLikedPlaylistTracks` |
| GET | `/mobile/v1/ui/favorites/albums` | `listFavoriteAlbums` |
| GET | `/mobile/v1/ui/favorites/albums/{albumId}` | `getFavoriteAlbumState` |
| PUT | `/mobile/v1/ui/favorites/albums/{albumId}` | `setAlbumFavorite` |
| GET | `/mobile/v1/ui/favorites/albums/{albumId}/tracks` | `listFavoriteAlbumTracks` |
| PUT | `/mobile/v1/ui/favorites/tracks/{trackId}` | `setTrackFavorite` |

待MBM-000按冻结合同与候选版本分别确定：能力协商、maxBitsPerSample位深扩展、账户域与Mac权威收藏存储；完整专辑详情和独立整专/精确版本单曲收藏；修订、内容快照、总数和游标绑定；两个PUT的期望值/幂等回执/CAS/丢ACK重放。收藏详情始终完整，红星表示独立收藏状态，不能只过滤已收藏曲目。

后续仍需认证网络、分页store、持久化与跨端同步、真实回执及MBM-003受控无损FLAC兼容。sourceAudio/actualAudio/processing分列；旧默认能力或codec未知不能授权有损转换。本文只核验候选文件身份和待办，不复验iOS构建/测试、安装UI、真实账号服务设备与音频。
