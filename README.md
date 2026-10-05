# 胶片冲洗参数库

面向黑白与彩色胶片冲洗者的本地参数管理工具。可以按乳剂批次登记胶片、记录显影液工作液寿命、编排冲洗配方，并把每次实冲温度、时间和样片结果沉淀为下一批次的修正依据。应用为纯前端单页应用，不需要后端服务或外部接口。

## Docker 一键启动

在项目根目录执行：

```bash
cp .env.example .env && docker compose up -d --build
```

停止服务：

```bash
docker compose down
```

## 技术栈

| 类别 | 技术 |
| --- | --- |
| 前端框架 | Vue 3 + TypeScript |
| 构建工具 | Vite 5 |
| UI 组件 | Element Plus |
| 状态管理 | Pinia |
| 路由 | Vue Router 4 |
| 本地数据 | Dexie 4 + IndexedDB |
| 容器 | Nginx Alpine + Docker Compose |

## 访问地址

浏览器打开：`http://localhost:21808`

如修改 `.env` 中的 `FRONTEND_PORT`，请使用修改后的端口。

## 本地开发方式

```bash
cd frontend
npm install
npm run dev
```

开发服务器默认地址为 `http://localhost:5173`。生产构建检查使用：

```bash
cd frontend
npm run build
```

## 目录结构

```text
.
├── docker-compose.yml
├── .env.example
├── README.md
└── frontend
    ├── Dockerfile
    ├── nginx.conf
    └── src
        ├── components/common   # 曲线、稀释、推拉标签与筛选组件
        ├── hooks               # 配方筛选与温度补偿
        ├── pages               # 五个业务页面
        ├── router              # 路由配置
        ├── stores              # 四类数据的 Pinia 状态与持久化动作
        ├── types               # 胶片、显影液、配方、冲洗记录模型
        └── utils               # Dexie 数据层、比例换算、JSON 导出
```

## 数据存储说明

- IndexedDB 数据库名：`gbfilmdev-db`
- Dexie `version(3)` 共六张表：`films`、`developers`、`recipes`、`runs`、`plans`、`planAttempts`。
- 胶片与显影液记录带 `reservations`（待确认占用明细）与 `version`（乐观锁版本号）。
- 数据保存在当前浏览器，不随容器重建而丢失；更换浏览器或清理站点数据前，可在顶部导航点击“导出数据”下载 JSON 备份。
- 所有新增和更新动作在写入 Dexie 前均会去除响应式代理，避免 `DataCloneError`。

## 排片两阶段占用与并发规则

多人在不同标签页同时排片时，余量不会被同一批次重复占用：

1. **排片（阶段一）**：`/plans` 新建排片，在一个 IndexedDB 读写事务内同时写入胶片批次与显影液工作液的预占用（`reservations`）。两个标签页同时提交同一乳剂批次或工作液时，写事务天然串行：先落地的计划占用成功，后到者基于最新占用重算，返回带「先落地排片号」的冲突列表，页面提示后改选其它可用资源。
2. **确认实冲（阶段二）**：点击“确认实冲”后，以卷为最小单位逐卷提交——每卷在独立事务内幂等生成正式冲洗记录（`runs.planId + itemKey` 去重），胶片账面余量实扣、显影液已冲卷数增加，并摘除对应预占用。
3. **保存中断恢复**：每次确认先落一份 `planAttempts` 尝试快照（已落地的 runId / itemKey）。中途失败只回滚当前卷，已落地记录不丢、未处理卷继续占用，计划转为「保存失败」；点击“恢复并重试”逐卷续做，不产生重复记录。重启 / 重开浏览器时 `ensureReconciled()` 会借 localStorage 跨页锁选一个标签页自动续做所有中断计划，并执行一次占用孤儿清扫。
4. **取消排片**：释放两类余量并删除快照；已实冲计划不可取消。
5. **跨标签页通知**：资源或计划落库后经 `BroadcastChannel`（`localStorage` storage 事件兜底）广播，其它标签页自动刷新余量；提交时还会校验打开表单时的 `version` 快照，过期则直接判冲突。

台账恒等式：正式记录卷数 = 胶片账面实扣卷数 = 显影液已冲卷数；`可排/可冲余量 = 账面余量 − 待确认占用`。

逻辑测试见 `frontend/scripts/`，运行 `cd frontend && npm test`：内联事务套件 7 个场景 + 基于真实 `src` 模块打包的重启恢复集成测试 2 个场景。

## 核心功能与路由表

| 路由 | 页面标题 | 核心功能 |
| --- | --- | --- |
| `/` | 参数速查台 | 按胶片、稀释比、推拉档检索参数，查看最近冲洗记录 |
| `/films` | 胶片型号与乳剂批次台账 | 登记乳剂批次，按画幅和有效期筛选，查看账面/已占用/可排余量 |
| `/developers` | 显影液配制与余量 | 登记工作液、换算容量、查看已占用与可冲卷数并标记报废 |
| `/recipes` | 配方表 | 编排配方，按胶片和稀释比筛选，改温度即时重算时间 |
| `/plans` | 待冲批次排片 | 排片占用两类余量、确认实冲、失败恢复重试、取消释放 |
| `/runs` | 冲洗记录与结果评价 | 只读正式实冲记录，查看补偿建议并回写配方注释 |

未匹配的路由会重定向到 `/`。
