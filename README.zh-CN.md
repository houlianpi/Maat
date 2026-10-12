<div align="center">

[English](README.md) | **简体中文**

# ⚖️ Maat

### Coding Agent 的真实 UI 执行能力

</div>

Maat 帮助 Coding Agent 观察和操作真实界面。宿主理解任务并规划动作，Maat 提供设备发现、
界面观察、执行、取消和失败反馈。当前重点是 Pi 中的 Android Mobile Use；保留 Web、
iOS 和 macOS 执行 Adapter。

Maat 不再生成或运行正式 Case，不录制 Replay，也不产生业务验证报告。命令成功、连接就绪
都不等于业务成功。用户需要编写项目测试时，由宿主选择语言和测试框架。

## 快速开始

```bash
pi install npm:@houlianpi/maat-pi
pi
```

当前准备流程限定本地：Pi、Appium 和手机的 ADB 连接在同一台电脑上，暂不处理远程准备。
向 Pi 描述“帮我准备 Android 手机并读取当前界面”。包内的 `maat-setup` Skill 指导 Agent
使用宿主已有工具和权限完成必要准备；Maat 不另建安装 Agent 或服务管理器。

选中 Android 后：

- `/maat-setup` 将准备流程交给宿主 Agent。
- `get_setup_diagnostics` 工具提供脱敏的环境诊断；输入区显示平台状态。
- Pi 扩展默认显示紧凑卡片与简洁单行状态。

使用 `pi --maat-raw-ui` 恢复原始工具显示与状态，该开关优先于已有的 `--maat-mobile-ui`；
后者仍兼容，但已无需指定。使用不带值的 raw 开关，不要用等号 false 值关闭 boolean flag。
所有 Maat 工具保留完整展开结果、模型内容与 structured 事实，Pi 仍独立绘制内联图片。
状态优先显示需要本人处理的问题与执行风险；返回结果不是实时连接或业务完成证明。
控制来源、状态含义及尚需人工视觉验收的范围见
[Pi 包指南](packages/pi/README.md#mobile-tui-preview)。

独立 Pi-backed TUI：

```bash
npm install --global @houlianpi/maat
maat
maat help
```

保留一次性 Web Agent 入口：

```bash
maat agent --browser chromium --headless "读取页面，说明当前可见内容"
```

## 准备、观察、操作

1. 选择平台和目标设备；多台手机时不能猜测。
2. 用 `check_platform_setup` 检查准备条件。复用安装、健康服务和正在启动的工作，只补实际缺项。
3. Android 或本地物理 iPhone 使用 `check_device_ready` 建立或复用 Session，返回当前控件树和视口；
   需要视觉观察时传 `screenshot=true`。iOS 普通任务默认建立必要连接，须 live WDA 确认
   当前解锁才返回业务 UI 观察；首次 WDA 安装、重签名和重启仍需独立授权。
4. 用 `exe_js` 执行 UI 代码，唯一输入是 `code`。返回的是观察，不录为正式步骤。
5. 授权、解锁或认证需要本人完成时暂停；实际完成后重新观察并继续原任务。

Doctor 检查准备条件，不证明业务结果。Appium 响应不代表手机可操作。连接恢复不得重放
已可能执行的点击、输入或提交。宿主 Shell 和文件工具始终遵循宿主权限，不再有 Maat 模式切换。

Maat 动态识别已有 Android 工具与自己的本地缓存。setup Skill 携带的 `android-tools.mjs`
在授权范围内补齐 ADB/AAPT2；Pi 的 `prepare_mobile(start-appium)` 用同一套环境
启动并跟踪现有 Appium。用户无需另开终端、配置 SDK 环境变量或重启 Pi。
下载官方 platform-tools 时需要本人实际接受许可；已有工具优先复用。
此辅助脚本不安装完整 SDK、Android Studio 或 JDK，但不保证所有 Appium 签名/安装流程都免 Java。
Appium 引擎没有更换。

继承到的 SDK 环境变量只是候选路径：有效则复用，无效或冲突时明确提示，并继续查找已验证的工具。
不会为此改写用户配置、要求重启 Pi，或让用户寻找缓存。用户明确指定必须使用某个 SDK 时则保留其要求。
`/maat-setup` 在首次默认 Web 状态进入 Android；`/maat-setup android` 也可显式选择。
模型收到的诊断内容包含状态、错误类别和准备动作，不依赖 UI 详情或 MCP 专用字段。

首用体验以真实 Pi/LLM 任务独立验收：累计五分钟、最多两次机会内，提供实际手机观察和低风险结果。
授权与下载许可由本人处理，但普通配置查找不逐项追问。单元测试或手工预启动服务不能替代此验收。
Pi 已实现持有 foreground child 的 Appium 任务，并有受控 process/HTTP 测试。
以 `prepare_mobile(status,taskId)` 查询，单次等待 0–20 秒、启动总体期限 60 秒；
`ready` 仅为 serviceResponding。可跟踪启动机制缺口已补，但真实手机自主首用仍未验收；
人工预启动不算首用成功。
后续真实 Pi/LLM 解锁恢复验证已在 93.478 秒（含清理）内完成可跟踪启动、
有效构建复用和实际计算器结果。这个限定恢复场景不追改原首用失败，
也不代表全新机器安装通过。

### iOS 准备与验收边界

在本地 Mac 上使用 `/maat-setup ios`，明确选择目标物理 iPhone。只读 doctor 检查
Xcode、Appium CLI、XCUITest、连接/配对、Developer Mode 与 Appium；准备通过不证明
WDA 签名有效或手机 ready。iOS readiness 预算 180 秒（Android 15 秒）。
普通手机任务自动建立必要控制连接，不逐冷 Session 确认初始化。实际诊断后复用有效构建
与手机已有 helper；本机有效构建不等于手机已安装，连接前须检查实际安装/签名。
CoreDevice 的 `passcodeRequired:false`/`unlockedSinceBoot:true` 不是当前解锁证明，
也不是初始化授权门槛。已知锁定需本人解锁；连接后 live WDA 实时确认锁状态，可用性未确认
前无 source、截图或业务 UI，不自动解锁、不重放。`IOS_DEVICE_LOCK_STATE_UNKNOWN` 只表示
真实锁查询失败/无布尔，显示连接未确认而非冷连接待授权。
`IOS_WDA_INSTALLATION_AUTHORIZATION_REQUIRED` 单独请求所选手机首次安装控制组件授权，
未授权不安装；模型明确获准后内部处理 `allowWdaInstallation`，不让用户配置参数。
`IOS_WDA_SIGNING_REQUIRED` 不自动续签；`IOS_WDA_INSPECTION_FAILED` 保留实际检查失败；
`IOS_CONNECTION_INITIALIZATION_DISABLED` 仅是兼容调用方禁用初始化。
首次安装、重签名、重启仍独立授权，必要时一次合并具体影响，不索取 Apple 凭据。
信任、Developer Mode、密码仍由本人处理；不能误用 Android SDK、
UiAutomator2 手势/输入或 Android Back。

`IOS_WDA_CONFIGURATION_CONFLICT` 报告签名 hint 不匹配或手机其它 testRunner，
避免 Appium cleanup 删除。`IOS_READINESS_UNSUPPORTED` 报告不符合安全复用的配置
（`useNewWDA`、自动接受/关闭提示、禁 prebuilt、强 preinstalled 或自定义 suffix）。
仅报告明确配置问题，不自动改配置、重装、改 Team 或改变用户服务/手机数据；
首次安装授权不是重签名权限。

本地 Mac+目标真机 doctor 已准备通过；Pi 接入回归与真机初始化、完整自主首用分别验收。
经明确授权续签/部署后，已验证的 WDA 构建通过 XCTest `test-without-building` 启动成功，
ready 返回真实控件树、视口和截图；系统计算器 `3×3×8` 的显示值与截图均为 `72`。
这是脚本驱动的真机功能验证，不是 Pi/LLM 自主首用验收。续签后的直接预装启动仍遭拒绝。
后续模型驱动恢复独立清除旧结果、读到 `0`、重新计算并观察到 `72`；
范围见 [解锁恢复记录](docs/native-testing.md#model-driven-unlock-recovery)。
8100 的 WDA 实际属于另一模拟器，不是 iPhone 证据。
`IOS_WDA_SECURITY_REJECTED` 可能涉及签名、权限或描述文件信任；只检查一次开发者 App
信任，已信任或没有入口则核查签名/有效期，不循环重试。
`prepare_mobile(build-ios-wda)` 先 inspect，valid build 不重构建；missing/expired
须本人明确签名授权，保留现有 Team/bundle。付费/免费均使用真实 profile/certificate 日期，
不默认七天；内部 hints 不进入 content，首次安装/重签名/重启仍需独立授权，普通连接初始化不设确认门槛。保留外部服务；
人工预启动 Appium 不能替代五分钟首用验收。

## 工具与运行时

| 工具                                                                 | 用途                                          |
| -------------------------------------------------------------------- | --------------------------------------------- |
| `list_platforms`、`select_platform`                                  | 查看并选择 Adapter                            |
| `list_devices`、`find_applications`、`configure_session`             | 发现设备/App，提供旧兼容配置／匹配提示        |
| `check_platform_setup`、`get_setup_diagnostics`                      | 准备条件诊断                                  |
| `prepare_mobile`                                                     | 跟踪本地 Appium 启动 / iOS WDA 复用或授权构建 |
| `open_setup_step`、`retry_setup_step`、`continue_without_capability` | 准备指引、授权复查和可选能力选择              |
| `check_device_ready`                                                 | 检查 Android/iPhone 通道并返回观察            |
| `configure_browser`、`get_browser_config`                            | Web 配置                                      |
| `exe_js`                                                             | 在当前持久 UI Session 执行代码                |

Web 暴露 Playwright `page/context/browser`，原生平台暴露 WebdriverIO `driver/browser`。
通过 `list_platforms` 查看具体 globals。文字使用 `console.log`，`display` 接受
PNG/JPEG/WebP 图片字节或 image data URL。原生 `evidence.screenshot()` 只是截图观察辅助，
不是正式 Evidence 存储或报告系统。

Appium Session 可在源码之外使用旧兼容配置或匹配提示。这些提示不是目标选择、用户同意、
动作授权、默认设备或 ready 证明，也不能跨生命周期恢复目标。设备字段只有与当前事实精确且
无歧义匹配时，才可缩小本次候选方案；零／单／多候选选择规则仍然适用。active 生命周期的
identity 与 endpoint pin 只存在于易失内存。Pi/standalone TUI 只持有自己的 service child，
先清 owned Session 再清 owned process，不停止健康用户 Appium。
现有原生关闭逻辑可能终止已配置的目标 App，本次清理没有改变这一行为。
详见 [原生准备](docs/native-testing.md) 与 [Setup Assistant](docs/setup-assistant.zh-CN.md)。

## 架构

```text
Coding Agent / Pi
  ├── 宿主工具 + maat-setup Skill → 已授权的环境准备
  └── Maat 工具 → Core → Adapter / 可终止 Worker → 真实 UI
```

- `packages/core`：Host-neutral API、Adapter、Worker、setup 检查。
- `packages/pi`：Pi 工具、setup Skill、UI。
- `packages/maat`：独立 Pi-backed TUI、一次性 Agent、可执行文件。

Core 不导入 Host SDK。模型代码仅在带超时、Abort 和协议/输出限制的可终止 Worker 中执行；
这不是文件系统或网络安全沙箱。截图、UI 文本、设备标识和凭据不得随意进入共享日志和源码。
保留 App 数据和登录，清空需要明确用户意图。

## 不兼容清理

已移除 Draft/Case API、`@houlianpi/maat-core/test`、Case 工具、模式切换、Runner/报告、
`maat test`、`maat cases` 和 `maat replay`。`maat-tests/` 原文件保留为历史资产，
不再由当前产品运行，也不参与项目 typecheck；没有改写或删除。

旧消费者需要迁移，不能把这次改动作为兼容补丁发布。

## 开发与发布

```bash
npm ci
npm run build
npm run typecheck
npm run format:check
npm test
npm run package:check
```

`package:check` 构建、打包并在临时目录安装三个包，验证安装后的 Worker、CLI、Skill 和依赖边界，
同时检查旧正式测试模块未混入 tarball。Mock 只证明契约；原生平台能力需要真机验证。

发布仍使用 [publish.yml](.github/workflows/publish.yml)、一致的 workspace 版本、
npm Trusted Publishing 和 provenance。Release 标签必须等于 `v<workspace version>`，
顺序为 Core → Pi Extension → 独立 Maat。GitHub 预发布进入 npm `next`，
正式 Release 进入 `latest`。
手动触发该工作流只重跑验证与当前 `next` 渠道检查，不重复发布包。
渠道核验最多等待五分钟，让 npm 完成处理，并确认预发布没有改动 `latest`。

`0.3.2` 是用于本地 Android 首用验证的预发布，包含不兼容 API 删除，并不是旧测试 Harness
的兼容补丁。Pi 自主启动 Appium 的首用验收尚未通过。测试时请明确安装这个版本：

```bash
pi install npm:@houlianpi/maat-pi@0.3.2
```
