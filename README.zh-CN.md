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
- `/maat-doctor` 展示脱敏的环境诊断。
- `/maat-status` 展示当前平台和准备状态。

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
3. Android 使用 `check_device_ready` 建立或复用 Session，返回当前控件树和视口；
   需要视觉观察时传 `screenshot=true`。建立 Session 可能部署辅助组件或触发系统提示。
4. 用 `exe_js` 执行 UI 代码，唯一输入是 `code`。返回的是观察，不录为正式步骤。
5. 授权、解锁或认证需要本人完成时暂停；实际完成后重新观察并继续原任务。

Doctor 检查准备条件，不证明业务结果。Appium 响应不代表手机可操作。连接恢复不得重放
已可能执行的点击、输入或提交。宿主 Shell 和文件工具始终遵循宿主权限，不再有 Maat 模式切换。

Maat 动态识别已有 Android 工具与自己的本地缓存。setup Skill 携带的 `android-tools.mjs`
在授权范围内补齐 ADB/AAPT2，并用同一套路径启动现有 Appium。用户无需配置 SDK 环境变量或
重启 Pi。下载官方 platform-tools 时需要本人实际接受许可；已有工具优先复用。
此辅助脚本不安装完整 SDK、Android Studio 或 JDK，但不保证所有 Appium 签名/安装流程都免 Java。
Appium 引擎没有更换。

继承到的 SDK 环境变量只是候选路径：有效则复用，无效或冲突时明确提示，并继续查找已验证的工具。
不会为此改写用户配置、要求重启 Pi，或让用户寻找缓存。用户明确指定必须使用某个 SDK 时则保留其要求。
`/maat-setup` 在首次默认 Web 状态进入 Android；`/maat-setup android` 也可显式选择。
模型收到的诊断内容包含状态、错误类别和准备动作，不依赖 UI 详情或 MCP 专用字段。

首用体验以真实 Pi/LLM 任务独立验收：累计五分钟、最多两次机会内，提供实际手机观察和低风险结果。
授权与下载许可由本人处理，但普通配置查找不逐项追问。单元测试或手工预启动服务不能替代此验收。
当前 Pi 准备流程尚未通过这个验收：宿主没有可跟踪的后台执行机制时，现有前台 Appium
启动脚本不能独自完成自动准备。人工另开终端只是诊断兜底，不算首用成功。

## 工具与运行时

| 工具                                                                 | 用途                             |
| -------------------------------------------------------------------- | -------------------------------- |
| `list_platforms`、`select_platform`                                  | 查看并选择 Adapter               |
| `list_devices`、`find_applications`、`configure_session`             | 发现设备/App，提供连接提示       |
| `check_platform_setup`、`get_setup_diagnostics`                      | 准备条件诊断                     |
| `open_setup_step`、`retry_setup_step`、`continue_without_capability` | 准备指引、授权复查和可选能力选择 |
| `check_device_ready`                                                 | 检查当前 Android 通道并返回观察  |
| `configure_browser`、`get_browser_config`                            | Web 配置                         |
| `exe_js`                                                             | 在当前持久 UI Session 执行代码   |

Web 暴露 Playwright `page/context/browser`，原生平台暴露 WebdriverIO `driver/browser`。
通过 `list_platforms` 查看具体 globals。文字使用 `console.log`，`display` 接受
PNG/JPEG/WebP 图片字节或 image data URL。原生 `evidence.screenshot()` 只是截图观察辅助，
不是正式 Evidence 存储或报告系统。

Appium 提示保存在源码之外。宿主管理服务启动，Maat 清理自己创建的 Session。
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
