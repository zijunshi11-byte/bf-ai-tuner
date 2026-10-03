# docs/CODEX.md — 用 Codex 接手本项目

面向操作者的 Codex 配置与工作流说明。项目背景见 [AGENTS.md](../AGENTS.md)（环境/协议陷阱）与
[HANDOFF.md](../HANDOFF.md)（当前状态与未完成项）。

---

## 0. 本机 Codex 事实

| 项 | 值 |
|---|---|
| CLI 路径 | `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` |
| 版本 | `codex-cli 0.159.0-alpha.12.1` |
| shell 别名 | `~/.zshrc` 中 `alias codex=...`（该路径不在 PATH 上） |
| `CODEX_HOME` | `~/.codex` |
| provider | **custom，不是 OpenAI** |
| model | `deepseek-flash` |
| base_url | `https://api.deepseek.com`（`wire_api = "responses"`） |
| 沙箱 | `workspace-write` + 受控网络（见 §3） |
| 审批 | `on-request` |

**它不是 OpenAI 模型。** 当文档或回答提到 "OpenAI"、"gpt-*"、"o3/o4" 时，那是 Codex CLI 的通用措辞，
本机实际请求走 `api.deepseek.com` 的 `deepseek-flash`。不要按 OpenAI 的模型能力或配额来预期行为，
也不要在排查时去查 OpenAI 侧配置。自定义 provider 的凭据在 `~/.codex/config.toml` 的
`[model_providers.custom]` 段。

非交互 shell（脚本、CI）里别名不生效，用完整路径，或自行把该目录加进 `PATH`。

---

## 1. 三种启动方式

### 1.1 桌面 App
```bash
codex app          # 打开 ChatGPT 桌面 App（缺安装器时会提示安装）
```
或直接开 ChatGPT.app。适合长时间交互、看 diff、跑 review。

### 1.2 在仓库里起交互式会话（推荐日常用这个）
```bash
cd /Users/Admin/Documents/deepseek-harness/default-workspace/bf-ai-tuner
codex
```
Codex 以仓库为工作根，会**自动读取 `AGENTS.md`**，因此环境陷阱与安全不变量无需再交代。

### 1.3 非交互一次性任务
```bash
codex exec "读 HANDOFF.md，列出当前未实现项，不要修改任何文件"
codex exec -s read-only -C "$PWD" "..."     # 显式只读，最安全
```
常用附加参数：
- `-s read-only|workspace-write|danger-full-access` — 本次运行的沙箱策略
- `-C <DIR>` — 工作根目录
- `--add-dir <DIR>` — 额外可写目录（本项目不需要，见 §3）
- `--json` — 结构化事件输出，便于脚本解析
- `--ephemeral` — 不落盘会话记录

### 1.4 `codex review` — 代码审查
```bash
codex review                        # 对当前仓库出审查意见（顶层命令）
codex exec review "只审查 src/main/safety/ 的改动"
```
用途：在合并前做一次独立的对抗性审查。**它只出意见、不改代码**，正好用于本项目的
「先审 diff 再跑验证三连」环节。

### 1.5 `codex agents` — 浏览本机所有会话
```bash
codex agents
```
列出共享本地 app-server 守护进程上的全部 agent 会话（含桌面 App 起的会话）。用途：找回之前
某次会话、确认某个任务是否还在跑、避免重复开同一份工作。

相关：`codex resume --last` 续接最近会话；`codex queue` 给已有会话排队消息；
`codex apply` 把 agent 产出的最新 diff 以 `git apply` 打到工作区。

---

## 2. 首轮验证指令（先不改代码）

新会话第一件事：确认它真的读到了上下文并且理解了红线。**粘贴这段，不要让它写代码：**

```
先不要修改任何文件。

1. 读 AGENTS.md 和 HANDOFF.md。
2. 复述你理解的安全不变量（全部条目），以及 AGENTS.md 里列出的环境陷阱。
3. 复述本项目的验证三连命令，以及 macOS 构建为什么必须 out-of-tree。
4. 说出 HANDOFF.md 里那处悬而未决的规则冲突是什么。
5. 什么都不改，等我的下一步指令。
```

预期：它应准确复述 8 条安全不变量、环境陷阱、`npm run lint:syntax && npm test && bash scripts/build-mac.sh`，
并指出「30 秒强制要求」的冲突。若它复述不出或开始改文件，**停下**——说明工作根或只读策略不对。

已在 2026-10-03 用 `codex exec -s read-only` 跑过等价的只读冒烟测试，结果：正确复述 8 条不变量与
环境陷阱，`git status` 仍为 0 改动（详见 §6）。

---

## 3. 沙箱配置与 out-of-tree 构建的摩擦

### 3.1 改了什么

`~/.codex/config.toml` 增加（改动前的副本备份为 `config.toml.bak-<时间戳>`）：

```toml
# 顶层，必须出现在任何 [table] 之前
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[sandbox_workspace_write]
network_access = true
```

### 3.2 为什么只有这两项

**摩擦点一：`bash scripts/build-mac.sh` 把 staging 写到 `$TMPDIR`（仓库之外）。**

实测结论：**不需要加 `writable_roots`。** 用 `codex sandbox` 逐项验证：

| 写入目标 | `workspace-write` 下 |
|---|---|
| 仓库内 | ✅ 允许 |
| `$TMPDIR`（`/var/folders/…/T/`） | ✅ 允许 |
| `/private/var/folders/…`（realpath） | ✅ 允许 |
| `/tmp` | ✅ 允许 |

`workspace-write` 默认就把 `$TMPDIR` 与 `/tmp` 视为可写，且 `/var` → `/private/var` 的符号链接
两侧都覆盖到了。所以**多加 `writable_roots` 是多余的授权**，故未加。

**摩擦点二：`npm install` / `npm rebuild` 需要网络。**

原生模块 `@serialport/bindings-cpp` 要按 Electron ABI 重建，Node 侧依赖安装也要联网，因此
`sandbox_workspace_write.network_access = true`。

### 3.3 重要：完整构建**无法**在沙箱内完成（已实测）

座舱（seatbelt）沙箱不仅限制文件与网络，还限制**系统级能力**。实测 `bash scripts/build-mac.sh`
在沙箱内会走到打包之后失败：

| 步骤 | 沙箱内结果 |
|---|---|
| `npm run lint:syntax` | ✅ 通过 |
| `npm test` | ✅ 168/168 通过 |
| `electron-builder` 打包出 `.app` | ✅ 成功（写入 `$TMPDIR` 无问题） |
| `codesign` ad-hoc 签名 | ❌ 失败 → 产出**未签名**、在 Apple Silicon 上无法启动的包 |
| `hdiutil create`（生成 dmg） | ❌ `hdiutil: create failed - 设备未配置` |

`hdiutil help` 能执行、但任何 `create` 都失败；换 `-fs HFS+`、去掉 `-fs`、加
`sandbox_permissions=["disk-full-read-access"]` 均无效。`--log-denials` 显示被拦的是
`mach-lookup`（`com.apple.logd`、`com.apple.system.notification_center` 等）与 `sysctl-read`，
即**磁盘设备与签名所需的系统服务访问**。

**这不是文件权限问题，加任何 `writable_roots` 都不能解决。**

### 3.4 因此怎么跑构建

三种可行方式，按推荐顺序：

1. **交互式会话里让 Codex 申请提权（推荐）。** `approval_policy = "on-request"` 就是为此设计的：
   沙箱内命令失败后 Codex 会请求批准该条命令，批准后以完整权限执行，**默认沙箱保持收紧**。
   只需要为构建这一步批准，其余时间仍受沙箱约束。
2. **构建放到普通终端里跑**，Codex 只负责改代码和跑 `lint` + `test`。产出最终交付物时我建议用这种。
3. **`codex exec -s danger-full-access ...`**：能跑通，但**放弃了全部沙箱保护**。
   仅在明确接受该风险时使用，不要作为默认。

另外 `npm run build:mac:dir` 可在沙箱内跑完并产出 `.app`，但**签名同样失败**，产物无法启动，
只能用于验证「打包是否成功」，不能用于产出可运行 App。

### 3.5 授权范围（刻意保持最小）

- 只开到 `workspace-write`，**没有**用 `danger-full-access`，也**没有**用
  `--dangerously-bypass-approvals-and-sandbox` 作为默认。
- 没有加任何 `writable_roots` —— 实测不需要。
- 网络只在 workspace-write 沙箱内放开，用于依赖安装/重建。
- 审批保持 `on-request`，构建提权按次批准。

若希望默认更严：把 `network_access` 改回 `false`，仅在装依赖时临时覆盖：

```bash
codex exec -c 'sandbox_workspace_write.network_access=true' "..."
```

### 3.6 两个已知配置问题（未擅自改动）

1. **`disable_response_storage` 是当前版本不认识的字段。** 它在 `config.toml` 第 4 行，属于本次改动
   之前就有的历史遗留。正常运行时被忽略，但 `--strict-config` 会让 CLI 直接报错退出：
   `unknown configuration field 'disable_response_storage'`。**所以不要给 Codex 加 `--strict-config`**，
   否则任何运行都起不来。要清理由人决定。
2. **`[model_providers.custom]` 里有一个明文 bearer token。** `~/.codex/config.toml` 不可入库、
   不可外发；复制粘贴时注意。本仓库的 `.gitignore` 管不到它（它在仓库之外）。

## 4. 工作流纪律

按顺序执行，任一步不过就停：

1. **先开分支。** 不要在默认分支上直接改。
   ```bash
   git switch -c fix/<短描述>
   ```
2. **限定文件范围与验收标准。** 给 Codex 的任务要说清：改哪几个文件、不准碰哪些、做完怎么算通过。
   例：「只改 `src/main/analysis/ai-tune.js` 与 `test/core.test.js`；不动 `src/renderer/`；验收 =
   新增一个回归测试且 `npm test` 全绿。」
3. **审查 `git diff`。** 逐块看，不要只看摘要。可疑处用 `codex review` 再要一份独立意见。
4. **跑验证三连。**
   ```bash
   npm run lint:syntax && npm test && bash scripts/build-mac.sh
   ```
   基线：**168/168 通过**，构建 exit 0 且签名校验 VALID。
5. **通过才合并。** 合并后删分支；不通过就把失败输出原样贴回去让它修，别自己绕过。

补充红线（与 AGENTS.md §4 一致，Codex 也读得到）：
不得弱化安全不变量；不得给 `build.files` 加否定式；不得把构建产物拷回仓库；
不得提交 `node_modules/` 或 `dist/`；不得在 MSC 模式下写参。

---

## 5. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `zsh: command not found: codex` | 非交互 shell 不加载 `~/.zshrc`；用完整路径或 `source ~/.zshrc` |
| 改文件时报 permission denied | 当前是 `read-only`；交互式用 `-s workspace-write`，或确认 `config.toml` 的 `sandbox_mode` |
| `npm install` 报网络错误 | `network_access` 被关掉了；按 §3.3 临时覆盖 |
| 构建 codesign 报 resource fork | 没走 `scripts/build-mac.sh`，或把 `.app` 拷回了仓库 |
| 沙箱内构建卡在 `hdiutil` / 签名失败 | 座舱沙箱不允许磁盘设备与签名服务，见 §3.3；按 §3.4 提权或换终端 |
| `--strict-config` 直接退出 | 见 §3.4 第 1 条，不要用该标志 |

---

## 6. 只读冒烟测试记录

2026-10-03，在仓库根执行：

```bash
codex exec -s read-only -C "$PWD" \
  "读 AGENTS.md，复述你理解的安全不变量和三个环境陷阱，不要修改任何文件"
```

结果：
- 读到仓库并读完 `AGENTS.md`；
- 逐条准确复述 **8 条安全不变量**（含 force-trust 不解锁写参、MSC 拒绝写参、恢复仅限 `diff all` 等）；
- 准确复述三个环境陷阱（`ELECTRON_RUN_AS_NODE`、out-of-tree 构建、`build.files` 否定式），
  并正确指出 AGENTS.md §2 实际列了 7 条；
- **未修改任何文件**：测试前后 `git status --short` 均为 0 改动，HEAD 仍为 `518fc10`；
- 用量 18,092 tokens。
