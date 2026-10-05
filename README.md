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
- Dexie 版本：`version(1)` 创建 `films`、`developers`、`recipes`、`runs` 四张表并建立常用查询索引。
- 迁移：`version(2).upgrade(...)` 为已有记录回填 `schemaRev: 2`。`version(3)` 新增待冲排片能力：
  - 新增 `plans` 表（待冲批次计划：`reserved / interrupted / confirmed / released`）；
  - 胶片增加 `rollsTotal`（账面总量）、`reservedRolls`（占用）、`revision`（乐观锁）；
  - 显影液增加 `baselineUsedRolls`（v2 手工实冲基线）、`reservedRolls`、`revision`，`usedRolls` 只统计经计划确认的实冲；
  - 首次打开数据库时通过 `populate` 写入丰富的胶片、显影液、配方和实冲记录。
- 数据保存在当前浏览器，不随容器重建而丢失；更换浏览器或清理站点数据前，可在顶部导航点击“导出数据”下载 JSON 备份。
- 所有新增和更新动作在写入 Dexie 前均会去除响应式代理，避免 `DataCloneError`。

## 待冲批次排片（多人多标签页）

`/plans` 页面实现了两阶段占用与崩溃恢复：

1. **排片先占用**：提交待冲批次时，在同一个 IndexedDB `readwrite` 事务内原子扣减胶片 `rollsLeft`、增加显影液 `reservedRolls` 并写入计划，事务要么全部成功要么整体回滚，不会留下半截占用。
2. **确认实冲转正**：确认后单事务内把占用转成正式实冲记录（显影液 `usedRolls +n`、生成 `runs` 记录、计划归档 `confirmed`）。
3. **保存失败可恢复/重试**：页面提供「注入保存故障」开关模拟确认实冲时掉电——计划留在 `interrupted`、占用保留，可填写结果「重试保存」或「恢复占用」释放余量。
4. **多标签页并发**：每个资源带 `revision` 乐观锁；两个标签页同时提交同一乳剂批次或工作液时，IndexedDB 重叠事务按落地顺序串行化，后到者读到新版本后冲突失败（`PlanConflictError`），刷新后重选可用资源即可。变更通过 `BroadcastChannel` 广播，其他标签页即时刷新。
5. **重启恢复**：应用启动时扫描 `stage='saving'` 的计划（崩溃在确认事务途中），自动释放其占用；`reserving` 阶段与占用同事务，崩溃即无痕。
6. **对账**：`reconcile()` 校验不变量
   - 胶片：`rollsTotal = rollsLeft + reservedRolls + Σ已确认计划卷数`
   - 显影液：`maxRolls = 历史基线 + usedRolls + reservedRolls + 空闲可冲`
   排片页启动时自动对账，也可手动重新对账。

### 自动化测试

```bash
cd frontend
npm test        # vitest + fake-indexeddb：原子占用、确认、失败恢复、N 标签页竞争、重启恢复、对账
```

## 核心功能与路由表

| 路由 | 页面标题 | 核心功能 |
| --- | --- | --- |
| `/` | 参数速查台 | 按胶片、稀释比、推拉档检索参数，查看最近冲洗记录 |
| `/plans` | 待冲批次排片 | 两阶段占用胶片/显影液、确认实冲、失败重试与释放、并发冲突提示、重启恢复与台账对账 |
| `/films` | 胶片型号与乳剂批次台账 | 登记乳剂批次，按画幅和有效期筛选，观察余量与待冲占用 |
| `/developers` | 显影液配制与余量 | 登记工作液、换算容量、查看剩余可冲卷数（含占用）并标记报废 |
| `/recipes` | 配方表 | 编排配方，按胶片和稀释比筛选，改温度即时重算时间 |
| `/runs` | 冲洗记录与结果评价 | 录入实冲温度与时间，查看补偿建议并回写配方注释 |

未匹配的路由会重定向到 `/`。
