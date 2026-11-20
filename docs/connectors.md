# 连接器授权状态机（缺口 44 第 0 批）

用户 2026-11-20 拍板：Bot Phase 3 做完先做这一批。对应总报告里的缺口 44
（原生业务连接器目录，先决缺口 6 已落地）与 AgentKit 调研报告里值得学的
两点：连接器目录模式、每应用一次批准 + 每用户一次授权的授权状态机。

## 连接器目录

目录里先有 3 个连接器（缺口 44 定义：先接 3 个做深，不拼数量）：

| 连接器 | 状态 | 说明 |
|---|---|---|
| Gmail | 已接入 | 读信、按 thread 回复、代发草稿（缺口 6 已落地） |
| Shopify | 已接入（只读） | 用户自己的 Hollow & Scale 店铺：查商品、订单、库存（缺口 44 第一批，只读起步） |
| Slack | 试点 | 团队消息与审批卡的落点（下一批做深） |

试点连接器在目录里看得见、用不了，不假装已接通。

## 权限声明格式

每个连接器上架时必须声明四件套（声明在 `src/connectors/registry.ts`
的 `CONNECTOR_DECLARATIONS` 里，是代码，不是散文）：

1. **读/写范围**：OAuth scope 或能力描述，分读、写两列。
2. **工具组**：它提供的工具名 + 每个工具是只读还是可写。
3. **会访问的数据**：给用户看的 plain 描述（不是 scope 原文）。
4. **永远须人批 / 永远禁做**：哪些写操作永远须人批、哪些永远禁做
   （引用缺口 51 红线表；本批先写连接器自己的禁做清单）。

批准时用户看得到这份声明，不是点了同意才知道。**声明缺失的连接器默认
只读、且每次使用都要重新确认（fail-closed）**——`effectivePermissions`
对没声明的连接器一律返回只读 + 每次确认。

## 授权状态机

四态：**未授权 → 已授权 → 已过期 / 已撤销**。

```
未授权 ──显式批准一次──▶ 已授权 ──refresh 失败──▶ 已过期
   ▲                        │  ▲
   │                        │  └──── 重新授权 ──────┘
   └──── 重新授权 ──────────┴── 撤销 ──▶ 已撤销 ── 重新授权 ──▶ 已授权
```

- **每应用一次批准**：首次使用某连接器须用户显式批准一次（`nyra connector
  approve <连接器>`，或走该连接器自己的授权流程如 `nyra gmail auth`），
  之后同应用同用户不再重复问。
- **每用户一次授权**：授权按用户隔离（复用缺口 41 的账号体系：本机当前
  会话的 account_id；没登录时记在 `local` 名下）。
- **过期自动标记**：refresh token 失效（坏了/被撤销）时，下一次调用直接
  报“授权已过期，请重新授权”，不再拿死掉的 refresh token 反复试。
  注意：Gmail 的 `expires_at` 是 access_token 的过期时刻（约 1 小时），
  不是授权的过期——access token 过期靠 refresh 自动换，不代表授权失效。
- **撤销立即失效**：状态一写“已撤销”，之后每次调用都直接拒绝，不等下次
  启动才失效；Gmail 撤销时同时吊销远端 token、删除本地 token、关闭连接器。

状态账本在 `~/.nyra/connector-auth.json`（0600、原子写）；审计在
`~/.nyra/connector-audit.jsonl`（只记动作、连接器、用户、token 指纹与
原因，不记邮箱、不记 token）；授权/过期/撤销三件事另记运行事件
`connector_authorized` / `connector_expired` / `connector_revoked`
（已注册进 `EVENT_FIELDS`）。

### 已有授权的迁移

本批落地前已经跑过 `nyra gmail auth` 的用户不打断：第一次调用
`createGmailTransport` 时，密码箱里已有凭证但状态账本还没记录的，沿用
已有授权迁移为“已授权”（迁移记进审计，`migratedFrom: "existing-credentials"`）。

## 令牌存放（硬边界）

**只走本地密码箱**（nyra vault / `~/.nyra/keys.json`，0600），绝不建任何
第三方托管 vault、不把令牌发到任何外部服务——这是 AgentKit 调研里明确
不学的点。状态机只存 token 指纹（SHA-256 前 12 位），token 本身绝不进
状态文件、审计与事件。

## CLI

```
nyra connector list                              列出全部连接器与授权状态
nyra connector status [连接器]                   查看一个/全部连接器的授权状态与权限声明
nyra connector approve <连接器>                  显式批准一次
nyra connector revoke <连接器> [--yes]           撤销授权（立即失效）
```

`nyra gmail status` 也会多一行授权状态；`nyra gmail auth` 成功后自动在
状态机里记“已授权”，`nyra gmail revoke` 后自动记“已撤销”。

## 接线点

状态检查只接在 `createGmailTransport` 里——所有真实的 Gmail 调用（Agent
工具、CLI、事件触发轮询）都走它，检查一处就全拦住了；假 transport 注入
（测试用）不走状态检查。Gmail 功能本身一字不改：读仍只读、发仍走审批。

## Shopify（只读起步，缺口 44 第一批）

### 凭证：自定义应用 token，不走 OAuth

Shopify 的 OAuth 授权码流程要一个公网回调地址，Nyra 跑在本机 localhost
上没有，所以本批用**自定义应用的 Admin API access token**：

1. Shopify 后台 → 设置 → 应用 → 开发自定义应用 → 建一个应用；
2. 只勾三个读权限：`read_products`、`read_orders`、`read_inventory`（多了不要）；
3. 安装应用，复制 **Admin API access token**（`shpat_…` 开头）；
4. 运行 `nyra shopify auth`，粘贴店铺域名与 token（只存密码箱，不进配置文件）。

授权时会先拿 `shop.json` 探一下：401 说明 token 不对或读权限没给，不存；
网络不通时先存下、下次调用再验。授权成功自动启用连接器，并在状态机里记
“已授权”（之后同应用同用户不再重复问）。

### 只读工具

| 命令 | 作用 |
|---|---|
| `nyra shopify products [--limit N] [--page-info X]` | 列出商品（默认 50 条一页，上限 250） |
| `nyra shopify product <id>` | 查一个商品 |
| `nyra shopify orders [--limit N] [--status any\|open\|closed\|cancelled\|archived] [--page-info X]` | 列出订单（默认全部状态） |
| `nyra shopify order <id>` | 查一个订单 |
| `nyra shopify inventory [--location-id N] [--inventory-item-id N] [--limit N] [--page-info X]` | 查库存水平（按地点 / 商品过滤） |
| `nyra shopify status` | 查看状态（是否启用、是否已授权、店铺域名） |

订单输出**不含客户邮箱与地址**（`customer` 对象整个不解析）；每次调用
记一行审计（`connector-audit.jsonl`，`action: "call"`），只记操作名、
记录数、耗时，不记 token、不记响应内容、不记客户信息。

### 写操作一律拒绝

本批不提供任何写入口：改价、改库存、下单、退款、发折扣码、删单一律在调
API 之前就拒绝（`shopifyWriteRefusal`，CLI 上撞见 `set-price` /
`update-inventory` / `refund` 等词也直接回一句明确拒绝）。写操作是以后
的一批，到时也要先过审批与红线表（缺口 51）。

### 撤销的诚实说明

`nyra connector revoke shopify` 只删本地凭证：自定义应用的 token **没有
远端吊销接口**，想彻底作废 token 必须去 Shopify 后台删除该自定义应用
（撤销时会明确提示这一点）。401（token 被删/被轮换/权限被收回）时自动标
“已过期”，下次调用直接报“请重新授权”。

## 已知局限（诚实边界）

- 真实 Gmail OAuth 授权未在真应用上跑通，只在假 vault / 假 OAuth 上验过。
- 真实 Shopify 店铺未接通，只在假 API 上验过；自定义应用 token 的授权流程未在真店上跑通。
- Slack 的深连接器是下一批；Shopify 只读已接，写操作是以后的一批。
- 过期只在 refresh 失败时标记：access token 正常过期不标（它会被自动刷新）。
- 授权状态按本机当前会话的 account_id 隔离；网关多用户权限模型是缺口 41
  的下一批，本批不碰。
