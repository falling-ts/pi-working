# pi-working

把 [pi](https://github.com/earendil-works/pi) 运行时的状态指示器**翻译为中文**（可切英文），
并细分出 pi 原生未区分的三个阶段：**请求中 / 响应中 / 执行中**。

## 状态机

| pi 的运行阶段 | 状态文案（中文，默认） | 状态文案（英文） |
| --- | --- | --- |
| 运行中，尚未归入具体阶段 | 工作中… | Working… |
| 已发出模型请求，尚未收到首个 token | **请求中…** | Requesting… |
| 已收到首个 token，正在流式生成 | **响应中…** | Responding… |
| 正在执行工具 / 命令等非模型工作 | **执行中…** | Executing… |

迁移顺序：

```
agent_start                 → 工作中
before_provider_request     → 请求中      ← 已请求模型
message_update(首个 token)  → 响应中      ← text/thinking/toolcall 的首个 delta
tool_execution_start        → 执行中      ← 调用工具、命令等非模型工作
before_provider_request     → 请求中      ← 工具结果回填后再次请求
agent_settled               → 清除
```

> 判断"首个 token"依据的是 pi 的 `AssistantMessageEvent`：`text_delta`、`thinking_delta`、
> `toolcall_start` 三者之一首次出现，即认为模型已开始响应。

## 安装

### 从 npm

```bash
pi install npm:@falling-ts/pi-working
```

### 从 git

```bash
pi install git:github.com/falling-ts/pi-working
```

### 软链接（本机开发）

```powershell
New-Item -ItemType SymbolicLink `
  -Path "$env:USERPROFILE\.pi\agent\extensions\pi-working" `
  -Target "D:\AI\pi-space\pi-working"
```

单次试用（不写入配置）：

```bash
pi -e npm:@falling-ts/pi-working
```

卸载：`pi remove npm:@falling-ts/pi-working`（或对应的 git 源）。

## 语言切换

环境变量 `PI_WORKING_LANG`：

| 值 | 行为 |
| --- | --- |
| 未设置 / 其它值 | **中文**（默认） |
| `en` | 英文 |

```powershell
$env:PI_WORKING_LANG="en"; pi     # 英文
Remove-Item Env:\PI_WORKING_LANG  # 恢复默认中文
```

```bash
PI_WORKING_LANG=en pi             # 英文
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `/working` | 显示当前语言与阶段 |
| `/working request` | 预览"请求中"（其余可选：`working` `respond` `execute` `clear`） |
| `/working clear` | 清除指示器 |

## 已知限制（上游硬编码）

pi 的部分状态文案**硬编码**在 TUI 组件里，扩展没有对应 API 可改。本扩展**只**改「工作指示器」
那一行（`ctx.ui.setWorkingMessage()`），影响范围如下：

| pi 的状态 | 能否改造 | 说明 |
| --- | --- | --- |
| `Working` | ✅ 可改 | 本扩展的主战场 |
| `Compacting context…` / `Auto-compacting…` / `Context overflow detected…` | ❌ 不可改 | `CompactionStatusIndicator` 硬编码；且其 `kind` 不是 `working`，`setWorkingMessage` 也影响不到它 |
| `Retrying (1/3) in 5s…` | ❌ 不可改 | `RetryStatusIndicator` 硬编码，且**扩展层没有暴露重试事件**，无法监听 |
| `Summarizing branch…` | ❌ 不可改 | `BranchSummaryStatusIndicator` 硬编码，同样无事件 |

**为什么不用 footer 兜底**：pi 内核自身**从不**往 footer 写文字（`setExtensionStatus` 在内核中只有扩展通道一处调用），
该通道专供扩展。用它补中文只会在屏幕最下方**多出一行**与工作指示器重复的内容，
而且**替换不掉** pi 自己的英文行 —— 净负面，因此本扩展刻意不介入压缩、重试、分支摘要。

此外：

- **RPC 模式**下 `setWorkingMessage` 是 no-op（上游注释：需要 TUI loader 访问权），本扩展仅在 TUI 模式生效。
- **print / JSON 模式**没有 UI，指示器自然不显示，但状态机逻辑照常运行（可用于 `/working` 排错）。

## pi 包规范

- `package.json` 用 `pi.extensions` 显式声明入口；
- 宿主包 `@earendil-works/pi-coding-agent` 只出现在 `peerDependencies`（`"*"`），**不得**放进 `dependencies`；
- `keywords` 含 `pi-package`，满足 [Pi 包画廊](https://pi.dev/packages) 收录条件。

发布为 **scoped 包** `@falling-ts/pi-working`，公开包需带 `publishConfig.access: "public"`。
发布命令（本机默认 registry 是淘宝镜像，必须显式指定 npmjs）：

```bash
npm publish --registry=https://registry.npmjs.org/
```

## License

[MIT](LICENSE)
