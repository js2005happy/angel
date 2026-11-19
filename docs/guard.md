# 守门：`nyra guard`

> verdict 回答「值不值」，guard 回答「**能不能过**」——把判断变成退出码，交给钩子与 CI。

## 用法

```bash
nyra guard                    # 只看 red（yellow 放行）
nyra guard --strict           # yellow 也拦（"红线没设齐就别上"）
nyra guard --run abc123        # 给单次运行守门
nyra guard --recent 10 --strict
```

输出只有一行（钩子里不该刷屏）：

```text
⛔ guard 拦截：red —— 2 条红线被踩：cost-limit-missing、deny-rules-empty
```

## 退出码

| grade | 默认 | `--strict` |
|---|---|---|
| green | 0 | 0 |
| yellow | 0 | **2** |
| red | **2** | **2** |

## 挂成 pre-push 钩子

```bash
# .git/hooks/pre-push
#!/bin/sh
nyra guard --strict || {
  echo "红线没过，先跑 nyra redlines 看修法" >&2
  exit 1
}
```

## 一条设计纪律

**guard 不另写判断**：它复用 verdict 的 grade，只做「等级 → 退出码」的映射。
这样「人看的报告」与「机器看的门禁」永远同源——不会出现"报告说红、门禁放行"这种鬼故事。