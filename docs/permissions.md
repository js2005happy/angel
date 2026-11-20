# 权限规则语言：`Tool(specifier)`

> 一句话：`deny` > `ask` > `allow`，没命中规则就走默认审批。**空规则集 = 零影响**。

## 写在哪儿

`<home>/config.json` 的 `permissions` 一节（也可被 `config.enforced.permissions` 锁定，
锁定优先于本文件——见 [CONFIG-MAP.md](./CONFIG-MAP.md)）。

```json
{
  "permissions": {
    "deny":  ["Bash(rm -rf *)", "write_file(**/*.env)", "web_fetch(domain:pastebin.com)"],
    "ask":   ["Bash(git push *)"],
    "allow": ["Bash(git status)", "read_file(src/**)", "write_file(src/**)"]
  }
}
```

## 语法

```
ToolName                  # 裸工具名：命中该工具的全部调用
ToolName(specifier)       # 带目标：按目标匹配
mcp__server__*            # MCP 通配：命中该 server 的所有工具
```

工具名做**双向归一**：`Bash` / `sh` / `zsh` / `powershell` → `shell`；
`Edit` → `edit_file`；`Write` → `write_file`；`Read` → `read_file`。
所以 `Bash(rm *)` 与 `shell(rm *)` 等价。

## specifier 怎么匹配（按目标类型分三类）

| 目标类型 | 工具 | 匹配方式 |
|---|---|---|
| **Shell 命令** | `shell` | 命令通配（`rm *` 命中 `rm -rf x`）；先按 `&&`/`||`/`;`/`\|` 拆段，**每段都要命中**才生效 |
| **文件路径** | `read_file` `write_file` `edit_file` `apply_patch` `list_dir` `grep_search` | 路径 glob，相对 `workdir` 归一化后匹配 |
| **URL** | `web_fetch` `http_post` `browser_navigate` | `domain:example.com`（**域名后缀**，含子域）；或**裸主机名** `example.com`（同样后缀语义） |

其余工具（MCP 工具名等）按普通通配匹配。

## 三条容易踩的语义

1. **复合命令按段判定**：`allow: ["Bash(git *)"]` 不会放行 `git status && rm -rf /`
   —— 第二段没有任何规则命中，整串交回默认审批。这是防"用白名单夹带私货"的关键。
2. **`deny` 永远优先**：同一命令既有 `allow` 又有 `deny` 时按 `deny`；`ask` 次之。
3. **`specifier` 为空表示该工具全部调用**：`Bash()` 与 `Bash` 等价。

## 两处曾经的静默失效（已修，写在这里防止再犯）

| 现象 | 根因 | 修法 |
|---|---|---|
| `Bash(rm *)` **带 workdir 时永不命中** | `normalizeTarget()` 把命令当成文件路径去 `resolve()`，拼上 `process.cwd()` | 只对路径类工具做路径归一化（`PATH_TARGET_TOOLS`） |
| `web_fetch(example.com)` **永不命中** | 只认 `domain:` 前缀，裸主机名走普通通配比整串 URL | URL 类工具把不带 `/` `*` `?` 的 specifier 当域名后缀匹配 |

共同点：**规则写了但不生效，比没有规则更危险**——人以为自己配了。

## 相关命令

```bash
nyra redlines                 # 红线自检里会报告权限规则的缺失/冲突
nyra status                   # 诊断：被忽略的权限设置、永不匹配的 matcher
nyra permissions              # Poppy 站点授权意向（本地账本，只记录不授权）
```

## 规则体检：`nyra redlines` 会告诉你哪条规则永远不会命中

`lintRules()` 做四类**能确定**的检查（不猜语义）：

| code | 含义 | 后果 |
|---|---|---|
| `unknown-tool` | 工具名不在已知集合里 | **这条规则永远不会命中**（拼错了） |
| `domain-on-non-url-tool` | `domain:` 用在路径工具上 | 不会命中（该语法只对 URL 类工具生效） |
| `bare-host-on-path-tool` | `read_file(example.com)` 这种 | 会被当成相对路径文件名，不按域名匹配 |
| `empty-specifier` | `Bash()` | 与裸工具名等价（命中全部调用），提醒确认意图 |

`nyra redlines` 输出里的 `permission-rules-dead`（warn）/ `permission-rules-lint`（ok）
就是它的结论。**为什么值得有**：本仓库连续踩了两次「规则写了但不生效」，而这类问题
不跑就发现不了——现在配错会在红线自检里直接点名。