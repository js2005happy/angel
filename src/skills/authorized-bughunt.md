---
name: authorized-bughunt
description: 只测授权目标的漏洞挖掘：范围卡先行、证伪验证、提交前七问、证据卫生
when: 用户要测一个已授权的目标（SRC / Bug Bounty / 自测靶场），或要提交一份漏洞报告前
keywords: 漏洞挖掘, bug bounty, SRC, 授权测试, 范围卡, 证伪, 提交前七问, 证据卫生, Intigriti, HackerOne
allowed-tools: web_fetch, shell, write_file, read_file
---

# 授权漏洞挖掘

只测授权目标。没有范围卡，不开始；没过证伪，不提交；没过七问，不写报告。

## 红线（缺一不可，平台规则高于本技能）

- 只测授权目标：目标必须在范围卡里，范围卡过期或目标不在卡内，停手。
- 禁批量扫描：一次只测一个点，低速单点，不扫全站、不跑自动扫描器。
- 禁自动提交：报告永远由人提交，Nyra 只做提交前核对，不代提交。
- 禁凭据攻击：不爆破、不撞库、不盗用他人凭证，只用平台发的测试账号。
- 禁社工钓鱼与针对真人的信息收集：不钓人、不查真人隐私。
- 平台规则高于本技能：平台说不收的、禁的手法，技能里没写也照样禁。

## 第一步：范围卡

接任务先建范围卡，再动手。范围卡字段：

- `name`：范围卡名（字母、数字、`-`、`_`）。
- `platform`：平台名，如 `Intigriti`、`HackerOne`、`自测靶场`。
- `targets`：允许测的目标（主机名或 URL，如 `ticket.example.com`、`https://ticket.example.com`；裸主机名只匹配它自己，不含子域名，子域名要写 `*.example.com`）。
- `forbidden`：禁区（主机名或路径前缀，命中即越界，禁区优先于目标）。
- `allowed_techniques`：允许的手法；`forbidden_techniques`：禁用的手法，必须包含五条红线手法（批量扫描、自动提交、凭据攻击、社工钓鱼、针对真人的信息收集），少一条范围卡就是无效卡。
- `max_requests_per_second`：速率上限（0 到 10 之间；平台有更低的数以平台为准，如 CM.com 是 2）。
- `account`（可选）：测试账号；`expires_at`（可选）：授权到期日，过期即停手。

命令：`nyra bughunt scope add <范围卡.json>`（先 `nyra bughunt template scope` 取模板）、`nyra bughunt scope check <URL> [--scope <名>]`（动手前先查目标在不在范围内）。

## 测试流程

1. 查范围：每次动手前先 `scope check`，越界直接拒绝，不抱侥幸。
2. 单点低速：一次一个假设，一个请求看一次结果，不超过范围卡的速率上限。
3. 每步留证据：请求与响应原文（脱敏后）、时间、用的账号，记下来；记不住的发现等于没有发现。
4. 先定影响再定严重度：影响是“攻击者能干什么”，不是“这个接口看起来不对”。
5. 发现先过证伪，再过七问，两道门都过才写报告；报告写完先过 `nyra bughunt check`，再由人提交。

## 证伪验证（学 src-hunter 的 falsify.py，三态结论）

每个发现都要交给“反方”推翻一次：用不同输入重新探测，目标是证伪，不是证实。

- `independent-reproduction`：独立复现——换一个会话/账号，按同样步骤重走一遍。
- `different-input`：换一个输入——换一个变异值（如另一个篡改价、另一个用户 id），看效果还在不在。
- `cross-user`：换一个用户——另一个测试账号做同样操作，看是不是权限真的没隔离。
- `negative-control`：阴性对照——正常输入必须给出正常结果；正常输入也不对，说明测错了地方。
- `header-check`：响应头检查——CSP、X-XSS-Protection 这类头如果拦住了执行，执行类的结论就不成立。
- `browser-execution`：浏览器执行——反射型发现（XSS 这类）只看回显不算数，脚本在浏览器里真的跑起来才是决定性事实；没条件观察时结论只能是 pending，不能升 confirmed。

三态结论（只有这三种）：

- `confirmed`：每次证伪尝试都没能推翻，且没有缺失的决定性事实。
- `pending`：没被推翻，但有一个确切的决定性事实还没解决（记成 blocker，附上具体的验证计划）；pending 不是放 speculative 想法的地方。
- `rejected`：某次尝试主动推翻了发现，或核心要求（在范围内、可复现）不成立。

未证伪的发现不许提交：证伪结论不是 confirmed，`nyra bughunt check` 直接拦截。

## 提交前七问

写报告前逐项核对，七问全是“是”才能提交；有一项“否”或“不知道”就停下：

1. 目标在授权范围内吗（范围卡已建、目标在卡内、范围卡未过期）？
2. 在平台接受的影响清单上吗（影响真实、平台收这类报告）？
3. 已验证吗（可复现 PoC，别人按步骤能重现）？
4. 已过证伪吗（证伪结论是 confirmed，不是 pending/rejected）？
5. 已脱敏吗（报告里无真实 PII、凭证、token）？
6. 无越界行为吗（测试中没碰禁区、没超速率、没用禁用的手法）？
7. 人工复核过了吗（提交前真人看过报告全文）？

## 证据卫生

报告提交前先脱敏，再检查必填段：

- 脱敏：删真实邮箱、手机号、身份证号、明文密码、API 密钥、Bearer token、私钥、会话 Cookie、真实用户数据；截图里的人名、头像、内部域名一并处理；脱敏要记一笔（脱了什么、用什么替换的），不记等于没脱。
- 必填段（缺一段就不完整）：目标、复现步骤、影响、严重度、证伪结论。
- 严重度按 VRT 映射表先定一档，最终以平台的 VRT 为准；映射表里没有的类别不要自己编档位，写“未映射、由平台定”。

VRT 严重度映射（Nyra 本地简化表，仅作初定）：rce / sqli / auth-bypass → critical；idor / xss-stored / ssrf / price-tampering / business-logic / path-traversal → high；xss-reflected / csrf / info-disclosure / session-fixation → medium；open-redirect / rate-limit-bypass → low。

## 报告模板

```markdown
# <漏洞标题>

- 目标：<URL>
- 范围卡：<范围卡名>（平台：<平台>）
- 漏洞类别：<类别>（VRT 映射严重度：<档位>）
- 证伪结论：confirmed（尝试：<列出每种尝试与结果>）

## 复现步骤

1. <用测试账号做的第一步>
2. <第二步>
3. <看到的效果>

## 影响

<攻击者能干什么、影响谁、为什么平台会收>

## 证据

<脱敏后的请求与响应、截图说明>

## 脱敏记录

<脱了什么、用什么替换的>
```

## 范围卡模板

```json
{
  "name": "cm-com",
  "platform": "Intigriti",
  "targets": ["ticket.example.com"],
  "forbidden": ["admin.example.com", "/admin"],
  "allowed_techniques": ["手动单点测试", "低速复现"],
  "forbidden_techniques": ["批量扫描", "自动提交", "凭据攻击", "社工钓鱼", "针对真人的信息收集"],
  "max_requests_per_second": 2,
  "account": "tester@intigriti.me"
}
```

## 发现模板

```json
{
  "scope": "cm-com",
  "target": "https://ticket.example.com/order/123",
  "vuln_class": "price-tampering",
  "severity": "high",
  "falsification": {
    "attempts": [
      {"check": "independent-reproduction", "outcome": "survived", "detail": "换账号重走一遍，效果复现"},
      {"check": "different-input", "outcome": "survived", "detail": "换一个篡改价 0，同样被接受"},
      {"check": "negative-control", "outcome": "survived", "detail": "正常价 99 仍返回正常总价"}
    ]
  },
  "seven": {"q1": "yes", "q2": "yes", "q3": "yes", "q4": "yes", "q5": "yes", "q6": "yes", "q7": "yes"},
  "report_text": "报告全文（或用 --report 传文件）"
}
```

## 提交前自查

```sh
nyra bughunt install                 # 安装本技能包到 ~/.nyra/skills/
nyra bughunt scope add scope.json    # 建范围卡（先 template scope 取模板）
nyra bughunt check --finding finding.json --report report.md
```

`check` 按顺序过五道门：范围 → 证伪 → 七问 → 证据卫生 → 严重度；有一道不过就拦截（退出码 3），并写明哪道门、为什么。审查层开启时，最后再过一遍独立审查（把“提交漏洞报告”当敏感动作审，拿不准就拦截；审查失败即拦截）。每道门的结论与审查结论都写进 `~/.nyra/bughunt-audit.jsonl`（只记范围卡名、目标主机名、结论与失败的门，不记完整 URL、不记报告原文）。
