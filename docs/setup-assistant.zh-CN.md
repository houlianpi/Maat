# Maat Setup Assistant

## 目标与分工

用户要操作手机，而不是管理自动化基础设施。宿主 Coding Agent 在授权范围内主动准备，
只有确实需要本人操作才交给用户。Core 返回可靠事实，包内 `maat-setup` Skill 指导 Android 与本地物理 iPhone 流程。

- **Doctor**：检查已有条件，区分缺项与检查失败。
- **Setup**：Agent 使用已有工具复用、安装、配置和启动，只处理实际缺项并跟踪已有工作。
- **Ready**：确认当前 Android/iPhone Session、控件树和视口，按需返回截图。

通道就绪不代表 App 已登录或业务任务成功。没有 Case 草稿、模式切换、正式验证状态或报告。

## 用户流程

1. 选择平台和目标设备。
2. 检查已有环境，不为每个动作重复全量诊断或安装。
3. Agent 用宿主工具处理实际缺项。
4. USB 授权、解锁或认证需要用户时，等待本人实际完成。
5. 重新检查通道，复用新观察，继续原任务。

`/maat-setup` 是唯一用户命令；`/maat-setup ios` 选择 iPhone 流程。Agent 调用
`get_setup_diagnostics` 获取脱敏技术详情、`retry_setup_step` 复查，TUI 展示平台与准备状态。
正在启动就查询同一个 `prepare_mobile` taskId；超时不代表应该重新启动，
更不能重放原手机动作。

## Pi 持有的本地准备任务

`prepare_mobile({action:"status"|"start-appium"|"build-ios-wda",taskId?,waitSeconds?,
signingAuthorized?})` 仅提供 Pi extension/standalone TUI 的窄准备能力，不是通用 shell
调度器。自然任务或 `/maat-setup` 共用流程；通道健康直接继续，不额外设置“开始准备”关卡。
`status` 只读。`start-appium` 保留健康用户服务，否则在精确 loopback endpoint 启动一个
owned foreground child；复用 CLI resolver（Windows 用当前 Node）及 Android tools environment。
不 fallback，不杀占端口进程。spawn 不算成功，须 owned listener 确认及 HTTP `/status`。
content 展示 taskId/state/summary/error/category，不包含 PID、原始日志、签名身份或路径。

单次等待 0–20 秒后查询原 taskId；Appium 总期限 60 秒，WDA 工作 180 秒。
`running` 不是成功；Appium `ready` 仅为 `serviceResponding`，不是 deviceReady。
进程失败不会被后来的 HTTP 响应覆盖。Pi bash 没有 tracked-background API，不依赖
`nohup`、`&` 或另开终端。关闭先清 owned Sessions，再有界/idempotent 尝试清 owned child tree；
不停止用户 Appium，清理失败可见并保留原错误。
复用须验证 Appium ready message 与支持的 `value.build.version`，不能只接受通用
WebDriver `ready:true`；owned listener 日志必须匹配所选 host/port。
POSIX 创建 owned process group，保留 handle/stdio、不 unref；root 退出不能取消
TERM/KILL 升级。Windows 无法证明残留清理时明确 cleanupError。
abort 后保留实际 work promise，独立等待三秒 cleanup grace；迟到清理失败或未 settle
均可见，不覆盖原 cancellation/timeout。

iOS 在无已有 Appium task 时 `status` 检查 WDA，`build-ios-wda` 总是先 inspect。
Core 返回真实 profile 日期/设备匹配及独立 certificate 有效期；付费/免费一视同仁，不默认七天。
valid build 无需签名授权即可复用；missing/expired 须本人明确授权，保留现有 Team/bundle。
工具只构建，不挑账号、不换 Team、不删 App、不购买、不部署；内部 caps 仅在原 adapter/
device/hints 未变化时应用。后续 XCTest 部署/初始化须在明确授权范围；首次控制、签名、
可能点亮只合并必要说明确认，不把内部 flags 抛给用户，也不反复确认。

## iOS 准备、初始化与验收

本地 Mac+物理 iPhone doctor 只读检查 Xcode、Appium CLI、XCUITest、连接/配对、
Developer Mode 与 Appium，不验证 WDA 签名。Pi command/retry/diagnostics 始终保持 iOS，
不误跳 macOS 设置，不提示 Android SDK 或读取项目源码修环境。

不能证明当前点亮/解锁状态时，cold readiness 默认以 `IOS_DEVICE_LOCK_STATE_UNKNOWN`
阻塞。CoreDevice `passcodeRequired:false`/`unlockedSinceBoot:true` 不是当前屏幕/解锁证明。
解释 WDA 初始化可能点亮/触发提示、获得本人明确授权后，才能本次调用
`check_device_ready({allowWdaInitialization:true})`。此参数不持久化，不授权修改签名，
也不是解锁证明；危险/已锁状态仍停止，须 live WDA 解锁及真实 source/viewport、
按需图片才能 ready。预算 iOS 180 秒、Android 15 秒；不声称普通 iOS/模拟器执行全面使用冷保护。

复用用户管理 Appium 与目标真机绑定 WDA，保留其他服务。`IOS_DEVICE_LOCKED` 需本人解锁；
`IOS_WDA_SECURITY_REJECTED` 可能涉及签名、权限或描述文件信任。只检查一次开发者 App
信任，已信任或没有入口则只读核查签名/有效期；续期/部署须另获授权，不索取 Apple 凭据、
不循环重装。等待本人操作后仍需手机时保留 Session，仅对话不再需要手机时 release。

验收分开：目标真机 doctor 已准备通过；Pi 接入有回归；经授权续签/部署后，
XCTest 初始化返回真机 UI，系统计算器 `3×3×8` 显示 `72`。直接预装启动仍遭拒绝，
成功路径复用已验证构建执行 `test-without-building`。本地 8100 实为其他模拟器，
不能算 iPhone 证据。脚本真机功能检查不是五分钟 Pi/LLM 自主首用通过；
Pi 已实现具体可跟踪 Appium 启动，并有受控 child/HTTP 回归覆盖；
这些测试不证明真实手机自主首用，提示词/人工预启动仍不能冒充该验收。

## Android 工具准备

用户不需要手动设置 SDK 环境变量。诊断动态查找已有 SDK、连接工具与 Maat 缓存；
Skill 内的 `scripts/android-tools.mjs` 通过宿主 Shell 执行明确的准备动作，只补实际缺项。
同一个 Pi 进程的下一次诊断就能看到缓存，不依赖子 Shell 的 `export`。
无效或冲突的继承 SDK 路径应被说明，但不能阻止使用已有的可验证工具。
诊断向模型提供明确状态、错误类别与下一步动作，不把检测失败当成缺少工具。
首次 `/maat-setup` 默认进入 Android，明确的平台选择不会被误导到 macOS。

下载 ADB 所属的官方 platform-tools 前，需要用户实际接受相关许可。已有 ADB 优先复用；
AAPT2 作为独立原生工具准备，不安装 Android Studio、完整 SDK 或 JDK，也不修改全局配置。

Pi 使用 `prepare_mobile(start-appium)`，只为 owned child 传入解析好的环境；
脚本保留作手动 foreground 诊断。已有服务不被重配或重启；
服务环境不一致时明确报错，由其所有者决定下一步。

## macOS 能力检查

选择 macOS 时检查 Appium、Mac2、自动化与辅助功能权限，以及可选截图/视频能力。
检测可能创建临时 Mac2 Session 并读取界面、截图，不只是依赖快检，也不执行业务点击。

经确认可打开对应系统设置。用户完成授权后复查；进程身份用于识别过期的跳过选择、
判断权限变更是否需要重启当前服务。Maat 不自动重启外部服务。

可选能力不可用或已跳过时明确展示，不把它说成已捕获。Agent 根据任务实际需要的能力决定
下一步；需要视觉观察却拿不到截图时，不能用猜测代替图片。

## 反馈与边界

只说眼前的情况和一个下一步，不给用户一套通用权限分类表。进程、路径和原始日志放在脱敏诊断中。
Core 返回稳定消息键，Pi 根据用户语言或显式覆盖使用中文/英文。

不索取密码或验证码。保留无关进程、配置、App 数据和登录。恢复连接不允许重放已可能执行的输入
或提交。截图和 UI 文本是观察，不是正式 Evidence 报告。
