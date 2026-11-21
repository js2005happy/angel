# 单点引导 + 结构化输出契约（H-2 + H-4，缺口 13）

借 Hermes 子代理并行界面的做法，不抄 API 形状与键位。上一批
（H-1 + H-3）把花名册与单点停止落到注册表行与任务板任务上，但
“在跑的 delegate 子任务”还够不着：`isStopRequested` 钩子留好了、
delegate 调用点也没自动注册。本批把这两处补上，顺带把“引导子 agent”
与“子任务交回结构化结果”做成一等公民。

## 单点引导（H-2）

对在跑的子 agent 发引导，引导排队、等检查点再消费，**不打断在跑的
工具调用**。引导只改子 agent 接下来的方向，不改已做过的、不改已发出
去的；排队不等于已送达——引导真正被消费时才进证据链。

```
nyra subagent steer <运行 id> "<引导文本>" --yes [--by <名字>]
```

- `--yes` 必填，只确认“已排队”；引导文本 1–1000 字，空文本与超长都
  直接拒绝。
- 只能给 `running` / `resume_pending` 的行排队；终态行（completed /
  failed / stopped 等）拒绝排队。
- 引导文本原样进子 agent 的下一轮模型调用（以 user 角色消息追加，
  前面标明是“机主的引导”，子 agent 看得到是谁说的）。
- 引导只在委派当次运行内消费；续跑（`resumeSubagentRun`）不消费旧
  引导，免得过期的方向在续跑时突然冒出来。

### 检查点：委派主循环里

子 agent 的 runLoop 每轮末尾（工具调用跑完、下一轮模型调用之前）
过一次检查点，顺序是先看停止、再看引导：

- **已请求停止**：本轮收尾，返回“已请求停止”的部分文本，不再往下
  跑。注意：提前交回的行不标 `completed`——停没停下来以人的
  `confirm-stopped` 为准，行留在 `running` 态等确认。
- **有引导**：消费掉（标 `consumedAt`），追加进消息，下一轮模型调
  用按新方向走；消费事件补进父级证据链。
- 每轮记一次心跳（工具名摘要），花名册上“当前动作”就是从这里来的。
- 检查点本身全包 try/catch：注册表读不到、写不上时停止/引导功能
  降级，主循环照常跑，不会因为检查点坏了把任务也拖垮。

### delegate 调用点自动注册

`delegate` / `delegate_parallel` 现在自动在注册表里登记子 agent
行（`runId` = 任务 id，`agent` = Soul agent 名，`parentRunId` = 父级
的运行 id，嵌套委派一路传下去，花名册上按 `parentRunId` 缩进）；
跑完后 `finishSubagentRun` 回写 `completed` / `failed`。注册失败
只记一条备注、检查点关闭，不挡任务本身。

## 结构化输出契约（H-4）

子任务可带 `output_schema`（JSON Schema 子集），子 agent 交回的
结果先按 schema 校验再算数。

- `delegate` / `delegate_parallel` 的工具参数与 `Agent.delegateDetailed`
  的 `opts.outputSchema` 都认 `output_schema`，并行线程逐个透传。
- schema 本身是调用方给的，子 agent 不得自改；契约写坏（非法
  type、required 不是字符串数组等）在委派前就拒绝，模型一次都不调。
- 校验失败给**一次有界纠正轮**：只纠格式/缺字段，把错误清单原文
  贴给子 agent 重写一遍，不重做整个任务。纠正后仍失败则按失败走：
  验收结论记 `failed`，交回文本里写清 `schema_valid: false` 与错误，
  原文保留、不静默接受坏结果；后续进审阅队列 / 任务板路径，与普通
  失败同一条路。
- 交回文本末尾加一行结构化输出结论（`schema_valid: true/false`，
  纠正过注明“纠正 1 次后通过”）。

### schema 子集（`src/outputSchema.ts`）

`checkOutputSchema`（契约合法性前置校验）、`extractJsonCandidate`
（先找 ```json 代码块，再整段，最后字符串感知扫描第一个配对
`{…}` / `[…]`）、`validateOutputSchema`（校验：`type`、`required`、
`properties`、`additionalProperties`、`items`、`enum`、`minLength` /
`maxLength`、`minimum` / `maximum`、`pattern`；最多 10 条错误，每条
≤ 200 字）。`type` 认 `string` / `integer` / `number` / `boolean` /
`object` / `array` / `null`。

## 事件（证据链）

`subagent_steer_queued`（哪个运行、谁发起、引导 id 与文本）/
`subagent_steer_consumed`（哪个运行、谁发起、引导 id）已注册进
`EVENT_FIELDS`，`src/timeline.ts` 加渲染。排队事件写进父运行的链
（父运行不存在时只记队列）；消费事件由父级补记。事件里不记绝对
路径，引导文本原样进事件（文本是人写的方向，不是密钥）。

## 已知局限

- 引导只在委派当次运行内消费，续跑不消费旧引导。
- 检查点读不到注册表时停止/引导功能降级、主循环照常。
- 真实多 agent 场景只在假 provider 上验过；Windows/macOS 真机未验证。
