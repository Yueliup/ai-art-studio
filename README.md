# AI Art Studio · AI 美术生产工具集

面向美术团队与中台的**批量生产 + 资产治理 + 交付打包**工具集。一条命令起服务，浏览器里完成从需求到可交付包的全过程。

```
批量生成 ──▶ 格式转换 ──▶ 命名规范 & 完整性检查 ──▶ 打包交付
   │             │                  │                    │
 多提供方适配   多格式/多倍率     规则引擎 + 感知去重   manifest + 报告 + 校验清单
```

- **零外部依赖**：后端只用 Node 原生能力 + `sharp`（图像编解码）+ `adm-zip`（打包）；前端无框架、无 CDN，**断网可用**（美术常在隔离网段作业）。
- **统一契约**：所有接口共用一套响应信封与 42 个错误码；5 类外部 AI 绘图工具被归一化为同一组 `GenerateRequest → NormalizedImage[]`，错误一律映射为统一错误码。
- **可验收**：`npm run smoke` 覆盖 10 组 60 项断言（含错误路径与 SSE），当前 **60/60 通过，服务日志 0 条 ERROR**。

---

## 一、快速开始

```bash
cd ai-art-studio
npm install
npm run seed     # 生成 12 个样例资产（含刻意构造的问题样本）
npm start        # 默认 http://127.0.0.1:8848
npm run smoke    # 另开终端：端到端验收（60 项断言）
```

打开 `http://127.0.0.1:8848` 即为控制台。

**推荐首次体验路径**

1. 「命名与资产检查」→ 输入源选 `工作区目录` → 子目录填 `uploads/sample-assets` → 提交检查。
   可看到 12 个样例中检出 31 处阻断问题、2 对重复资产，并给出逐资产的建议命名。
2. 「一键全链路交付」→ 直接点「启动全链路交付」。默认走本地模拟渲染器，无需任何密钥即可跑完
   生成 → 转换 → 质检 → 打包，产出可下载的交付包与质检报告。

---

## 二、能力地图

| 模块 | 能力 | 关键实现 |
| --- | --- | --- |
| **批量生成** | 提示词 × 尺寸 × 模型 × 风格矩阵展开、种子递增/固定/随机、逐项失败隔离、断点可查 | `server/pipeline/generate.js` |
| **格式转换** | png/jpg/webp/avif/tiff、等比/裁剪/尺寸盒/最长边、倍率多档、JPG 自动铺底、EXIF 剥离 | `server/pipeline/convert.js` |
| **命名规范** | 4 套内置规范集（游戏 UI / 宣传物料 / 角色立绘 / 宽松），token 模板 + 值域约束 + 禁用词，支持自动修复建议 | `server/pipeline/naming.js` |
| **资产检查** | 可解码性、尺寸/体积/长宽比、透明通道策略、空白图检测、感知指纹去重、命名合规，输出 0-100 健康分 | `server/pipeline/inspect.js` |
| **打包交付** | zip + `manifest.json`（逐文件 sha256/尺寸/提示词/seed）+ `checksums.sha256` + 自包含 `report.html` + README | `server/pipeline/pack.js` |
| **提供方适配** | 6 个适配器，覆盖「同步返回 base64」「异步 taskId 轮询」「工作流引擎」三种协议范式 | `server/adapters/` |
| **任务中心** | 并发队列（全局 + 每提供方独立上限）、指数退避重试、取消、按原参数重跑、SSE 实时进度 | `server/core/queue.js` |
| **控制台** | 10 个视图：总览看板 / 一键交付 / 批量生成 / 格式转换 / 资产检查 / 交付包 / 资产库 / 提供方 / 任务中心 / 系统 | `web/` |

---

## 三、架构

```
┌─────────────────────────────── 控制台 (web/) ───────────────────────────────┐
│  10 视图 · 零依赖 · 全部枚举由 /api/system/meta 自描述 · SSE 进度订阅         │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │  统一响应信封 { success, code, data, requestId, elapsedMs }
┌──────────────────────────────────▼──────────────────────────────────────────┐
│                            API 层 (server/routes/)                          │
│  system · jobs · pipeline     中间件：trace 注入 → CORS → 鉴权 → 限流         │
│  统一错误出口：AppError → 错误码注册表 → HTTP 状态 + 可重试标记                │
└──────────────────────────────────┬──────────────────────────────────────────┘
┌──────────────────────────────────▼──────────────────────────────────────────┐
│                        任务运行时 (server/core/)                             │
│  queue（并发/重试/取消）· store（任务审计 + 事件总线）· logger（traceId 贯穿） │
└───────┬──────────────────────────────────────────────┬──────────────────────┘
        │                                              │
┌───────▼─────────┐                          ┌─────────▼──────────────────────┐
│ 流水线 pipeline │                          │  提供方适配层 adapters         │
│ generate        │  ← 统一领域模型 →        │  mock / sdwebui / comfyui      │
│ convert         │                          │  openai / dashscope / volcengine│
│ inspect / pack  │                          │  normalizeRequest / buildPayload│
│ report          │                          │  submit / poll / fetchResult    │
└─────────────────┘                          └────────────────────────────────┘
```

---

## 四、统一契约（本工具集的核心设计）

### 4.1 统一响应结构

所有接口（含 SSE 的每个事件）使用同一信封，前端只需实现一次解包：

```jsonc
// 成功
{ "success": true, "code": "OK", "message": "成功",
  "requestId": "...", "traceId": "tr_...", "elapsedMs": 12.3, "data": { } }

// 失败
{ "success": false, "code": "E_PROVIDER_TIMEOUT", "message": "提供方响应超时",
  "requestId": "...", "traceId": "tr_...", "elapsedMs": 180034.2,
  "error": { "code": "E_PROVIDER_TIMEOUT", "domain": "PROVIDER",
             "retryable": true, "field": null, "details": { } },
  "data": null }
```

前端只需读 `code / message / retryable` 三个字段即可完成全部分支，**不需要解析任何中文文案**。

### 4.2 统一错误码注册表

42 个错误码，按 10 个域分组，每个错误码自带 `httpStatus` / `domain` / `retryable` / 默认文案：

| 域 | 示例 | 说明 |
| --- | --- | --- |
| `SYS` | `E_SYS_INTERNAL` `E_SYS_BUSY` | 服务级 |
| `VALIDATION` | `E_VALIDATION_MISSING_FIELD` `E_VALIDATION_OUT_OF_RANGE` | 参数校验 |
| `NOT_FOUND` | `E_PROVIDER_NOT_FOUND` `E_ASSET_NOT_FOUND` | 资源不存在 |
| `CONFLICT` | `E_JOB_NOT_CANCELABLE` `E_STAGE_PRECHECK_FAILED` | 状态冲突 |
| `LIMIT` | `E_LIMIT_QUEUE_FULL` `E_LIMIT_BATCH_TOO_LARGE` | 配额与限流 |
| `IO` | `E_IO_WRITE_FAILED` `E_IO_DISK_FULL` | 文件与磁盘 |
| `FORMAT` | `E_FORMAT_UNSUPPORTED` `E_FORMAT_DECODE_FAILED` | 格式与编解码 |
| `PIPELINE` | `E_PIPELINE_ABORTED` `E_NAMING_RULE_INVALID` | 流水线 |
| `PROVIDER` | `E_PROVIDER_TIMEOUT` `E_PROVIDER_AUTH` `E_PROVIDER_RATE_LIMIT` | 外部提供方 |
| `AUTH` | `E_AUTH_REQUIRED` | 鉴权 |

`retryable: true` 的错误会被队列自动指数退避重试（上限可配），`false` 的直接落到终态并保留错误码。

### 4.3 提供方适配器契约

无论底层协议差异多大，上层只看到这四个方法：

```js
normalizeRequest(req)      // 统一入参校验与归一化（所有适配器共享）
buildPayload(req)          // → 提供方原生请求体
submit(payload, ctx)       // → { remoteTaskId?, images?: RawImage[] }
poll(taskId, ctx)          // → { state: 'pending'|'running'|'succeeded'|'failed', progress?, images? }
fetchResult(image)         // → Buffer（异步提供方的产物 URL 有效期短，必须立即落盘）
```

已实现适配器与协议范式：

| 提供方 | 协议范式 | 关键处理 |
| --- | --- | --- |
| `local-mock` | 同步（本地） | 按提示词哈希做**确定性程序化渲染**，用于无密钥环境下的全链路验收与回归 |
| `sd-webui` | 同步阻塞 + base64 数组 | `batch_size`/`cfg_scale` 映射、`data:` 前缀容错 |
| `comfyui` | 异步队列（`/prompt` → `/history` → `/view`） | 节点图生成、产物 URL 组装、进度推断 |
| `openai-images` | 同步 + b64_json/url | 按模型分叉（gpt-image-1 不支持 `response_format`）、尺寸枚举就近取整 |
| `dashscope`（通义万相） | 异步（`X-DashScope-Async` + task 轮询） | 任务状态映射、产物**立即转存本地**（URL 仅 24h 有效） |
| `volcengine`（即梦） | 异步 + 签名鉴权 | V4 HMAC-SHA256 签名派生，无 SK 时回退 Bearer |

健康检查永不抛异常，返回 `{ ok, latencyMs, detail, code }`，前端据此画状态灯；未配置密钥的云端提供方会被如实标记为不可用而不是伪造成功。

---

## 五、API 速览

完整清单在运行后访问 `/api/system/routes`（服务端自描述，前端不硬编码）。

```bash
# 元信息（前端启动时拉一次拿全部枚举）
GET  /api/system/meta
GET  /api/system/health
GET  /api/stats/overview

# 批量生成
POST /api/generate/plan          # 只预演：展开矩阵、估算规模、预测产物命名
POST /api/generate              # 提交（立即返回 job 快照）

# 格式转换 / 资产检查 / 打包
POST /api/convert               # 输入源：upload | job | workspace
POST /api/assets/inspect
POST /api/assets/rename-plan    # 只给建议名，不改动任何文件
POST /api/packages

# 一键全链路：生成 → 转换 → 质检 → 打包
POST /api/pipeline/delivery

# 任务
GET  /api/jobs?status=&kind=&keyword=
GET  /api/jobs/:id
GET  /api/jobs/:id/events       # SSE：snapshot / progress / artifact / log / finished
POST /api/jobs/:id/cancel
POST /api/jobs/:id/retry        # 按原参数重跑

# 提供方
GET  /api/providers
POST /api/providers/health
POST /api/providers/test
PATCH /api/providers/config     # 热更新，无需重启
```

**三种输入源**让每一步都能消费上一步的产物，链式与独立使用皆可：

| `source` | 含义 |
| --- | --- |
| `upload` | 本次请求上传的文件（multipart，流式落盘） |
| `job` | 指定历史任务的产物（`jobIds: []`） |
| `workspace` | 工作区目录下的已落盘资产（`subdir` / `keyword` / `extensions`） |

---

## 六、工程实现要点

**并发与可靠性**

- 双重并发上限：全局 + 每提供方独立（本地 GPU 串行、云端 API 并行）。
- 队列准入控制：超限直接回 `E_LIMIT_QUEUE_FULL`，不无限堆积吃内存。
- 出队前检查取消标记，排队期间被取消的任务不会白占算力。
- 单点收口：任何异常都落到任务终态并广播，绝不留下僵尸 `running`。
- 任务历史落盘（延迟合并刷盘），进程重启会把未完成任务标记为「被中断」而非继续假装运行。
- 优雅关闭：拒绝新任务 → 取消排队任务 → 等在执行任务收尾 → 刷盘。

**安全与隔离**

- 文件预览接口只允许访问 `outputs/`、`packages/`、`uploads/` 三个根，并做路径越界校验（403）。
- 对外**从不返回服务器绝对路径**，统一转换为「相对工作区根」的路径。
- 配置里的密钥只以 `env:VAR` 形式落盘，回显一律掩码（`****abcd`）。
- 可选的 Bearer 令牌鉴权 + 滑动窗口限流（默认 600 req/10s）。

**健壮性（实测踩到并已修复的真问题）**

- 客户端下载大文件时中途断开，会触发 `Premature close`；若此时错误处理再去写已发送的响应头，会导致
  `ERR_HTTP_HEADERS_SENT` 并**直接压垮整个进程**。现在把客户端断开识别为正常情况（仅销毁连接），
  并在写响应前检查 `headersSent`；另加进程级兜底，单请求异常不再拖垮正在跑的批量任务。
- `hidden` 属性会被组件自身的 `display:flex` 覆盖，导致深色遮罩**永远盖住整个页面**。
  已加 `[hidden] { display: none !important; }` 统一收口。
- 命名模板解析曾经用宽松的 `.+?` 做 token 字符类，导致 `icon_ui_icon_fire_normal_512x512`
  被解析成 `name=ui`、`w=fire_normal_512` 并报出误导性字段错误。现在从 `tokenRules` 推导字符类，
  要么精确匹配、要么如实报「不符合模板」。
- 校验时先把扩展名剥掉再去匹配含 `{ext}` 的模板，导致**任何文件名都匹配失败**；已修正为优先用完整文件名匹配。
- 感知去重原先只用 8×8 dHash 汉明距离，对纯色/平滑渐变类美术素材过于敏感：12 个资产误报 25 对重复。
  改为「16×16 灰度指纹平均绝对差」为主判据后收敛到 **2 对**（且正好是真重复），噪声警告从 23 条降到 1 条。

---

## 七、验证

```bash
npm run smoke           # 端到端 60 项断言
node scripts/shots.mjs  # 可选：渲染控制台各视图截图
```

`npm run smoke` 覆盖：

| # | 组 | 断言要点 |
| --- | --- | --- |
| 0 | 服务与元信息 | 提供方 6 个、错误码 42 个、规范集 4 套 |
| 1 | 提供方健康检查 | mock 连通；未配置密钥的云端提供方被如实判为不可用 |
| 2 | 批量生成 | 12 张全部落盘、命名 100% 符合规范模板、自动质检均分 100 |
| 3 | 格式转换 | 消费上一步产物、全部 webp、体积变化统计 |
| 4 | 资产检查 | 检出禁用词 / 空白图 / 尺寸过小 / 重复资产 |
| 5 | 打包交付 | 12 项入包、sha256、manifest + 报告 + 校验清单、ZIP 魔数与字节数一致 |
| 6 | 一键全链路 | 四阶段均执行、交付包产出 |
| 7 | 错误路径 | 未知提供方 / 空提示词 / 超批次上限 / 任务不存在 / 无上传文件 / 未知路由 / 无密钥提供方 / 配置热更新 |
| 8 | 命名规范 | 合规/不合规判定 + 修复建议名 |
| 9 | SSE | snapshot / progress / artifact / finished 全事件到达 |
| 10 | 任务控制 | 排队中取消、终态一致、按原参数重跑 |

当前结果：**60 / 60 通过**，服务日志 0 条 ERROR；演示模式（`AIART_DEMO=1`）下同样 60 / 60。
另有 `npm run privacy-check`：**26 个接口 / 4796 个字符串值，零绝对路径泄漏**。

---

## 八、目录结构

```
ai-art-studio/
├── server/
│   ├── index.js                  服务入口：配置 → 日志 → 恢复任务 → 适配器 → 路由 → 优雅关闭
│   ├── core/                     config 配置中心 · errors 错误码 · response 信封 · logger trace
│   │                             httpclient 出站客户端 · queue 并发队列 · store 任务仓库 · router 路由
│   ├── adapters/                 6 个提供方适配器 + 注册中心（统一 generate 入口）
│   ├── pipeline/                 naming · convert · generate · inspect · pack · report
│   ├── routes/                   system · jobs · pipeline · inputs
│   └── util/
├── web/                          index.html · styles.css · app.js（无框架、无 CDN）
├── scripts/                      seed.js 样例资产 · smoke.js 端到端验收 · shots.mjs 截图
├── config/                       default.json（可编辑，含端口 / 队列 / 提供方；密钥用 env: 引用）
└── workspace/                    运行时数据：uploads / outputs / packages / reports / logs / jobs.json
```

## 九、配置

三层覆盖，后层覆盖前层：`代码内置默认值` → `config/default.json` → `环境变量`。

`config/default.json` 是**本地文件、已在 `.gitignore` 中**（因为提供方密钥可能写在这里）。
仓库只提供 `config/default.example.json`；需要改端口/队列/提供方时：

```bash
cp config/default.example.json config/default.json
```

之后也可以在控制台「AI 提供方」页直接改，服务端会热更新并自动写回该文件（无需重启）。

```bash
AIART_PORT=8848                  # 监听端口
AIART_HOST=127.0.0.1
AIART_CONCURRENCY=3              # 全局并发上限
AIART_ACTIVE_PROVIDER=local-mock # 默认提供方
AIART_LOG_LEVEL=debug
AIART_AUTH_TOKEN=                # 设置后所有 /api 需带 Bearer 令牌
OPENAI_API_KEY=                  # 由 providers.definitions.openai-images.apiKey 以 env: 引用
DASHSCOPE_API_KEY=
ARK_API_KEY=
```

提供方配置可在控制台「AI 提供方」页直接改并热更新（baseUrl / apiKey / 超时 / 并发 / 启用状态），改动即时生效，无需重启。

---

## 十、部署为在线演示

本项目是**单端口 HTTP 服务**，且存储只用「JSON 文件 + 本地文件系统」（不需要 MySQL / Redis / MongoDB），
因此可以直接部署到任何支持 Node.js 单端口应用的托管平台。

平台侧只需注入一个环境变量：

```bash
PORT=3000        # 平台通行约定。设置后服务会自动监听 0.0.0.0:3000
```

监听地址的处理是刻意分开的：**没给 `PORT` 时只绑定 `127.0.0.1`**（本地开发不该意外暴露到局域网），
一旦给了 `PORT` 就自动放开到 `0.0.0.0`（否则反向代理访问不到）。也可以用 `AIART_HOST` 显式覆盖。

### 公开演示建议开启演示模式

```bash
AIART_DEMO=1 npm start
```

演示模式做三件事，避免把「本地运维工具」直接暴露到公网时的几个坑：

| 行为 | 说明 |
| --- | --- |
| 隐藏服务器目录结构 | `/api/config/paths` 只回工作区内的相对路径，不再回绝对路径 |
| 拒绝写入密钥 | `PATCH /api/providers/config` 携带 `apiKey` 会返回 `E_AUTH_FORBIDDEN`；防止访客把凭据写进宿主机配置 |
| 配置改动不落盘 | 启停/切换提供方仍然即时生效（访客能试），但重启后回到初始状态，不会污染后续访问者看到的内容 |

前端顶栏会显示「演示环境」标记。

### 出站脱敏：绝不泄漏服务器绝对路径

工具集内部到处用绝对路径（产物落盘位置、输出目录、产物包位置），但**这些不该出现在任何 HTTP 响应里**。
处理方式不是在每个路由挑字段（漏一个就出事），而是在响应出口统一过滤：
`server/core/sanitize.js` 会深拷贝并剔除「值本身是绝对路径」的字段，相对路径（`relPath` / `workspacePath`）照常保留，
新增路由天然安全。

这条性质是可回归验证的：

```bash
npm run privacy-check                              # 本地实例
node scripts/privacy-check.mjs http://host:port    # 线上实例
```

它会扫全部只读接口（含任务详情与 SSE 事件流），先 `JSON.parse` 再**只对字符串值做锚定匹配**——
直接正则搜原始文本会误报（`http://127.0.0.1:7860` 里的 `p://` 会被当成 Windows 盘符路径）。
当前结果：**26 个接口 / 4796 个字符串值，零泄漏**。

---

## 十一、已知边界

- 任务历史与队列是**进程内**的（单机工具集定位）。要横向扩展需把 `core/queue.js` + `core/store.js` 换成外部队列与数据库，接口层无需改动。
- 未内置「按建议名批量重命名磁盘文件」的执行动作，只提供预演（`/api/assets/rename-plan`）。落地重命名建议走版本库或 CI，避免绕过审批的破坏性操作。
- 感知去重是同批内两两比较（O(n²)），单批 500 个文件量级无压力；更大规模应改为指纹分桶 + 近邻索引。
- 云端提供方（OpenAI / 通义万相 / 即梦）的适配器已按官方协议实现，但**未附带真实密钥**，因此默认处于禁用状态；启用前请在「AI 提供方」页填好密钥并先做一次连通测试。
