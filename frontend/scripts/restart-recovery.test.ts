// 重启恢复集成测试（运行：先经 esbuild 打包，见 package.json 脚本）
import 'fake-indexeddb/auto'
import { strict as assert } from 'node:assert'

const memoryStorage = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (key: string) => (memoryStorage.has(key) ? memoryStorage.get(key)! : null),
  setItem: (key: string, value: string) => void memoryStorage.set(key, String(value)),
  removeItem: (key: string) => void memoryStorage.delete(key)
}
;(globalThis as any).BroadcastChannel = class {
  postMessage() {}
  addEventListener() {}
  removeEventListener() {}
}

const mod = await import('./.ledger-bundle.mjs')
const { db, reservePlan, confirmPlan, reconcilePlans, armConfirmationFailure, availableRollsFor, availableDeveloperRolls } = mod

await db.open()
// 使用真实 src 数据库：清掉业务表，避免种子数据与本测试的资源重叠
await Promise.all([db.runs.clear(), db.plans.clear(), db.planAttempts.clear()])
await db.films.clear()
await db.developers.clear()
await db.recipes.clear()
await db.films.bulkAdd([
  { id: 1, model: 'GP3', format: '135', boxIso: 100, realIso: 100, emulsionNo: 'GP3-T1', expireDate: '2027-01-01', rollsLeft: 3, reservations: [], version: 0, schemaRev: 3 },
  { id: 2, model: 'HP5', format: '135', boxIso: 400, realIso: 400, emulsionNo: 'HP5-T2', expireDate: '2027-01-01', rollsLeft: 10, reservations: [], version: 0, schemaRev: 3 }
])
await db.developers.bulkAdd([
  { id: 1, name: 'D76-T', category: 'D-76', dilution: '1:1', volumeMl: 1000, mixedAt: '2026-10-01', maxRolls: 8, usedRolls: 0, state: '在用', reservations: [], version: 0, schemaRev: 3 },
  { id: 2, name: 'HC110-T', category: 'HC-110', dilution: '1:3', volumeMl: 1000, mixedAt: '2026-10-01', maxRolls: 16, usedRolls: 0, state: '在用', reservations: [], version: 0, schemaRev: 3 }
])
await db.recipes.bulkAdd([
  { id: 1, filmId: 1, developerId: 1, dilution: '1:1', tempC: 20, devMinutes: 9, agitation: '', stopBath: '', fixer: '', washMinutes: 10, pushPull: 'N', schemaRev: 3 },
  { id: 2, filmId: 2, developerId: 2, dilution: '1:3', tempC: 20, devMinutes: 7.5, agitation: '', stopBath: '', fixer: '', washMinutes: 10, pushPull: 'N', schemaRev: 3 }
])

let passed = 0
async function test(name: string, fn: () => Promise<void>): Promise<void> {
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

console.log('重启恢复集成测试（真实 src 模块）')

await test('中断的确认在“重启”后自动续做且不重复', async () => {
  const planNo = 'P-RESTART-01'
  const items = [1, 2, 3, 4].map((index) => ({
    itemKey: `${planNo}-${String(index).padStart(2, '0')}`,
    filmId: 2,
    filmLabel: 'HP5 135',
    developerId: 2,
    developerLabel: 'HC-110',
    recipeId: 2,
    rollCount: 1,
    pushPull: 'N'
  }))
  const film2 = await db.films.get(2)
  film2.rollsLeft = 10
  await db.films.put({ ...film2 })

  const reserved = await reservePlan(db, {
    planNo,
    tankType: '双联罐',
    runDate: '2026-10-05',
    actualTempC: 20,
    actualMinutes: 7.5,
    result: '重启恢复演练',
    items
  })
  assert.equal(reserved.status, 'ok')
  const planId = reserved.plan.id as number

  armConfirmationFailure(planId, 2)
  await assert.rejects(() => confirmPlan(db, planId))

  const stuck = await db.plans.get(planId)
  assert.equal(stuck.status, '保存失败')
  assert.equal(await db.runs.where('planId').equals(planId).count(), 2)

  // 模拟重启：仅调用对账入口
  await reconcilePlans(db)

  const healed = await db.plans.get(planId)
  assert.equal(healed.status, '已实冲', '重启后自动续做完成')
  const runs = await db.runs.where('planId').equals(planId).toArray()
  assert.equal(runs.length, 4, '无重复正式记录')
  assert.equal(new Set(runs.map((r: { itemKey: string }) => r.itemKey)).size, 4)
  assert.equal(await db.planAttempts.where('planId').equals(planId).count(), 0, '续做完成后快照被清')

  const film = await db.films.get(2)
  const dev = await db.developers.get(2)
  assert.equal(film.rollsLeft, 6, '账面实扣 4 卷')
  assert.equal(film.reservations.length, 0)
  assert.equal(dev.usedRolls, 4)
  assert.equal(dev.reservations.length, 0)
  assert.equal(availableRollsFor(film), 6)
  assert.equal(availableDeveloperRolls(dev), 12)
})

await test('待确认但未开始确认的计划，重启后仍保持占用', async () => {
  const items = [{
    itemKey: 'P-KEEP-01',
    filmId: 1,
    filmLabel: 'GP3 135',
    developerId: 1,
    developerLabel: 'D76',
    recipeId: 1,
    rollCount: 1,
    pushPull: 'N'
  }]
  const reserved = await reservePlan(db, {
    planNo: 'P-KEEP',
    tankType: '深罐',
    runDate: '2026-10-05',
    actualTempC: 20,
    actualMinutes: 9,
    result: '',
    items
  })
  assert.equal(reserved.status, 'ok')
  await reconcilePlans(db)
  const kept = await db.plans.where('planNo').equals('P-KEEP').first()
  assert.equal(kept.status, '待确认', '没有确认快照的计划不被自动实冲')
  assert.equal((await db.films.get(1)).reservations.length, 1, '占用保留')
})

console.log(`\n${passed} 个场景通过`)
if (process.exitCode) process.exit(1)
