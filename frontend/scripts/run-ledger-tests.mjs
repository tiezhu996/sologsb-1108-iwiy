/* eslint-disable no-console */
// 排片两阶段占用的逻辑测试，运行：node scripts/run-ledger-tests.mjs
import 'fake-indexeddb/auto'
import { strict as assert } from 'node:assert'
import Dexie from 'dexie'

// ---- Node 环境垫片：localStorage（跨页锁）与 BroadcastChannel ----
const memoryStorage = new Map()
globalThis.localStorage = {
  getItem: (key) => (memoryStorage.has(key) ? memoryStorage.get(key) : null),
  setItem: (key, value) => void memoryStorage.set(key, String(value)),
  removeItem: (key) => void memoryStorage.delete(key)
}
globalThis.BroadcastChannel = class {
  constructor() {}
  postMessage() {}
  addEventListener() {}
  removeEventListener() {}
}

// ---- 内联被测模块（与 src 中实现保持同步的最小同构副本，避免 .vue 依赖）----
class PlanConflictError extends Error {
  constructor(conflicts) {
    super(conflicts[0] ? `${conflicts[0].resourceLabel} 冲突` : '资源冲突')
    this.name = 'PlanConflictError'
    this.conflicts = conflicts
  }
}

const plain = (value) => JSON.parse(JSON.stringify(value))
const nowStamp = () => new Date().toISOString()
const failureHooks = new Map()

class TestDatabase extends Dexie {
  constructor() {
    super('gbfilmdev-test')
    this.version(1).stores({
      films: '++id, model, format, expireDate, rollsLeft',
      developers: '++id, category, state, mixedAt',
      recipes: '++id, filmId, developerId',
      runs: '++id, recipeId, runDate, tankType, planId, itemKey',
      plans: '++id, planNo, status, runDate, updatedAt',
      planAttempts: '[planId+attempt], planId, updatedAt'
    })
  }
}

const db = new TestDatabase()
const availableFilm = (film) => Math.max(0, film.rollsLeft - (film.reservations ?? []).reduce((s, l) => s + l.amount, 0))
const availableDev = (dev) => Math.max(0, dev.maxRolls - dev.usedRolls - (dev.reservations ?? []).reduce((s, l) => s + l.amount, 0))

await db.open()
await db.films.bulkAdd([
  { id: 1, model: 'GP3', rollsLeft: 3, reservations: [], version: 0 },
  { id: 2, model: 'HP5', rollsLeft: 10, reservations: [], version: 0 },
  { id: 3, model: 'Portra', rollsLeft: 6, reservations: [], version: 0 }
])
await db.developers.bulkAdd([
  { id: 1, name: 'D76-A', maxRolls: 8, usedRolls: 0, state: '在用', reservations: [], version: 0 },
  { id: 2, name: 'HC110', maxRolls: 4, usedRolls: 0, state: '在用', reservations: [], version: 0 },
  { id: 3, name: 'C41', maxRolls: 10, usedRolls: 0, state: '在用', reservations: [], version: 0 }
])
await db.recipes.bulkAdd([
  { id: 1, filmId: 1, developerId: 1 },
  { id: 2, filmId: 2, developerId: 2 },
  { id: 3, filmId: 3, developerId: 3 }
])

function makeItem(planNo, index, filmId, developerId, recipeId) {
  return {
    itemKey: `${planNo}-${String(index).padStart(2, '0')}`,
    filmId, filmLabel: `film${filmId}`, developerId, developerLabel: `dev${developerId}`,
    recipeId, rollCount: 1, pushPull: 'N'
  }
}

async function reserve(input) {
  try {
    return await db.transaction('rw', db.plans, db.films, db.developers, async () => {
      const duplicate = await db.plans.where('planNo').equals(input.planNo).first()
      if (duplicate) return { status: 'duplicate', planNo: input.planNo }

      const planId = await db.plans.add(plain({
        planNo: input.planNo, status: '待确认', tankType: '双联罐', runDate: '2026-10-05',
        actualTempC: 20, actualMinutes: 9, result: '', items: plain(input.items), runIds: [],
        createdAt: nowStamp(), updatedAt: nowStamp(), schemaRev: 3
      }))

      const demand = { films: new Map(), developers: new Map() }
      for (const item of input.items) {
        demand.films.set(item.filmId, (demand.films.get(item.filmId) ?? 0) + item.rollCount)
        demand.developers.set(item.developerId, (demand.developers.get(item.developerId) ?? 0) + item.rollCount)
      }
      const allPlans = await db.plans.toArray()
      const planNoMap = new Map(allPlans.map((p) => [p.id, p.planNo]))
      const conflicts = []

      for (const [filmId, requested] of demand.films) {
        const film = await db.films.get(filmId)
        const avail = availableFilm(film)
        if (avail < requested) {
          const blocker = (film.reservations ?? []).find((l) => l.planId !== planId)
          conflicts.push({ type: 'film', resourceId: filmId, resourceLabel: film.model, available: avail, requested, blockedByPlan: blocker ? planNoMap.get(blocker.planId) : '其它排片' })
        }
      }
      for (const [developerId, requested] of demand.developers) {
        const dev = await db.developers.get(developerId)
        const avail = availableDev(dev)
        if (avail < requested) {
          const blocker = (dev.reservations ?? []).find((l) => l.planId !== planId)
          conflicts.push({ type: 'developer', resourceId: developerId, resourceLabel: dev.name, available: avail, requested, blockedByPlan: blocker ? planNoMap.get(blocker.planId) : '其它排片' })
        }
      }
      if (conflicts.length) throw new PlanConflictError(conflicts)

      for (const filmId of new Set(input.items.map((i) => i.filmId))) {
        const film = await db.films.get(filmId)
        for (const item of input.items.filter((i) => i.filmId === filmId)) {
          film.reservations.push({ planId, itemKey: item.itemKey, amount: item.rollCount, rollLabel: item.filmLabel, createdAt: nowStamp() })
        }
        film.version += 1
        await db.films.put(plain(film))
      }
      for (const developerId of new Set(input.items.map((i) => i.developerId))) {
        const dev = await db.developers.get(developerId)
        for (const item of input.items.filter((i) => i.developerId === developerId)) {
          dev.reservations.push({ planId, itemKey: item.itemKey, amount: item.rollCount, rollLabel: item.developerLabel, createdAt: nowStamp() })
        }
        dev.version += 1
        await db.developers.put(plain(dev))
      }
      return { status: 'ok', plan: await db.plans.get(planId) }
    })
  } catch (error) {
    if (error instanceof PlanConflictError) return { status: 'conflict', conflicts: error.conflicts }
    const cause = error?.cause
    if (cause instanceof PlanConflictError) return { status: 'conflict', conflicts: cause.conflicts }
    throw error
  }
}

async function latestAttempt(planId) {
  const list = await db.planAttempts.where('planId').equals(planId).toArray()
  return list.sort((a, b) => b.attempt - a.attempt)[0]
}

async function confirm(planId, overrides = {}) {
  await db.transaction('rw', db.plans, db.planAttempts, async () => {
    const plan = await db.plans.get(planId)
    if (!plan) throw new Error('排片计划不存在')
    if (plan.status === '已取消') throw new Error('计划已取消')
    if (plan.status === '已实冲') return
    const previous = await latestAttempt(planId)
    const snapshot = {
      planId,
      attempt: (previous?.attempt ?? 0) + 1,
      planNo: plan.planNo, tankType: plan.tankType, runDate: plan.runDate,
      actualTempC: overrides.actualTempC ?? previous?.actualTempC ?? plan.actualTempC,
      actualMinutes: overrides.actualMinutes ?? previous?.actualMinutes ?? plan.actualMinutes,
      result: overrides.result ?? previous?.result ?? plan.result,
      items: plain(plan.items),
      createdRunIds: previous?.createdRunIds ?? [],
      consumedItemKeys: previous?.consumedItemKeys ?? [],
      updatedAt: nowStamp()
    }
    plan.actualTempC = snapshot.actualTempC
    plan.actualMinutes = snapshot.actualMinutes
    plan.result = snapshot.result
    plan.updatedAt = nowStamp()
    await db.plans.put(plain(plan))
    await db.planAttempts.put(plain(snapshot))
  })

  const initialPlan = await db.plans.get(planId)
  if (initialPlan.status === '已实冲') return initialPlan

  let attempt = await latestAttempt(planId)
  let processed = attempt.consumedItemKeys.length
  const hook = failureHooks.get(planId)

  try {
    for (const item of initialPlan.items) {
      if (attempt.consumedItemKeys.includes(item.itemKey)) continue
      const current = await db.plans.get(planId)
      await db.transaction('rw', db.runs, db.films, db.developers, db.planAttempts, async () => {
        const existing = await db.runs.where('itemKey').equals(item.itemKey).first()
        let runId = existing?.id
        if (runId === undefined) {
          runId = await db.runs.add(plain({
            batchNo: current.planNo, recipeId: item.recipeId,
            actualTempC: attempt.actualTempC, actualMinutes: attempt.actualMinutes,
            tankType: attempt.tankType, runDate: attempt.runDate, result: attempt.result,
            planId, itemKey: item.itemKey, schemaRev: 3
          }))
        }
        const film = await db.films.get(item.filmId)
        if (film) {
          const own = (film.reservations ?? []).find((l) => l.itemKey === item.itemKey && l.planId === planId)
          if (own) film.rollsLeft = Math.max(0, film.rollsLeft - own.amount)
          film.reservations = (film.reservations ?? []).filter((l) => !(l.itemKey === item.itemKey && l.planId === planId))
          film.version += 1
          await db.films.put(plain(film))
        }
        const dev = await db.developers.get(item.developerId)
        if (dev) {
          dev.reservations = (dev.reservations ?? []).filter((l) => !(l.itemKey === item.itemKey && l.planId === planId))
          dev.usedRolls += item.rollCount
          if (dev.state === '新配') dev.state = '在用'
          dev.version += 1
          await db.developers.put(plain(dev))
        }
        if (!attempt.createdRunIds.includes(runId)) attempt.createdRunIds.push(runId)
        if (!attempt.consumedItemKeys.includes(item.itemKey)) attempt.consumedItemKeys.push(item.itemKey)
        attempt.updatedAt = nowStamp()
        await db.planAttempts.put(plain(attempt))
      })
      processed += 1
      attempt = await latestAttempt(planId)
      if (hook && processed === hook.afterItems) throw new Error(hook.message)
    }
  } catch (error) {
    const ongoing = await db.plans.get(planId)
    ongoing.status = '保存失败'
    ongoing.lastError = error.message
    ongoing.updatedAt = nowStamp()
    await db.plans.put(plain(ongoing))
    failureHooks.delete(planId)
    throw error
  }

  return db.transaction('rw', db.plans, db.planAttempts, db.runs, async () => {
    const plan = await db.plans.get(planId)
    plan.status = '已实冲'
    plan.runIds = (await db.runs.where('planId').equals(planId).toArray()).map((r) => r.id).sort((a, b) => a - b)
    plan.lastError = undefined
    plan.updatedAt = nowStamp()
    await db.plans.put(plain(plan))
    await db.planAttempts.where('planId').equals(planId).delete()
    return plan
  })
}

async function cancel(planId) {
  await db.transaction('rw', db.plans, db.films, db.developers, db.planAttempts, async () => {
    const plan = await db.plans.get(planId)
    if (!plan || plan.status === '已取消') return
    if (plan.status === '已实冲') throw new Error('已实冲不能取消')
    for (const film of await db.films.toArray()) {
      const next = (film.reservations ?? []).filter((l) => l.planId !== planId)
      if (next.length !== (film.reservations ?? []).length) {
        film.reservations = next
        film.version += 1
        await db.films.put(plain(film))
      }
    }
    for (const dev of await db.developers.toArray()) {
      const next = (dev.reservations ?? []).filter((l) => l.planId !== planId)
      if (next.length !== (dev.reservations ?? []).length) {
        dev.reservations = next
        dev.version += 1
        await db.developers.put(plain(dev))
      }
    }
    plan.status = '已取消'
    plan.updatedAt = nowStamp()
    await db.plans.put(plain(plan))
    await db.planAttempts.where('planId').equals(planId).delete()
  })
}

// ---- 断言辅助 ----
let passed = 0
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

console.log('排片两阶段占用测试')

await test('场景1：排片原子占用两类余量', async () => {
  const items = [makeItem('P-A', 1, 1, 1, 1), makeItem('P-A', 2, 1, 1, 1)]
  const result = await reserve({ planNo: 'P-A', items })
  assert.equal(result.status, 'ok')
  assert.equal(result.plan.status, '待确认')

  const film = await db.films.get(1)
  const dev = await db.developers.get(1)
  assert.equal(availableFilm(film), 1, '胶片账面 3 − 占用 2 = 可排 1')
  assert.equal(availableDev(dev), 6, '显影液 8 − 占用 2 = 可冲 6')
  assert.equal(film.reservations.length, 2)
  assert.equal(dev.reservations.length, 2)
})

await test('场景2：并发只认先落地，后者收到冲突且不留垃圾', async () => {
  // dev2 可冲 4 卷；A 抢 3 卷后只剩 1，B 再要 3 卷必须失败
  const itemsA = [makeItem('P-B-A', 1, 2, 2, 2), makeItem('P-B-A', 2, 2, 2, 2), makeItem('P-B-A', 3, 2, 2, 2)]
  const itemsB = [makeItem('P-B-B', 1, 2, 2, 2), makeItem('P-B-B', 2, 2, 2, 2), makeItem('P-B-B', 3, 2, 2, 2)]
  const [first, second] = await Promise.all([
    reserve({ planNo: 'P-B-A', items: itemsA }),
    // 人为拉开极小间隔，保证落地顺序确定
    new Promise((resolve) => setTimeout(() => reserve({ planNo: 'P-B-B', items: itemsB }).then(resolve), 5))
  ])
  assert.equal(first.status, 'ok')
  assert.equal(second.status, 'conflict')
  const conflict = second.conflicts.find((c) => c.type === 'developer')
  assert.ok(conflict, '冲突点在显影液工作液')
  assert.equal(conflict.available, 1)
  assert.equal(conflict.requested, 3)
  assert.equal(conflict.blockedByPlan, 'P-B-A', '冲突里指明先落地的排片号')

  // 失败事务完全回滚：没有残留计划、占用、版本号不被污染
  const dev = await db.developers.get(2)
  assert.equal(dev.reservations.length, 3)
  assert.equal(dev.version, 1)
  assert.equal(await db.plans.where('planNo').equals('P-B-B').count(), 0)
  assert.equal(await db.planAttempts.count(), 0)
})

await test('场景3：确认实冲转正式记录，胶片与显影液同时出账', async () => {
  const plan = await db.plans.where('planNo').equals('P-A').first()
  await confirm(plan.id, { result: '密度均匀' })

  const runs = await db.runs.where('planId').equals(plan.id).toArray()
  assert.equal(runs.length, 2, '每卷一条正式记录')
  assert.ok(runs.every((r) => r.result === '密度均匀'))
  assert.ok(runs.every((r) => typeof r.itemKey === 'string'))

  const film = await db.films.get(1)
  const dev = await db.developers.get(1)
  assert.equal(film.rollsLeft, 1, '胶片账面实扣 2 卷')
  assert.equal(film.reservations.length, 0, '占用全部摘除')
  assert.equal(dev.usedRolls, 2, '显影液已冲 +2')
  assert.equal(dev.reservations.length, 0)
  assert.equal(availableFilm(film), 1)
  assert.equal(availableDev(dev), 6)
  assert.equal(await db.planAttempts.where('planId').equals(plan.id).count(), 0, '确认后快照清掉')
  assert.equal((await db.plans.get(plan.id)).status, '已实冲')
})

await test('场景4：确认中途中断，保留占用；重试幂等续做完成', async () => {
  const items = [makeItem('P-C', 1, 3, 3, 3), makeItem('P-C', 2, 3, 3, 3), makeItem('P-C', 3, 3, 3, 3)]
  const result = await reserve({ planNo: 'P-C', items })
  assert.equal(result.status, 'ok')
  const planId = result.plan.id
  failureHooks.set(planId, { afterItems: 2, message: '台账写入中断' })

  await assert.rejects(() => confirm(planId), /台账写入中断/)

  // 半截状态：2 条正式记录已落地，第 3 卷占用仍在
  let runs = await db.runs.where('planId').equals(planId).toArray()
  assert.equal(runs.length, 2)
  const dev = await db.developers.get(3)
  assert.equal(dev.usedRolls, 2)
  assert.equal(dev.reservations.length, 1, '未完成卷保留显影液占用')
  const film = await db.films.get(3)
  assert.equal(film.rollsLeft, 4, '已冲 2 卷实扣，未冲卷不动账面')
  assert.equal(film.reservations.length, 1)
  const stuck = await db.plans.get(planId)
  assert.equal(stuck.status, '保存失败')
  assert.match(stuck.lastError, /台账写入中断/)
  assert.ok(await latestAttempt(planId), '尝试快照保留')

  // 重试：已落地卷不重复，只续做剩余卷
  const done = await confirm(planId)
  assert.equal(done.status, '已实冲')
  runs = await db.runs.where('planId').equals(planId).toArray()
  assert.equal(runs.length, 3, '总共仍是 3 条，不产生重复记录')
  assert.equal(new Set(runs.map((r) => r.itemKey)).size, 3)
  assert.equal((await db.developers.get(3)).usedRolls, 3)
  assert.equal((await db.developers.get(3)).reservations.length, 0)
  assert.equal((await db.films.get(3)).rollsLeft, 3, '6 − 实冲 3')
  assert.equal((await db.films.get(3)).reservations.length, 0)
})

await test('场景5：取消待确认计划释放全部占用，已实冲不可取消', async () => {
  const planA = await db.plans.where('planNo').equals('P-B-A').first()
  const before = availableDev(await db.developers.get(2))
  await cancel(planA.id)
  const dev = await db.developers.get(2)
  assert.equal(dev.reservations.length, 0)
  assert.equal(availableDev(dev), before + 3)
  assert.equal((await db.plans.get(planA.id)).status, '已取消')
  const planC = await db.plans.where('planNo').equals('P-C').first()
  await assert.rejects(() => cancel(planC.id), /已实冲/)
})

await test('场景6：排片号重复被拒绝且不留任何占用', async () => {
  const beforeFilm = (await db.films.get(3)).reservations.length
  const beforeDev = (await db.developers.get(3)).reservations.length
  const result = await reserve({ planNo: 'P-C', items: [makeItem('P-DUP', 1, 3, 3, 3)] })
  assert.equal(result.status, 'duplicate')
  assert.equal((await db.films.get(3)).reservations.length, beforeFilm, '重复提交不占用胶片')
  assert.equal((await db.developers.get(3)).reservations.length, beforeDev, '重复提交不占用显影液')
  assert.equal(await db.plans.where('planNo').equals('P-C').count(), 1, '不会插入第二条同号计划')
})

await test('场景7：全链台账恒等式成立', async () => {
  // 终态：film1 实冲 2（P-A）；film2 实冲 0（P-B-A 已取消）；film3 实冲 3（P-C）
  const f1 = await db.films.get(1)
  const f2 = await db.films.get(2)
  const f3 = await db.films.get(3)
  const d1 = await db.developers.get(1)
  const d2 = await db.developers.get(2)
  const d3 = await db.developers.get(3)

  // 正式记录卷数 = 胶片实扣总量 = 显影液实冲总量
  const totalRuns = await db.runs.count()
  const filmConsumed = (3 - f1.rollsLeft) + (10 - f2.rollsLeft) + (6 - f3.rollsLeft)
  assert.equal(totalRuns, filmConsumed, '实冲记录数与胶片出账一致')
  assert.equal(d1.usedRolls + d2.usedRolls + d3.usedRolls, totalRuns, '显影液已冲合计等于记录数')
  // 无待确认计划时不应残留任何占用
  const pending = (await db.plans.toArray()).filter((p) => p.status === '待确认' || p.status === '保存失败')
  assert.equal(pending.length, 0)
  assert.equal(f1.reservations.length + f2.reservations.length + f3.reservations.length, 0)
  assert.equal(d1.reservations.length + d2.reservations.length + d3.reservations.length, 0)
})

console.log(`\n${passed} 个场景通过`)
if (process.exitCode) console.error('存在失败用例')
else console.log('全部通过')
