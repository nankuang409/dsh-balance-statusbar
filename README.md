# dsh-balance-statusbar

DeepSeek Harness（DSH）**web GUI** 插件：在页面**底部**固定一条浅色状态栏，**原会话统计条（轮数/步数 · LLM/工具时长 · 首 token · 解码吞吐 · 缓存命中 · 输入/输出 token）＋ 费用（总余额 · 今日消费 · 当前对话费用）** 合为一条，风格对齐内置统计条。

> 独立插件：自带宿主路由（`/api/balance-statusbar`），不依赖任何其他插件。统计数据直接复用框架内置会话投影（`sessionStats` + `tokenUsage`），与 UI 内置统计条 **StatsLine 完全同源**——不会丢失原来的统计。

## 功能

- 底部固定状态栏（注册在框架级 `shell.overlay` 槽位，纯叠加、不遮挡应用）。
- **统计段**（与内置 StatsLine 同数据源、同格式）：
  - `N 轮 · M 步`
  - `LLM 2m42s · 工具调用 45.2s`
  - `首 token 平均 3.8s · 130 tok/s`
  - `缓存命中 97% · 输入 1.2M · 输出 12.2K`
- **费用段**：
  - **余额**：DeepSeek 官方 `/user/balance` 返回的总余额。
  - **今日已消费 / 今日约消费**：配置 `DEEPSEEK_PLATFORM_TOKEN` 时取官方平台用量（精确）；否则按余额差值估算（前缀「约」）。
  - **当前对话费用**：宿主按官方价格表对会话日志全量回放计价（含安装前历史、含峰谷定价），同时显示累计 token 数。
  - **更新时间**：每次刷新成功的时间（HH:MM:SS）。
- 余额每 60 秒自动刷新、费用与统计每 5 秒自动刷新；点击状态栏任意位置可手动刷新。
- 跟随应用浅色/深色模式（仅使用既有 `--dsw-*` 主题 token）。
- API key 永不出机器：浏览器只与本机宿主路由通信。

## 安装

需要 DSH CLI 与 [pnpm](https://pnpm.io/installation)。

尚未发布到 npm，先克隆再按本地路径安装：

```sh
git clone https://github.com/<owner>/dsh-balance-statusbar.git
cd dsh-balance-statusbar
pnpm install
dsh plugin --profile web add .
```

（发布到 npm 后可直接 `dsh plugin --profile web add dsh-balance-statusbar`。）

包声明了 `dsh.bundle` 与 `dsh.client`，`dsh plugin` 会自动加入 profile 的 bundle 层（无需手动编辑 patch）。然后：

1. 重启 web 应用：`dsh web`（bundle 层在启动时读取）。
2. 打开页面并刷新。
3. 底部出现状态栏。

> 手动替代方案：把包装进 profile 的 `node_modules`，并在 `~/.dsh/profiles/web/cordis.patch.yml` 增加 loader 条目：
>
> ```yaml
> - insert:
>     - id: balance-statusbar
>       name: dsh-balance-statusbar
> ```

## 配置

复用 DSH 已有的 `DEEPSEEK_API_KEY`（在 设置 → 模型 中填写，存于 `~/.dsh/.credentials.yaml`，或在启动环境导出）。

可选：`DEEPSEEK_PLATFORM_TOKEN`，用于把「今日已消费」从估算换成官方精确数字。获取方式是登录 https://platform.deepseek.com → DevTools → Console 执行 `JSON.parse(localStorage.getItem('userToken')).value`，再存入凭据。

> ⚠️ 这条走的是 DeepSeek 平台**非公开接口**（`/api/v0/usage/cost`），不是官方 API 契约：接口随时可能变更或失效，token 也会过期。不配置只是「今日消费」退化成按余额差值估算（显示为「今日约消费」），其他功能不受影响。

## 工作原理

| 部分 | 文件 | 说明 |
|---|---|---|
| 宿主 | `lib/index.js` | Cordis 插件（`inject: credentials, webServer, sessionProjections`），注册 `GET /api/balance-statusbar?sessionId=<id>`，聚合统计（内置投影）、余额、今日消费与当前对话费用。 |
| 计价 | `lib/pricing.js` | DeepSeek 官方价格表引擎（政策时间表 + 峰谷定价），移植自 [dsh-web-billing](https://github.com/bpc-oss/dsh-web-billing)（MIT）。 |
| 浏览器 | `lib/client.js` | `dsh.client` web bundle，把状态栏注册进 `shell.overlay`；轮询余额 60 秒、费用与统计 5 秒。 |
| 组合 | `cordis.patch.yml` | `dsh.bundle` patch 层，插入 loader 条目。 |

## 仓库结构

```
dsh-balance-statusbar/
├── lib/
│   ├── index.js      # 宿主端：聚合路由 /api/balance-statusbar（统计+余额+今日消费+会话费用）
│   ├── client.js     # 浏览器端：底部状态栏（shell.overlay 槽位）
│   └── pricing.js    # DeepSeek 官方价格表引擎（含峰谷定价，MIT 移植自 dsh-web-billing）
├── cordis.patch.yml  # bundle loader 条目
├── package.json      # dsh.bundle + dsh.client 声明
├── README.md
├── LICENSE           # MIT
├── THIRD-PARTY-NOTICES.md  # 移植代码的上游 MIT 声明
└── .gitignore
```

## 开发

```sh
git clone <your-fork>
cd dsh-balance-statusbar
pnpm install          # 需要 @deepseek-ai/dsh-credentials
dsh plugin --profile web add .
```

修改 `lib/client.js` 后重启 `dsh web`（boot-graph hash 重新生成），再硬刷新页面。

## License

MIT，见 [LICENSE](LICENSE)。`lib/pricing.js` 移植自 [bpc-oss/dsh-web-billing](https://github.com/bpc-oss/dsh-web-billing)（MIT），上游版权声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
