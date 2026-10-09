# Maat Setup Assistant 产品设计

## 产品目标

用户只需要说“测试 macOS 应用”，无需理解 Appium、Mac2、XCTest、WDA、TCC 或进程路径。Maat 自动检测能力，用人话说明已经能做什么，只给一个推荐下一步，并在用户完成系统授权后恢复当前 Case。

## 用户旅程

1. 选择 macOS 时自动执行只读检测。
2. Maat 用 `完全可用`、`部分可用`、`需要设置` 表达结果。
3. `/maat-setup` 展示唯一推荐动作，用户确认后可打开对应系统设置页。
4. 用户完成授权，再次运行 `/maat-setup`。
5. 如果同一个 Appium/WDA 进程仍持有旧权限状态，Maat 提示重启 Appium，而不是反复打开设置。
6. 当前 Draft、成功步骤和测试目标均保留，从中断位置继续。

只有重新检测返回 `MACOS_SCREEN_CAPTURE_RESTART_REQUIRED` 时才需要重启 Appium。仅在安装或升级了 Pi Extension 时才需要重启 Pi；单独修改屏幕录制权限通常不需要。Maat 不会自动执行任何重启。

## 状态机

```text
unknown → checking → action-required → waiting-for-recheck
                                  ↘ partially-ready → ready
```

能力包括 Appium、Mac2、Automation Mode、辅助功能、UI 操作、截图、视频和完全磁盘访问。Appium/WDA PID 变化时，旧的“暂时跳过”选择自动失效并重新检测。

## 文案规范

默认面板只显示能力和一个下一步，不显示 WDA、TCC、capability、原始 WebDriver 错误或进程路径。`/maat-doctor` 才向工程师展示脱敏技术详情、命令、PID 和路径。用户 prompt、页面文本、图片 payload、token、credential 与截图必须省略或脱敏。

Pi 根据最近一条用户消息选择 Setup 文案语言；`/maat-setup en` 与 `/maat-setup zh-CN` 可显式覆盖。无法判断时依次使用系统语言和英文。Core 只返回稳定消息键，不包含任何 Host 语言文案。

## 能力降级

截图或视频不可用时，应用操作和业务断言仍可继续。Evidence 状态为：

- `captured`
- `unavailable`
- `required-but-missing`
- `skipped-by-user`

明确要求截图的 Case 不允许跳过截图，且未捕获截图时校验失败。可选截图失败不能推翻已成功的业务断言。

## 错误码

- `APPIUM_SERVER_UNAVAILABLE`
- `MAC2_DRIVER_MISSING`
- `AUTOMATION_MODE_AUTH_REQUIRED`
- `MACOS_ACCESSIBILITY_PERMISSION_REQUIRED`
- `MACOS_SCREEN_CAPTURE_PERMISSION_REQUIRED`
- `MACOS_SCREEN_CAPTURE_RESTART_REQUIRED`
- `MACOS_FULL_DISK_ACCESS_REQUIRED`
- `FFMPEG_MISSING`

## 安全边界

检测严格只读。Maat 可以打开系统设置，但不会自行授予权限、运行 `tccutil reset`、杀进程、重启服务、安装软件或修改安全设置。此类操作必须由用户明确确认。

## Host 接入

Host Package 调用 `maat-core` Setup API，并渲染同一个 `SetupSnapshot`。对话框、按钮、通知和打开系统页面属于 Host。Core 不导入任何 Host SDK。未来 Codex、Claude Code、DeepSeek Host 应保持相同的状态、能力、动作和安全契约。
