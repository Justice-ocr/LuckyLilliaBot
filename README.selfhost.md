# LLBot 独立 PMHQ 改造版

基于 LuckyLilliaDev/LuckyLilliaBot `de60297`（版本 8.3.2），参考
[Qwssttcc/LLBot-selfhost](https://github.com/Qwssttcc/LLBot-selfhost) 的
`selfhost/external-pmhq-v8`（0481432）及兼容包分支。保留原作者署名和 GPL-2.0。

## 运行方式

本版不需要 LLBot 平台账号、平台注册 Token 或原平台签名服务。
**必须另行运行兼容的 PMHQ 与 QQ 客户端**；并非不带客户端的纯协议直连程序。
如外部 PMHQ 自己要求平台注册，本版不会替它取消认证，需选择无需该注册的兼容实现。

要求 Node.js 24。构建后在 dist 下运行：

```sh
node llbot.js --pmhq-host 127.0.0.1 --pmhq-port 13000
# PMHQ 7：显式启用旧 RPC / 二维码回调适配
node llbot.js --pmhq-host 127.0.0.1 --pmhq-port 13000 --pmhq-legacy
```

省略参数时也连接 127.0.0.1:13000，绝不退回平台注册直连。
错误的 host/port 会报错；--direct、--cdn、--dev 已不适用。
AUTH_TOKEN / PMHQ_AUTH_TOKEN 不是本控制器的启动条件。WebUI 默认 http://127.0.0.1:3080/，
首次使用仍需设置本地 WebUI 密码；OneBot / Milky / Satori 的 API 认证保持不变。
/api/backend-status 在 WebUI 密码之后报告后端连接、QQ 在线及错误；连接成功不等于登录成功。
/api/auth-token 与 /api/auth-token/status 不再注册。前端不再访问平台注册接口或弹出注册框。

## 功能与边界

- 保留上游 OneBot 11、Milky、Satori、WebQQ、好友/群/媒体/消息业务代码。
- 保留上游 PMHQ 收包的长度头兼容修复，支持新版 HTTP 登录及显式 PMHQ 7 RPC 登录。
- 增加连接/请求超时、状态持续探测；底层失败不能被当作成功。
- 上游 Direct 源码与原有测试保留以便追踪，但不从生产入口导出/加载；发布包不复制 SignProxy。
  对产物运行 `npm run audit:selfhost`，防止平台注册依赖被重新引入。
- PMHQ 模式原本不支持控制器内快速切换 Direct session 或退出 QQ；本版不伪造这些功能。
  运行中更换 QQ 账号时必须重启控制器，防止跨账号复用已加载的数据库/配置。
  QQ 会话恢复、客户端管理和协议兼容由外部后端提供。状态接口明确报告该能力边界。
- CPU/内存统计仅在后端提供时显示；PMHQ 7 无此接口时返回 null。
- 不声明全部业务操作已在 PMHQ 7 验证；上线前必须验证所需 API 与事件。

参考兼容包固定 PMHQ 7.3.2 + QQ Linux 3.2.31-51102，平台为 Linux amd64。
偏移与 QQ 版本必须配套；不应拿其他版本偏移直接替换。本仓库不自动下载/运行该后端，
也不改动现有 QQ、容器、账号数据或服务器。Windows 本次构建的控制器可运行，Linux 原生 PMHQ
需要 Linux 主机/容器/WSL2。参考仓库的登录记录不是本次改造的真实 QQ 实测证据。

## 构建与测试

使用 package.json 指定的 Yarn 4.18.0 安装后端、pnpm 11.25.0 安装前端。
两个工具均可通过官方 npm tarball 获取；参考仓库 selfhost/manifest.json 提供 SHA256。

```sh
YARN_ENABLE_SCRIPTS=false yarn install --immutable --mode=skip-build
pnpm --dir src/webui/FE install --frozen-lockfile --ignore-scripts
npm run check
npm test
npm run build
npm run build-webui
npm run audit:selfhost
npm run smoke:selfhost
node script/smoke-selfhost.mjs --legacy
```

两个 smoke 命令只启动临时目录中的控制器与回环模拟后端，验证 HTTP 服务、管理认证、
移除的注册路由、断连状态和错误参数退出码，不会登录 QQ 或发送消息。

前端锁文件已按上游现有 package.json 更新，不降级依赖以掩盖构建问题。
完整前端类型检查请单独运行 `npm run check:webui`；若有上游遗留错误需如实记录，不等于生产编译失败。
生产包在 dist/。发布前不要混用上游自动下载最新 PMHQ 的安装脚本/发布工作流。
本次仅修改本地源码和容器配方，没有触发上游发布或推送仓库。

## 本地容器构建

原 Dockerfile 已改为复制本地 dist/，不再下载官方原版发布包。先运行 `npm run build:selfhost`：

```sh
docker build -f docker/Dockerfile -t llbot-selfhost:local .
# PMHQ 已在同一个 Docker 网络运行；pmhq 是其服务名。
docker run --rm --network YOUR_NETWORK \
  -p 127.0.0.1:3080:3080 -v llbot-selfhost-data:/app/llbot/data \
  -e PMHQ_HOST=pmhq -e PMHQ_PORT=13000 -e PMHQ_LEGACY=true \
  llbot-selfhost:local
```

较新 PMHQ 省略 PMHQ_LEGACY 或设 false。容器不会替你启动 QQ/PMHQ，也不附带账号资料。
首次设置 WebUI 密码；需要 OneBot/Milky/Satori 监听端口时，按实际配置额外发布对应端口。
本次环境的 Docker Linux 引擎未运行，故仅验证启动脚本语法，未实测镜像构建。

## 验收清单

1. 本地隔离启动无需平台 Token；管理 API 无 WebUI 密码拒绝访问；平台注册路由不存在。
2. 连接真实后端、扫码成功，确认账号标识；后端断开/QQ 离线状态能正确变化。
3. 私聊/群聊文本、图片、语音、视频、文件、合并转发、撤回与历史逐项验证。
4. 群成员管理、好友申请、通知、API 返回及真实客户端送达分别核对。
5. 重启与重连、重复事件、资源占用和长期运行观察。

构建和模拟后端测试不能代替真实 QQ 登录/收发验收；本次未凭空声称其通过。
