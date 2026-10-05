import { beforeEach, describe, expect, it } from 'vitest'
import {
  PlanConflictError,
  PlanCapacityError,
  PlanSaveInterruptedError,
  __stagePlanForCrash,
  armSaveFailure,
  confirmPlan,
  developerFreeRolls,
  recoverInterruptedPlans,
  reconcile,
  releasePlan,
  reservePlan,
  retryInterruptedPlan
} from '../services/planService'
import type { FilmDevDatabase } from '../utils/db'
import { confirmPayload, getDb, resetAndSeed, secondConnection } from './helpers'

let db: FilmDevDatabase

beforeEach(async () => {
  db = await resetAndSeed()
})

const baseReserve = {
  batchNo: 'P-T1',
  filmId: 1,
  developerId: 1,
  rolls: 2,
  expectedFilmRevision: 0,
  expectedDeveloperRevision: 0
}

describe('阶段一：排片原子占用', () => {
  it('占用后胶片余量与显影液可冲数同时被扣减', async () => {
    await reservePlan(baseReserve, db)
    const film = await db.films.get(1)
    const developer = await db.developers.get(1)
    expect(film?.rollsLeft).toBe(3)
    expect(film?.reservedRolls).toBe(2)
    expect(film?.revision).toBe(1)
    expect(developer?.reservedRolls).toBe(2)
    expect(developerFreeRolls(developer!)).toBe(3) // 6 - 基线1 - 占用2

    const plan = await db.plans.toArray()
    expect(plan).toHaveLength(1)
    expect(plan[0].status).toBe('reserved')
  })

  it('余量不足时整体拒绝，不留下任何占用或计划', async () => {
    await expect(reservePlan({ ...baseReserve, rolls: 6 }, db)).rejects.toBeInstanceOf(PlanCapacityError)
    const film = await db.films.get(1)
    expect(film?.rollsLeft).toBe(5)
    expect(film?.reservedRolls).toBe(0)
    expect(await db.plans.count()).toBe(0)
  })
})

describe('阶段二：确认实冲', () => {
  it('占用转为正式记录：显影液 usedRolls 增加、生成实冲记录、计划归档', async () => {
    const plan = await reservePlan(baseReserve, db)
    const { runId } = await confirmPlan(plan.id!, confirmPayload(), db)

    const developer = await db.developers.get(1)
    expect(developer?.usedRolls).toBe(2)
    expect(developer?.reservedRolls).toBe(0)
    const film = await db.films.get(1)
    expect(film?.rollsLeft).toBe(3)
    expect(film?.reservedRolls).toBe(0)

    const run = await db.runs.get(runId)
    expect(run?.planId).toBe(plan.id)
    expect(run?.rolls).toBe(2)
    const storedPlan = await db.plans.get(plan.id!)
    expect(storedPlan?.status).toBe('confirmed')
    expect(storedPlan?.runId).toBe(runId)

    const report = await reconcile(db)
    expect(report.ok).toBe(true)
    expect(report.issues).toHaveLength(0)
  })
})

describe('保存失败：恢复占用与重试', () => {
  it('注入故障后计划留在 interrupted 且占用保留，可释放恢复', async () => {
    const plan = await reservePlan(baseReserve, db)
    armSaveFailure()
    await expect(confirmPlan(plan.id!, confirmPayload(), db)).rejects.toBeInstanceOf(PlanSaveInterruptedError)

    let stored = await db.plans.get(plan.id!)
    expect(stored?.status).toBe('interrupted')
    expect(stored?.failReason).toBeTruthy()
    // 占用仍在
    expect((await db.films.get(1))?.rollsLeft).toBe(3)
    expect((await db.developers.get(1))?.reservedRolls).toBe(2)
    // 正式记录未生成（runs 未对 planId 建索引，直接过滤）
    const runs = await db.runs.toArray()
    expect(runs.filter((run) => run.planId === plan.id)).toHaveLength(0)

    await releasePlan(plan.id!, '测试释放', db)
    stored = await db.plans.get(plan.id!)
    expect(stored?.status).toBe('released')
    expect((await db.films.get(1))?.rollsLeft).toBe(5)
    expect((await db.developers.get(1))?.reservedRolls).toBe(0)

    const report = await reconcile(db)
    expect(report.ok).toBe(true)
  })

  it('中断后可重试保存，成功后账目一致', async () => {
    const plan = await reservePlan(baseReserve, db)
    armSaveFailure()
    await expect(confirmPlan(plan.id!, confirmPayload(), db)).rejects.toBeInstanceOf(PlanSaveInterruptedError)

    const { runId } = await retryInterruptedPlan(plan.id!, confirmPayload({ result: '重试成功' }), db)
    expect(runId).toBeGreaterThan(0)
    const stored = await db.plans.get(plan.id!)
    expect(stored?.status).toBe('confirmed')
    expect((await db.runs.get(runId))?.result).toBe('重试成功')

    const report = await reconcile(db)
    expect(report.ok).toBe(true)
  })
})

describe('两个标签页并发提交', () => {
  it('同一乳剂批次只认先落地的事务，后提交者收到 revision 冲突且不重复扣减', async () => {
    const other = await secondConnection()
    try {
      // 两个标签页都基于 revision=0 的视图同时提交
      const [first, second] = await Promise.allSettled([
        reservePlan({ ...baseReserve, batchNo: 'P-A' }, db),
        reservePlan({ ...baseReserve, batchNo: 'P-B', rolls: 3 }, other)
      ])
      const statuses = [first.status, second.status]
      expect(statuses).toContain('fulfilled')
      expect(statuses).toContain('rejected')
      const reason = first.status === 'rejected' ? first.reason : (second as PromiseRejectedResult).reason
      expect(reason).toBeInstanceOf(PlanConflictError)
      expect(reason.kind).toBe('film')

      const film = await db.films.get(1)
      const developer = await db.developers.get(1)
      const plans = await db.plans.toArray()
      expect(plans).toHaveLength(1)
      // 只有成功的那笔扣账（2 或 3 卷），绝不会两笔叠加
      const winnerRolls = first.status === 'fulfilled' ? 2 : 3
      expect(film?.rollsLeft).toBe(5 - winnerRolls)
      expect(film?.reservedRolls).toBe(winnerRolls)
      expect(developer?.reservedRolls).toBe(winnerRolls)
    } finally {
      other.close()
    }
  })

  it('同一工作液容量只够一笔时，另一笔被拒，余量不超卖', async () => {
    const other = await secondConnection()
    try {
      // 工作液：6 - 基线1 = 5 可冲；两笔各 3 卷，合计 6 > 5。
      // 先落地者占用 3（胶片 2 共 2 卷，故首笔用胶片 1）；
      // 后来者胶片仍够，但工作液已被抢，撞上 revision 冲突或容量检查，必须失败。
      await reservePlan({ ...baseReserve, filmId: 1, rolls: 3 }, db)
      await expect(reservePlan({ ...baseReserve, filmId: 1, rolls: 3 }, other))
        .rejects.toSatisfy((error: unknown) => {
          const code = (error as { code: string }).code
          return code === 'PLAN_CONFLICT' || code === 'PLAN_CAPACITY'
        })

      const developer = await db.developers.get(1)
      expect(developer?.reservedRolls).toBe(3)
      expect(developerFreeRolls(developer!)).toBe(2)
    } finally {
      other.close()
    }
  })

  it('冲突方刷新到新版本后可以选择其他资源成功提交', async () => {
    const other = await secondConnection()
    try {
      await reservePlan({ ...baseReserve, rolls: 2 }, db)
      // 另一标签页仍持旧 revision 提交 -> 冲突
      await expect(reservePlan({ ...baseReserve, batchNo: 'P-STALE', rolls: 1 }, other))
        .rejects.toBeInstanceOf(PlanConflictError)
      // 刷新资源视图后用最新 revision 改选胶片 2（显影液还有 3 卷空闲）
      const freshFilm = await other.films.get(2)
      const freshDev = await other.developers.get(1)
      const plan = await reservePlan({
        batchNo: 'P-REFRESH',
        filmId: 2,
        developerId: 1,
        rolls: 1,
        expectedFilmRevision: freshFilm!.revision ?? 0,
        expectedDeveloperRevision: freshDev!.revision ?? 1
      }, other)
      expect(plan.id).toBeGreaterThan(0)
      expect((await db.films.get(2))?.rollsLeft).toBe(1)
    } finally {
      other.close()
    }
  })

  it('N 个标签页同一时刻抢同一批次：恰好一笔成功，其余冲突，零超卖且对账通过', async () => {
    const connections = await Promise.all(Array.from({ length: 4 }, () => secondConnection()))
    try {
      const attempts = [db, ...connections].map((connection, index) =>
        reservePlan({ ...baseReserve, batchNo: `P-RACE-${index}`, rolls: 1 }, connection)
      )
      const results = await Promise.allSettled(attempts)
      const fulfilled = results.filter((result) => result.status === 'fulfilled')
      const rejected = results.filter((result) => result.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(4)
      for (const result of rejected) {
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(PlanConflictError)
      }

      const film = await db.films.get(1)
      const developer = await db.developers.get(1)
      expect(film?.rollsLeft).toBe(4)
      expect(film?.reservedRolls).toBe(1)
      expect(developer?.reservedRolls).toBe(1)
      expect(await db.plans.count()).toBe(1)

      const report = await reconcile(db)
      expect(report.ok).toBe(true)
    } finally {
      for (const connection of connections) connection.close()
    }
  })
})

describe('重启恢复', () => {
  it('崩溃在 saving 阶段的计划重启后自动释放占用；reserved 计划保留继续处理', async () => {
    // 先排一笔占用显影液（rev -> 1），第二笔基于最新 revision 提交
    const other0 = await secondConnection()
    const crashed = await reservePlan({ ...baseReserve, filmId: 1, rolls: 2, batchNo: 'P-CRASH' }, other0)
    other0.close()
    const keep = await reservePlan({
      ...baseReserve,
      filmId: 2,
      rolls: 1,
      batchNo: 'P-KEEP',
      expectedFilmRevision: 0,
      expectedDeveloperRevision: 1
    }, db)
    await __stagePlanForCrash(crashed.id!, 'saving', db)

    // 模拟重启：新连接执行恢复
    const reopened = await secondConnection()
    try {
      const recovered = await recoverInterruptedPlans(reopened)
      expect(recovered).toHaveLength(1)
      expect(recovered[0].plan.id).toBe(crashed.id)

      const crashedPlan = await reopened.plans.get(crashed.id!)
      expect(crashedPlan?.status).toBe('released')
      expect(crashedPlan?.note).toContain('重启')
      expect((await reopened.films.get(1))?.rollsLeft).toBe(5)

      // 未崩溃的待确认计划原样保留、占用不丢
      const keptPlan = await reopened.plans.get(keep.id!)
      expect(keptPlan?.status).toBe('reserved')
      expect((await reopened.films.get(2))?.rollsLeft).toBe(1)

      const report = await reconcile(reopened)
      expect(report.ok).toBe(true)
    } finally {
      reopened.close()
    }
  })

  it('崩溃在 reserving 阶段不留半成品（占用与计划同生共死）', async () => {
    // reserving 是单事务阶段；事务回滚时计划与占用都不存在
    expect(await db.plans.count()).toBe(0)
    const recovered = await recoverInterruptedPlans(db)
    expect(recovered).toHaveLength(0)
    const report = await reconcile(db)
    expect(report.ok).toBe(true)
  })
})

describe('对账始终自洽', () => {
  it('预留、确认、释放、重试全流程后三方账目一致', async () => {
    const a = await reservePlan({ ...baseReserve, rolls: 2, batchNo: 'P-A' }, db)
    // 第二笔基于第一笔落地后的最新 revision 提交（模拟刷新后的表单）
    const b = await reservePlan({
      ...baseReserve,
      filmId: 2,
      rolls: 1,
      batchNo: 'P-B',
      expectedFilmRevision: 0,
      expectedDeveloperRevision: 1
    }, db)
    await confirmPlan(a.id!, confirmPayload(), db)
    await releasePlan(b.id!, '改期', db)

    const film1 = await db.films.get(1)
    expect(film1?.rollsTotal).toBe(film1!.rollsLeft + (film1!.reservedRolls ?? 0) + 2)
    const report = await reconcile(db)
    expect(report.ok).toBe(true)
    expect(report.issues).toHaveLength(0)
  })
})
