# API 4.40.1 离线密码学兼容原件

原官方 npm 包为 `@neteasecloudmusicapienhanced/api@4.40.1`，MIT许可证原文在 `LICENSE`。`SOURCE_IDENTITY.json` 记录官方tarball SHA256、npm integrity、9746-byte原 `util/crypto.js` 与本轮补丁后像摘要；原源文件逐字保存为 `official-original-crypto.cjs`。

`old-weapi-64-golden.json` SHA256为 `b88286b1900b2f9590bff0189617e9d71ca1bb0823ed0cdc38df89ad9dcf570a`，由冻结producer在独立VM中调用原官方源码及原forge1.4.0生成：62个base62单字符重复16次、两个混合secret，合成ASCII/Unicode/嵌套JSON，每项恰16次Math.random。`OLD_ORACLE_IDENTITY.json` 绑定旧源码与producer字节；这是原输入准备，不是新实现验证PASS。producer不得对产品源/依赖树写入，输出用新外置目录；旧forge不再进入产品依赖。

产品仅替换唯一raw RSA函数与移除唯一forge require：Node22 `createPublicKey/publicEncrypt(RSA_NO_PADDING)`、按模数宽左补零、小写定宽hex。weapi原16字节secret/一次逆序/两次AES、其余全部源码与12导出保留。测试比对真实安装后像、64项旧黄金、独立BigInt模幂、其它导出的旧/新离线差分、已存在公开输入错误语义。

合同限原weapi的16字节base62输入，不能推定任意字符串、超长或大于模数的参数在Node与旧forge之间具有完全相同错误语义。没有网络请求、账号、凭据、播放或真实服务验收。

精确parent override仅删除此已替换包中不再使用的forge边；pnpm真实生成lock与patch hash后再frozen install，原生产audit使用官方registry及原high阈值，不伪版本、不ignore、不降阈值。
