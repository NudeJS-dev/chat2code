# Chat2Code

将通用对话请求统一包装为结构化 JSON（含工具调用指令），并返回类 Anthropic Messages 的响应格式。后端通过 `OpenAI /v1/chat/completions` 调用模型，内置简易 JSON 修复与响应缓存。

## 项目简介

- 统一接口：提供一个 `POST /v1/messages` 端点，输入对话、系统指令和工具列表，输出结构化的 `content`（`text`/`tool_use` 等）。
- 提示模板：将对话注入到 `prompts/function_call.txt`，引导模型以 `<AnswerInJson>...</AnswerInJson>` 格式返回。
- 解析与修复：从模型输出中提取 JSON；若解析失败，尝试使用 `prompts/fix_json.txt` 进行自动修复。
- 轻量缓存：按请求消息 MD5 与模型名缓存返回，命中后快速返回、`usage` 归零。
- 使用 `@anthropic-ai/tokenizer` 对输入输出进行本地 Token 估算（仅供参考）。

## 实现思路（简述）

- 模型路由：通过环境变量 `MODELS`、`OPENAI_BASE_URLS` 映射模型到后端基地址；同位置保留 `OPENAI_KEYS`（当前未在请求链路中使用）。
- 授权透传：使用来访请求头 `Authorization` 透传到后端模型服务。
- 模板拼装：将 `system`、`tools`、`messages` 注入 `function_call` 模板，作为单条 `user` 消息发送至后端。
- 响应处理：提取 `<AnswerInJson>` 包裹的 JSON；为 `tool_use` 自动生成唯一 `id`；计算 `usage`；写入缓存。
- 错误记录：当 `DEBUG=true` 时，将失败请求与解析日志写入 `errors/<timestamp>.txt`。

## 环境要求

- Node.js 22（或兼容版本）；Docker 镜像使用 `node:22-alpine`。
- 外部可用的模型服务（例如 OpenAI 兼容代理），并支持 `POST /v1/chat/completions`。

## 安装与启动

### 本地运行

```bash
npm install
```

- 直接启动（示例）：
```bash
PORT=3000 \
MODELS=gpt-5 \
OPENAI_BASE_URLS=http://your-host/proxy/gpt \
DEFAULT_MODEL=gpt-5 \
DEBUG=true \
node server.js
```

- 使用 npm 脚本：
  - `npm start`：示例内置了一组环境变量（请务必替换为你自己的地址与密钥，不要将真实密钥提交到仓库）。
  - `npm run dev`：开发模式（仅设置 `NODE_ENV=development`）。

注意：本地启动且开启 `DEBUG=true` 时，建议手动创建 `errors/` 目录，否则写日志可能失败：
```bash
mkdir -p errors
```

### Docker 运行

```bash
docker build -t chat2code .
docker run --rm -p 3000:3000 \
  -e PORT=3000 \
  -e MODELS=gpt-5 \
  -e OPENAI_BASE_URLS=http://your-host/proxy/gpt \
  -e DEFAULT_MODEL=gpt-5 \
  -e DEBUG=true \
  chat2code
```

镜像已默认创建 `errors/` 目录并设置 `PORT=3000`。

## 环境变量

- `PORT`：服务监听端口。默认 `3000`。
- `DEBUG`：是否写入错误日志文件。`true`/`false`，默认未设置（不写文件）。
- `MODELS`：逗号分隔的模型名列表，如 `gpt-5,gpt-4o`。
- `OPENAI_BASE_URLS`：与 `MODELS` 一一对应的后端基地址列表（不包含 `/v1/chat/completions`），如 `https://api.openai.com,https://your-host/proxy`.
- `OPENAI_KEYS`：与 `MODELS` 一一对应的密钥列表（当前代码未使用该值进行请求，请见下方说明）。
- `DEFAULT_MODEL`：默认模型名；若未设置则取 `MODELS` 列表的第一个。
- `NODE_ENV`：开发/生产标识（仅被 `npm run dev` 设置，不参与逻辑分支）。

设置方法（示例）：
- 终端临时设置：`MODELS=xxx OPENAI_BASE_URLS=yyy DEFAULT_MODEL=xxx node server.js`
- 持久设置（Linux）：`export MODELS=...; export OPENAI_BASE_URLS=...; node server.js`
- Docker：`docker run -e MODELS=... -e OPENAI_BASE_URLS=... ... chat2code`

约束与注意：
- `MODELS`、`OPENAI_BASE_URLS`、`OPENAI_KEYS` 三者长度必须一致，否则启动报错。
- `DEFAULT_MODEL` 必须存在于 `MODELS` 列表中。

## 日志与缓存

- 错误日志：当 `DEBUG=true` 且请求失败或解析失败时，会把上下文写到 `errors/<YYYY-MM-DD-HH:MM:SS>.txt`。
- 响应缓存：以内存 `responseCache` 保存，键为 `md5(messages)+model`；命中后不再请求后端。

## 自定义提示词

- 修改 `prompts/function_call.txt` 可调整输出 JSON 的结构或标签。
- 修改 `prompts/fix_json.txt` 可调整自动修复逻辑（用于将不可解析文本修复为合法 JSON）。

## 常见问题

- 401 未授权：未设置 `Authorization` 请求头或密钥无效。
- 解析失败 500：后端未返回 `<AnswerInJson>` 包裹的合法 JSON；可开启 `DEBUG=true` 查看 `errors/` 中的详细日志。
- Token 估算：当前实现仅做近似估算，结果可能与实际计费的 Token 有差异。
- 本地日志目录：本地运行且设置 `DEBUG=true` 时请先 `mkdir -p errors`。

---
如需进一步定制路由、鉴权或将环境密钥用于请求，请修改 `server.js` 中相关位置并完善密钥管理策略。