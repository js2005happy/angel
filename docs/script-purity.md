# 脚本内容判定 + 摘要预授权

借 Pi Bot 的做法（脚本先看内容再决定要不要问人；例行任务里的脚本按内容摘要预授权），不抄它的 API 形状与文案，不接 pi 当内核。Nyra 比它多做一步：纯度判定结果也写进证据链与审计，审计里能看到“这次没问是因为脚本是纯的、摘要是多少”。

## 纯度判定：白名单静态分析

纯的脚本按只读命令处理，不用每次都问。判定只认四种语言，代码超 64 KB 直接判不纯：

| 语言 | 纯的条件 |
| --- | --- |
| Python | 只用白名单模块（json、math、re、datetime、urllib.parse 等 19 个）与受限成员（`sys.argv` 等）；`open`、`eval`、`exec`、危险模块（os、subprocess、socket 等）、别名导入、双下划线属性、帧属性一律不纯 |
| JavaScript | 只用白名单全局变量（console、JSON、Math 等）与已知成员；`require`、`eval`、`Function`、`process`、`fetch`、算出来的访问（`x[y]`）、歧义的 `/`（正则与除法分不清时）一律不纯 |
| Lua | 只用封闭的全局集合与受限成员（`io.write`、`os.time` 等）；`loadstring`、`dofile`、`io.open`、`os.execute` 一律不纯 |
| PHP | 只用白名单函数（str_replace、json_encode 等）与顶层声明的函数；`eval`、`include`、超全局变量（`$_GET` 等）、动态调用（`$f()`）、`new`、`::` 一律不纯 |

Ruby、Perl、PowerShell 直接判不纯（没写判定器）。

判定是保守的：任何看不懂的都判不纯——字符串外的转义、歧义的 `/`、算出来的成员、能碰文件/进程/网络的构造、NFKC 折叠后才露出来的危险词（如全角 `exec`）、不是 utf-8 的编码声明、zip 结束标记。**静态白名单不是沙箱**：它只能挡住“代码长这样”，挡不住运行时才出现的东西（比如纯脚本读了别人刚改过的文件内容、纯脚本调的函数内部做了坏事）。纯脚本仍在工作目录里跑，仍受 shell 审批的硬边界管（禁 rm、禁 dd、禁改密码等）。

## 摘要预授权：`script:<摘要>`

例行任务（工作流）可以预授权一份确定内容的脚本：

- 摘要是脚本原文的 SHA-256，记成 `script:<64 位 hex>`，按（例行，步骤）一条授权。
- 摘要对上号（同一例行、这一步、同一份内容）才走快路径；内容改了，授权自动失效——运行时直接拒绝，不悄悄跑改过的脚本。想跑新内容，重新 trial + activate 钉一次。
- 授权只在例行任务里有效，绝不会变成聊天里的“记住批准”：聊天/单次运行没有例行上下文，快路径永远不生效，shell 审批行为与以前完全一致。

账本 `~/.nyra/script-preauth.json`（原子写 0600，损坏先备份再抛错）与信任阶梯账本同款；审计 `~/.nyra/script-preauth-audit.jsonl`（append-only 0600，写失败返回 null 不拦运行），kind 为 granted / revoked / used / refused，SIEM 导出第 9 个来源。

## 接进工作流 DSL 与两道门

步骤里的脚本先过纯度判定，纯的走快路径；定时任务里的脚本按摘要钉死，改了就重新问。trial / activate 的既有流程不变，摘要预授权是补上“脚本内容”这一层：

- 钉摘要只钉“纯脚本 + 不含模板变量 + 没指定 cwd”的步骤（定义文本里的步骤；协调者运行中现生成的步骤不钉）。激活时自动钉一次；已激活的老工作流用 `nyra script preauth grant` 补钉（要求工作流已 active）；删工作流时一并撤销其预授权。
- 运行时三态：摘要对上号 → allow（预授权快路径，记 `script_preauth_used` 事件 + 审计 used）；这一步钉过摘要但内容变了 → refuse（直接抛错，fail-closed，记审计 refused）；这一步没钉摘要 → allow（记 `script_pure` 事件，激活审批兜底）。
- 判定只对“恰好一条解释器跑一个脚本”生效：管道、拼接、重定向、通配符、看不懂的 flag、引号未闭合一律不认；文件脚本须在工作目录内。

2 个新运行事件已注册进 EVENT_FIELDS：`script_pure`（language / digest / pure / reason）与 `script_preauth_used`（language / digest / step）。摘要只显前 12 位（时间线渲染），完整摘要在事件里（`digest` 字段免脱敏，否则会被当疑似密钥掩掉）。

## CLI

```sh
nyra script check <文件> [--language python|javascript|lua|php]
    # 判定一个脚本纯不纯：纯返回 0，不纯返回 1；语言不写时按扩展名认
nyra script preauth list [--workflow <名字>]
    # 列出脚本预授权（哪个例行、哪一步、哪门语言、哪个摘要、什么时候授的）
nyra script preauth grant --workflow <名字> --yes
    # 给已激活的工作流补钉纯脚本摘要（激活时已自动钉过一次）
nyra script preauth revoke --workflow <名字> [--digest <摘要>] --yes
    # 撤销一例行的全部预授权，或只撤某一条摘要
```

`grant` / `revoke` 是授权动作，须加 `--yes` 确认。

## 诚实边界

- 静态白名单不是沙箱：只看代码文本，不看运行时行为；纯脚本仍受 shell 审批硬边界管。
- 判定只在例行/工作流里生效；调度器提示词任务没有确定性的脚本内容可钉，不在本批范围。
- 真 API 未跑通，只在假 provider 与本地静态判定上验过；Windows/macOS 真机未验证。
- 审计写盘失败返回 null 不拦运行——极端情况下一次预授权使用可能只留运行事件、没留审计行。
