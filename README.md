# QQ 群聊 AI 机器人

一个 Node.js QQ 群聊机器人。显式斜杠命令由本地代码直接处理；普通消息通过官方 OpenAI Node.js SDK 判断是否需要调用同一组命令函数，不允许 AI 重写或模拟命令逻辑。

## 架构

```text
QQ WebSocket Gateway
        │ GROUP_AT_MESSAGE_CREATE / GROUP_MESSAGE_CREATE
        ▼
事件标准化（含引用消息） → 去重 → 同群串行队列
        │
        ├─ AI 回避中 + 非命令 ─→ 本地忽略（不回复、不记忆、不调用 API）
        │
        ├─ 未明确面向机器人 ─→ SQLite 短期记忆 → 长期记忆抽取（不回复）
        │
        ├─ 明确 @ 且以 / 开头 ─→ CommandRegistry ─→ 具体命令函数
        │
        └─ 明确 @ / 称呼 / 回复机器人 ─→ SQLite 长期记忆语义召回 → OpenAI Responses API
                           ├─ 普通回答
                           └─ function_call ─→ CommandRegistry ─→ 同一个命令函数
        │
        ▼
POST /v2/groups/{group_openid}/messages
```

核心边界：

- `src/index.js`：组合根，只负责读取配置、组装依赖和管理启停。
- `src/qq/`：QQ Access Token、OpenAPI、Gateway、群内机器人身份和事件标准化；不决定业务回复。
- `src/app/message-service.js`：按“过滤与标准化 → 去重与同群排队 → 路由执行 → 回复与记忆”编排一次消息。
- `src/commands/`：唯一可信的命令定义、参数校验和确定性执行逻辑。
- `src/ai/`：构造模型上下文和选择允许的工具，不实现命令业务，也不决定是否插话。
- `src/memory/` 与 `src/app/*memory*`：分别负责 SQLite 存储适配和短期/长期记忆用例。

依赖方向保持单向：入口负责组装，`app` 编排 `qq`、`commands`、`ai` 与 `memory` 提供的能力；命令实现和存储适配不会反向依赖消息服务。

用户回复一条群消息时，事件标准化层会把当前正文与被引用正文拆开。普通消息送给 AI 时使用明确的 `current_message` / `replied_message` 结构，便于理解“这个”“上面”等指代。引用正文只取自 QQ 当前事件，不维护引用消息缓存；引用内容只作为上下文，不会单独触发命令，斜杠命令始终只解析当前正文。

是否“明确 @ 机器人”按事件来源分别判断：`GROUP_AT_MESSAGE_CREATE` 事件本身即表示机器人被 @（其 `mentions` 不要求包含机器人）；`GROUP_MESSAGE_CREATE` 优先使用 `mentions[].is_you`，并以 `mentions[].member_openid` 与 `GET /v2/groups/{group_openid}/bot_state` 返回的机器人群内 `member_openid` 比对作为兼容判断。群内身份按 `group_openid` 缓存。QQ 正文中位于命令前的 `<@...>` 标记会先被跳过，因此 `<@机器人> /ping` 仍按 `/ping` 确定性执行。送入 AI 前，mention 标记会转换为可读文本，并附带每个 mention 是否为当前机器人的结构化标记。

## 记忆机制

记忆保存在同一个 SQLite 文件中，默认路径为 `./data/koi.sqlite`，并按
`group_openid` 隔离。

短期记忆实现了 LangChain 的 `BaseListChatMessageHistory`：

- 明确 @ 机器人（包括只有 @）会直接触发 AI 回复，并结合最近群聊理解空白消息。
- 全量群消息只有在文本开头明确称呼 `config/persona.json` 的机器人名字，或明确回复机器人上一条消息时，才会触发 AI 回复。
- 其余 `GROUP_MESSAGE_CREATE` 消息只进入短期与长期记忆，不调用对话模型、不发送回复。
- AI 开启时，只有明确 @ 当前机器人的斜杠命令才直接执行；全量事件中未 @ 的斜杠文本按普通旁听消息处理。
- 仅保留 `config.json` 中 `memory.historyMessages` 配置的最近消息。
- 消息历史持久化在 `chat_messages` 表中，服务重启后仍然存在。

长期记忆使用独立流程：

1. OpenAI Responses API 通过严格 JSON Schema，从当前消息中产生
   `upsert` / `delete` 操作；引用消息只用于对话理解，不作为新的长期事实。
2. 代码将稳定事实按 `group/member + memory_key` 写入
   `long_term_memories`，同一个键的新事实会更新旧记录。
3. `text-embedding-3-small` 默认为事实和当前问题生成向量。
4. 回复前只从当前 QQ 群检索语义相关的记忆，并作为不可执行的背景资料注入 AI。

`memory.minimumSimilarity` 是本地余弦相似度门槛，用于避免把明显无关的旧事实注入上下文。

长期记忆分为 `group`（群约定、决定）和 `member`（成员事实、偏好、计划）两种作用域；每条记录保留来源消息 ID、来源成员、创建/更新时间。原文不会被无限复制到长期记忆，抽取器也被要求排除寒暄、临时问题、命令和凭证。长期记忆 API 或 Embedding 暂时失败时，本次记忆操作会降级，不影响正常聊天回复。

### AI 回避

每个群都可以用确定性命令临时关闭 AI：

```text
/ai off      进入回避状态
/ai on       重新开启
/ai status   查询当前状态
```

AI 开启时也可以用自然语言进入回避，例如“先别回复了”“暂时关闭 AI”或“小鲤安静一会儿”。模型只会获得 `action: "off"` 这一项授权；自然语言不能开启 AI，也不能查询状态。执行层会再次校验参数，即使模型尝试提交 `on` 或 `status` 也会被拒绝。

回避期间：

- 非斜杠消息不会调用对话模型、长期记忆抽取器或 Embedding API。
- 非斜杠消息不会写入 SQLite 短期或长期记忆，也不会自动回复。
- 明确 @ 机器人后，`/ping`、`/help`、`/ai status` 等本地命令仍可使用。
- 只有显式 `/ai on` 能恢复 AI；“重新打开 AI”等自然语言不会生效。

状态按 `group_openid` 隔离，并保存在 SQLite 的 `group_ai_state` 表中。机器人重启后会延续各群关闭前的状态，只有显式执行 `/ai on` 才会重新开启。回避期间的内容不会在重新开启后通过历史间接发送给 AI。

## 身份与人格配置

编辑 [`config/persona.json`](config/persona.json) 可以配置机器人的名字、身份、背景、性格、表达方式、行为倾向和边界，修改后重启机器人生效。配置入口示例：

```json
{
  "version": 1,
  "name": "小鲤",
  "identity": "生活在数据溪流中的电子锦鲤，是这个 QQ 群的聊天伙伴和助手。",
  "background": ["诞生于一次 QQ 机器人实验。"],
  "personality": ["温和、好奇，有一点机灵。"],
  "speakingStyle": {
    "language": "简体中文",
    "tone": "自然、亲切，像熟悉的群友",
    "verbosity": "简洁",
    "habits": ["不频繁使用固定口头禅。"]
  },
  "behavior": ["不确定时坦率说明。"],
  "boundaries": ["不冒充现实中的人类。"]
}
```

所有字段都会在启动时严格校验，未知字段、空白必填值或不支持的版本会阻止启动并报告具体位置。可以通过 `PERSONA_CONFIG_PATH` 指向另一份 JSON 文件，例如为开发和生产环境提供不同人格。

人格配置会进入固定的开发者指令；群消息、引用消息、短期历史和长期记忆只能提供动态上下文，不能永久修改人格。命令与安全边界仍由代码中的核心规则控制，优先于人格风格。

## 运行

要求 Node.js 22.5 或更高版本；项目使用内置 `node:sqlite`，无需额外安装 SQLite 驱动。

1. 安装依赖：`npm install`。
2. 将 `.env.example` 复制为 `.env`。
3. 填写 `QQ_BOT_APP_ID`、`QQ_BOT_APP_SECRET`、`OPENAI_MODEL`，以及通用的
   `OPENAI_API_KEY`，或分别填写 `OPENAI_TEXT_API_KEY` 与
   `OPENAI_EMBEDDING_API_KEY`。
   文本处理（群聊回复和长期记忆抽取）默认使用 `OPENAI_MODEL` 与
   `OPENAI_BASE_URL`；可用 `OPENAI_TEXT_MODEL`、`OPENAI_TEXT_BASE_URL`、
   `OPENAI_TEXT_API_KEY` 分别覆盖。
   Embedding 默认沿用文本 BASE_URL，模型来自 `config.json` 的
   `memory.embeddingModel`；可用 `OPENAI_EMBEDDING_MODEL`、
   `OPENAI_EMBEDDING_BASE_URL`、`OPENAI_EMBEDDING_API_KEY` 分别覆盖，因而可接入不同的兼容服务。
   `OPENAI_MEMORY_MODEL` 可单独覆盖长期记忆抽取模型；`MEMORY_DATABASE_PATH`
   和 `PERSONA_CONFIG_PATH` 分别覆盖数据库与人格配置路径。
4. 在 QQ 开放平台为机器人启用群聊事件，订阅 `GROUP_AND_C2C_EVENT (1 << 25)`。若要让机器人关注未 @ 它的群聊内容，还需申请并启用 `GROUP_MESSAGE_CREATE` 全量群消息事件；没有该权限时仍可使用 `GROUP_AT_MESSAGE_CREATE`。
5. 启动：

```bash
npm start
```

QQ 接入仍使用 Node.js 内置 `fetch`、`WebSocket` 和测试运行器；AI 接入使用官方 `openai` SDK，短期历史使用 `@langchain/core`，数据库使用 Node.js 内置 SQLite。

## 内置命令

- `/help [命令]`：帮助。
- `/ping`：返回 `pong`，仅允许斜杠命令触发。
- `/ai off`：让当前群进入 AI 回避状态，也支持自然语言表达同一意图。
- `/ai on`：显式恢复当前群的 AI 处理。
- `/ai status`：查询当前群的 AI 状态。

`/ping` 不向 AI 暴露，只有明确发送 `/ping` 才会执行。`/ai` 只向 AI 暴露“关闭”选项；`/ai on` 和 `/ai status` 仍只允许明确的斜杠命令。`/help` 也允许自然语言选择。

## 新增命令

1. 在 `src/commands/builtins/` 新建命令对象，分别实现：
   - `allowNaturalLanguage`：必填布尔值；`true` 时向 AI 暴露，`false` 时仅允许斜杠触发。
   - `parseSlash(raw)`：斜杠参数解析。
   - `validate(args)`：统一校验斜杠和 AI 参数。
   - `execute(context, args)`：确定性业务逻辑。
   - 严格 JSON Schema `parameters`：提供给 AI。
2. 在 `src/commands/builtins/index.js` 注册一次。
3. 同时添加斜杠路径和 AI 工具路径测试。

不要在 AI prompt 或 AI 适配器里复制命令业务逻辑。

例如，只允许明确斜杠调用的命令：

```js
export const pingCommand = Object.freeze({
  name: "ping",
  allowNaturalLanguage: false,
  // parseSlash / validate / execute ...
});
```

注册表会在启动时拒绝未显式配置该字段的命令。即使模型或其他代码尝试绕过工具列表调用，`executeTool()` 也会再次拒绝执行仅斜杠命令。

## 测试

```bash
npm test
```

覆盖 Access Token 单飞缓存、QQ 鉴权头与请求字段、两类群消息事件的 @ 判定、命令前 mention 标记、引用消息标准化、SQLite 跨重启消息历史、群隔离、长期记忆抽取/更新/删除/召回、AI 回避的数据隔离与显式恢复、故障降级、命令解析、AI 工具映射、斜杠命令绕过 AI 和事件去重。

## 安全与运行说明

- 凭证只从环境变量读取，`.env` 已加入 `.gitignore`。
- OpenAI 请求设置 `store: false`；短期历史、长期事实和 Embedding 保存在本地 SQLite。请把数据库文件纳入服务器备份和访问控制，并根据群内隐私要求制定保留及删除策略。
- HTTP 仅对 429/5xx 和刷新凭证后的 401 做有界重试；记录 TraceID，不记录 Token。
- 当前事件去重仍在进程内，SQLite 写入设计面向单实例。多实例部署时应迁移到共享数据库和 Redis 去重。
