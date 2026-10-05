import type { FilmDevDatabase } from './db'
import type { FilmStock } from '../types/film-stock'
import type { Developer } from '../types/developer'
import type { DevRun } from '../types/dev-run'
import {
  type DevPlan,
  type PlanAttempt,
  type PlanConflict,
  type PlanItem,
  PlanConflictError
} from '../types/plan'
import { acquireTabLock } from './dbSync'
import { availableRollsFor, availableDeveloperRolls } from './db'

type DB = FilmDevDatabase

interface ReserveInput {
  planNo: string
  tankType: DevPlan['tankType']
  runDate: string
  actualTempC: number
  actualMinutes: number
  result: string
  items: PlanItem[]
  /** 打开排片表单时读到的资源版本；落库前被别的标签页改过则判冲突 */
  expectedVersions?: {
    films: Map<number, number>
    developers: Map<number, number>
  }
}

export type ReserveResult =
  | { status: 'ok'; plan: DevPlan }
  | { status: 'conflict'; conflicts: PlanConflict[] }
  | { status: 'duplicate'; planNo: string }

export interface ConfirmOverrides {
  actualTempC?: number
  actualMinutes?: number
  result?: string
}

/** 测试 / 演示用：让某次确认在处理完若干卷后中断，留下半截计划 */
const failureHooks = new Map<number, { afterItems: number; message: string }>()

export function armConfirmationFailure(planId: number, afterItems = 1, message = '显影液台账保存中断，请恢复占用后重试'): void {
  failureHooks.set(planId, { afterItems, message })
}

export function disarmConfirmationFailure(planId: number): void {
  failureHooks.delete(planId)
}

function nowStamp(): string {
  return new Date().toISOString()
}

function leaseAmounts(leases: { amount: number }[] | undefined): number {
  return (leases ?? []).reduce((sum, lease) => sum + lease.amount, 0)
}

interface DemandAggregate {
  films: Map<number, number>
  developers: Map<number, number>
}

function aggregateDemand(items: PlanItem[]): DemandAggregate {
  const films = new Map<number, number>()
  const developers = new Map<number, number>()
  for (const item of items) {
    films.set(item.filmId, (films.get(item.filmId) ?? 0) + item.rollCount)
    developers.set(item.developerId, (developers.get(item.developerId) ?? 0) + item.rollCount)
  }
  return { films, developers }
}

function otherLeasePlanNo(leases: { planId: number }[] | undefined, selfPlanId: number, planNoMap: Map<number, string>): string {
  const blocker = (leases ?? []).find((lease) => lease.planId !== selfPlanId)
  return (blocker && planNoMap.get(blocker.planId)) || '其它排片'
}

function resourceConflict(
  type: 'film' | 'developer',
  resourceId: number,
  label: string,
  available: number,
  requested: number,
  leases: { planId: number }[] | undefined,
  planNoMap: Map<number, string>,
  selfPlanId: number
): PlanConflict {
  return {
    type,
    resourceId,
    resourceLabel: label,
    available,
    requested,
    blockedByPlan: otherLeasePlanNo(leases, selfPlanId, planNoMap)
  }
}

function versionConflict(
  type: 'film' | 'developer',
  resourceId: number,
  label: string,
  resource: FilmStock | Developer,
  requested: number,
  leases: { planId: number }[] | undefined,
  planNoMap: Map<number, string>,
  selfPlanId: number
): PlanConflict {
  const available = type === 'film'
    ? availableRollsFor(resource as FilmStock)
    : availableDeveloperRolls(resource as Developer)
  return resourceConflict(type, resourceId, `${label}（已被他人改动）`, available, requested, leases, planNoMap, selfPlanId)
}

/**
 * 阶段一：排片落库。在同一个读写事务内占用胶片余量与显影液可冲卷数，
 * 两个标签页同时提交时由 IndexedDB 写事务串行化，后到者读到新占用并收到冲突。
 */
export async function reservePlan(database: DB, input: ReserveInput): Promise<ReserveResult> {
  const db = database
  const items = input.items
  if (!items.length) throw new Error('排片计划至少包含一卷胶片')

  try {
    return await db.transaction('rw', db.plans, db.films, db.developers, async () => {
      const duplicate = await db.plans.where('planNo').equals(input.planNo).first()
      if (duplicate) {
        // 唯一批次号冲突直接返回，不抛错，避免事务被标记中止
        return { status: 'duplicate' as const, planNo: input.planNo }
      }

      const planId = await db.plans.add(plain({
        planNo: input.planNo,
        status: '待确认',
        tankType: input.tankType,
        runDate: input.runDate,
        actualTempC: input.actualTempC,
        actualMinutes: input.actualMinutes,
        result: input.result,
        items: plain(items),
        runIds: [],
        createdAt: nowStamp(),
        updatedAt: nowStamp(),
        schemaRev: 3
      } satisfies DevPlan))

      const demand = aggregateDemand(items)
      const allPlans = await db.plans.toArray()
      const planNoMap = new Map<number, string>(allPlans.map((plan) => [plan.id as number, plan.planNo]))

      const conflicts: PlanConflict[] = []

      for (const [filmId, requested] of demand.films) {
        const film = await db.films.get(filmId)
        if (!film) {
          conflicts.push({ type: 'film', resourceId: filmId, resourceLabel: `胶片 #${filmId}`, available: 0, requested, blockedByPlan: '—' })
          continue
        }
        const expected = input.expectedVersions?.films.get(filmId)
        if (expected !== undefined && (film.version ?? 0) !== expected) {
          conflicts.push(versionConflict('film', film.id as number, `${film.model} · ${film.emulsionNo}`, film, requested, film.reservations, planNoMap, planId))
          continue
        }
        const available = availableRollsFor(film)
        if (available < requested) {
          conflicts.push(resourceConflict('film', film.id as number, `${film.model} · ${film.emulsionNo}`, available, requested, film.reservations, planNoMap, planId))
        }
      }

      for (const [developerId, requested] of demand.developers) {
        const developer = await db.developers.get(developerId)
        if (!developer) {
          conflicts.push({ type: 'developer', resourceId: developerId, resourceLabel: `显影液 #${developerId}`, available: 0, requested, blockedByPlan: '—' })
          continue
        }
        const expected = input.expectedVersions?.developers.get(developerId)
        if (expected !== undefined && (developer.version ?? 0) !== expected) {
          conflicts.push(versionConflict('developer', developer.id as number, developer.name, developer, requested, developer.reservations, planNoMap, planId))
          continue
        }
        if (developer.state === '报废') {
          conflicts.push({ type: 'developer', resourceId: developer.id as number, resourceLabel: developer.name, available: 0, requested, blockedByPlan: '已报废' })
          continue
        }
        const available = availableDeveloperRolls(developer)
        if (available < requested) {
          conflicts.push(resourceConflict('developer', developer.id as number, developer.name, available, requested, developer.reservations, planNoMap, planId))
        }
      }

      if (conflicts.length) throw new PlanConflictError(conflicts)

      // 全部资源都够，才一次性写入占用
      for (const filmId of demand.films.keys()) {
        const film = await db.films.get(filmId)
        if (!film) continue
        const leases = film.reservations ?? []
        for (const item of items.filter((candidate) => candidate.filmId === filmId)) {
          leases.push({
            planId,
            itemKey: item.itemKey,
            amount: item.rollCount,
            rollLabel: item.filmLabel,
            createdAt: nowStamp()
          })
        }
        film.reservations = leases
        film.version = (film.version ?? 0) + 1
        await db.films.put(plain(film))
      }

      for (const developerId of demand.developers.keys()) {
        const developer = await db.developers.get(developerId)
        if (!developer) continue
        const leases = developer.reservations ?? []
        for (const item of items.filter((candidate) => candidate.developerId === developerId)) {
          leases.push({
            planId,
            itemKey: item.itemKey,
            amount: item.rollCount,
            rollLabel: item.developerLabel,
            createdAt: nowStamp()
          })
        }
        developer.reservations = leases
        developer.version = (developer.version ?? 0) + 1
        await db.developers.put(plain(developer))
      }

      const plan = await db.plans.get(planId) as DevPlan
      return { status: 'ok' as const, plan }
    })
  } catch (error) {
    if (error instanceof PlanConflictError) {
      return { status: 'conflict', conflicts: error.conflicts }
    }
    // Dexie 会用 AbortError 包裹事务回调抛出的异常
    const cause = (error as { cause?: unknown })?.cause
    if (cause instanceof PlanConflictError) {
      return { status: 'conflict', conflicts: cause.conflicts }
    }
    throw error
  }
}

/**
 * 阶段二：确认实冲。每卷独立短事务提交并更新尝试快照，
 * 中途失败只回滚当前卷，已落地的正式记录不丢，未处理的卷保留占用、可断点续传。
 */
export async function confirmPlan(database: DB, planId: number, overrides: ConfirmOverrides = {}): Promise<DevPlan> {
  const db = database

  // 建立 / 续写本次确认尝试的快照，保证保存中断后能恢复并继续
  await db.transaction('rw', db.plans, db.planAttempts, async () => {
    const plan = await db.plans.get(planId)
    if (!plan) throw new Error('排片计划不存在')
    if (plan.status === '已取消') throw new Error('计划已取消，不能确认实冲')
    if (plan.status === '已实冲') return

    const previous = await latestAttempt(db, planId)
    const snapshot: PlanAttempt = {
      planId,
      attempt: (previous?.attempt ?? 0) + 1,
      planNo: plan.planNo,
      tankType: plan.tankType,
      runDate: plan.runDate,
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
    // 处理过程中保持「待确认」；真正中断时才转为「保存失败」。
    // 即便此处之后页面崩溃，快照已落库，重启对账会凭它续做。
    plan.updatedAt = nowStamp()
    await db.plans.put(plain(plan))
    await db.planAttempts.put(plain(snapshot))
  })

  const initialPlan = await db.plans.get(planId) as DevPlan
  if (initialPlan.status === '已实冲') return initialPlan

  let attempt = await latestAttempt(db, planId) as PlanAttempt
  let processed = attempt.consumedItemKeys.length
  const hook = failureHooks.get(planId)

  try {
    for (const item of initialPlan.items) {
      if (attempt.consumedItemKeys.includes(item.itemKey)) continue
      const current = await db.plans.get(planId) as DevPlan
      await commitItem(db, current, item, attempt)
      processed += 1
      attempt = await latestAttempt(db, planId) as PlanAttempt
      if (hook && processed === hook.afterItems) {
        throw new Error(hook.message)
      }
    }
  } catch (error) {
    const ongoing = await db.plans.get(planId) as DevPlan
    ongoing.status = '保存失败'
    ongoing.lastError = error instanceof Error ? error.message : String(error)
    ongoing.updatedAt = nowStamp()
    await db.plans.put(plain(ongoing))
    failureHooks.delete(planId)
    throw error
  }

  return finalizeConfirmed(db, planId)
}

/** 每卷一个事务：幂等生成正式记录，并把预占用转换为正式消耗 */
async function commitItem(db: DB, plan: DevPlan, item: PlanItem, attempt: PlanAttempt): Promise<void> {
  await db.transaction('rw', db.runs, db.films, db.developers, db.planAttempts, async () => {
    const existing = await db.runs.where('itemKey').equals(item.itemKey).first()
    let runId: number
    if (existing?.id !== undefined) {
      runId = existing.id
    } else {
      runId = await db.runs.add(plain({
        batchNo: plan.planNo,
        recipeId: item.recipeId,
        actualTempC: attempt.actualTempC,
        actualMinutes: attempt.actualMinutes,
        tankType: attempt.tankType,
        runDate: attempt.runDate,
        result: attempt.result,
        planId: plan.id,
        itemKey: item.itemKey,
        schemaRev: 3
      } satisfies DevRun))
    }

    const film = await db.films.get(item.filmId)
    if (film) {
      // 胶片是消耗品：预占用转实冲时，账面余量与占用明细同时扣减
      const ownLease = (film.reservations ?? []).find(
        (lease) => lease.itemKey === item.itemKey && lease.planId === plan.id
      )
      if (ownLease) {
        film.rollsLeft = Math.max(0, film.rollsLeft - ownLease.amount)
      }
      film.reservations = (film.reservations ?? []).filter(
        (lease) => !(lease.itemKey === item.itemKey && lease.planId === plan.id)
      )
      film.version = (film.version ?? 0) + 1
      await db.films.put(plain(film))
    }

    const developer = await db.developers.get(item.developerId)
    if (developer) {
      developer.reservations = (developer.reservations ?? []).filter(
        (lease) => !(lease.itemKey === item.itemKey && lease.planId === plan.id)
      )
      developer.usedRolls += item.rollCount
      if (developer.state === '新配') developer.state = '在用'
      developer.version = (developer.version ?? 0) + 1
      await db.developers.put(plain(developer))
    }

    if (!attempt.createdRunIds.includes(runId)) attempt.createdRunIds.push(runId)
    if (!attempt.consumedItemKeys.includes(item.itemKey)) attempt.consumedItemKeys.push(item.itemKey)
    attempt.updatedAt = nowStamp()
    await db.planAttempts.put(plain(attempt))
  })
}

async function finalizeConfirmed(db: DB, planId: number): Promise<DevPlan> {
  return db.transaction('rw', db.plans, db.planAttempts, db.runs, async () => {
    const plan = await db.plans.get(planId) as DevPlan
    const runIds = (await db.runs.where('planId').equals(planId).toArray())
      .map((run) => run.id as number)
      .sort((a, b) => a - b)
    plan.status = '已实冲'
    plan.runIds = runIds
    plan.lastError = undefined
    plan.updatedAt = nowStamp()
    await db.plans.put(plain(plan))
    await db.planAttempts.where('planId').equals(planId).delete()
    return plan
  })
}

/** 保存失败 / 重启后凭尝试快照继续：覆盖项沿用快照，逐卷幂等续做 */
export async function retryConfirmPlan(database: DB, planId: number, overrides: ConfirmOverrides = {}): Promise<DevPlan> {
  const db = database
  const attempt = await latestAttempt(db, planId)
  if (!attempt) return confirmPlan(db, planId, overrides)
  return confirmPlan(db, planId, {
    actualTempC: overrides.actualTempC ?? attempt.actualTempC,
    actualMinutes: overrides.actualMinutes ?? attempt.actualMinutes,
    result: overrides.result ?? attempt.result
  })
}

async function latestAttempt(db: DB, planId: number): Promise<PlanAttempt | undefined> {
  const attempts = await db.planAttempts.where('planId').equals(planId).toArray()
  return attempts.sort((a, b) => b.attempt - a.attempt)[0]
}

/** 取消计划：释放两类余量并删除尝试快照（已实冲计划不可取消） */
export async function cancelPlan(database: DB, planId: number): Promise<void> {
  const db = database
  await db.transaction('rw', db.plans, db.films, db.developers, db.planAttempts, async () => {
    const plan = await db.plans.get(planId)
    if (!plan) return
    if (plan.status === '已实冲') throw new Error('已实冲计划不能取消')
    if (plan.status === '已取消') return

    await releasePlanLeases(db, planId)
    plan.status = '已取消'
    plan.updatedAt = nowStamp()
    await db.plans.put(plain(plan))
    await db.planAttempts.where('planId').equals(planId).delete()
  })
}

async function releasePlanLeases(db: DB, planId: number): Promise<void> {
  for (const film of await db.films.toArray()) {
    const leases = film.reservations ?? []
    const next = leases.filter((lease) => lease.planId !== planId)
    if (next.length !== leases.length) {
      film.reservations = next
      film.version = (film.version ?? 0) + 1
      await db.films.put(plain(film))
    }
  }
  for (const developer of await db.developers.toArray()) {
    const leases = developer.reservations ?? []
    const next = leases.filter((lease) => lease.planId !== planId)
    if (next.length !== leases.length) {
      developer.reservations = next
      developer.version = (developer.version ?? 0) + 1
      await db.developers.put(plain(developer))
    }
  }
}

/**
 * 重启恢复：自动续做所有中断在确认阶段的计划（存在尝试快照）。
 * 全库只允许一个标签页执行（localStorage 跨页锁），其余标签页等待广播刷新。
 */
export async function reconcilePlans(database: DB): Promise<void> {
  const db = database
  const release = acquireTabLock('plan-reconcile', 20_000)
  if (!release) {
    // 别的标签页正在恢复，稍候由跨页变化广播触发本页刷新
    return
  }
  try {
    const attempts = await db.planAttempts.toArray()
    const planIds = [...new Set(attempts.map((item) => item.planId))]
    for (const planId of planIds) {
      const plan = await db.plans.get(planId)
      if (plan && (plan.status === '待确认' || plan.status === '保存失败')) {
        await retryConfirmPlan(db, planId)
      }
    }
    await sweepOrphanLeases(db)
  } finally {
    release()
  }
}

/** 台账兜底对账：清掉指向已取消 / 不存在计划的占用，补转已实冲计划的残留占用 */
async function sweepOrphanLeases(db: DB): Promise<void> {
  const plans = await db.plans.toArray()
  const planById = new Map(plans.map((plan) => [plan.id as number, plan]))

  for (const film of await db.films.toArray()) {
    const leases = film.reservations ?? []
    const next = leases.filter((lease) => {
      const plan = planById.get(lease.planId)
      return plan && plan.status !== '已取消' && plan.status !== '已实冲'
    })
    if (next.length !== leases.length) {
      film.reservations = next
      film.version = (film.version ?? 0) + 1
      await db.films.put(plain(film))
    }
  }

  for (const developer of await db.developers.toArray()) {
    const leases = developer.reservations ?? []
    const survivors: NonNullable<Developer['reservations']> = []
    let changed = false
    for (const lease of leases) {
      const plan = planById.get(lease.planId)
      if (!plan || plan.status === '已取消') {
        changed = true
        continue
      }
      if (plan.status === '已实冲') {
        // 正常流程里正式扣减已与实冲记录同事务完成；此处只在记录存在而占用残留时补扣
        const run = await db.runs.where('itemKey').equals(lease.itemKey).first()
        if (run) developer.usedRolls += lease.amount
        changed = true
        continue
      }
      survivors.push(lease)
    }
    if (changed) {
      developer.reservations = survivors
      developer.version = (developer.version ?? 0) + 1
      await db.developers.put(plain(developer))
    }
  }
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
