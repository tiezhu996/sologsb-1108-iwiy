import type { FilmDevDatabase } from '../utils/db'
import { db as defaultDb, plain } from '../utils/db'
import type { Developer } from '../types/developer'
import type { DevPlan, PlanStatus } from '../types/dev-plan'
import type { DevRun, TankType } from '../types/dev-run'
import type { FilmStock } from '../types/film-stock'
import { remainingRolls } from '../utils/ratio'

/** 冲突类型：胶片乳剂批次或显影液工作液被其他标签页抢先占用 */
export type ConflictKind = 'film' | 'developer'

export class PlanConflictError extends Error {
  readonly code = 'PLAN_CONFLICT'
  readonly kind: ConflictKind
  /** 资源当前最新版本（调用方应刷新后重新选择） */
  readonly currentFilm?: FilmStock
  readonly currentDeveloper?: Developer

  constructor(kind: ConflictKind, currentFilm?: FilmStock, currentDeveloper?: Developer) {
    super(kind === 'film'
      ? '胶片余量已被其他计划抢先占用，请重新选择可用批次'
      : '显影液可冲数已被其他计划抢先占用，请重新选择工作液')
    this.name = 'PlanConflictError'
    this.kind = kind
    this.currentFilm = currentFilm
    this.currentDeveloper = currentDeveloper
  }
}

export class PlanCapacityError extends Error {
  readonly code = 'PLAN_CAPACITY'
  readonly kind: ConflictKind

  constructor(kind: ConflictKind) {
    super(kind === 'film'
      ? '该乳剂批次的可用余量不足以排下本次计划'
      : '该工作液的剩余可冲卷数不足以排下本次计划')
    this.name = 'PlanCapacityError'
    this.kind = kind
  }
}

export class PlanStateError extends Error {
  readonly code = 'PLAN_STATE'

  constructor(message: string) {
    super(message)
    this.name = 'PlanStateError'
  }
}

/** 保存被中断（演示用：模拟提交过程中掉电/写库失败） */
export class PlanSaveInterruptedError extends Error {
  readonly code = 'PLAN_SAVE_INTERRUPTED'
  readonly planId: number

  constructor(planId: number) {
    super('保存中断：占用已生效但正式记录未写入，可重试保存或释放占用')
    this.name = 'PlanSaveInterruptedError'
    this.planId = planId
  }
}

export interface ReserveInput {
  batchNo: string
  filmId: number
  developerId: number
  rolls: number
  /** 提交时页面所依据的资源版本（乐观锁），缺省视为 0 */
  expectedFilmRevision?: number
  expectedDeveloperRevision?: number
}

export interface ConfirmInput {
  actualTempC: number
  actualMinutes: number
  tankType: TankType
  runDate: string
  result: string
}

/** 显影液当前空闲可冲卷数（历史基线 + v3 实冲 + 占用都要扣除） */
export function developerFreeRolls(developer: Developer): number {
  const baseline = developer.baselineUsedRolls ?? 0
  return remainingRolls(
    developer.maxRolls,
    baseline + developer.usedRolls + (developer.reservedRolls ?? 0)
  )
}

/**
 * 模拟保存失败：在「占用已落地」与「正式记录写入」之间制造一次中断。
 * 置位后下一次 confirmPlan 会把计划留在 interrupted 状态而不回滚占用。
 */
let failNextConfirm = false

export function armSaveFailure(): void {
  failNextConfirm = true
}

export function isSaveFailureArmed(): boolean {
  return failNextConfirm
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * 阶段一：排片占用。
 *
 * 胶片余量扣减、显影液占用增加与计划写入在同一个 IndexedDB readwrite
 * 事务内完成——IndexedDB 对重叠事务按提交顺序串行化，因此两个标签页
 * 同时提交同一乳剂批次/工作液时，后落地的事务会读到对方提交后的版本，
 * 通过 revision 乐观锁检测到冲突并整体回滚（不会出现两边各扣一次）。
 */
export async function reservePlan(input: ReserveInput, database: FilmDevDatabase = defaultDb): Promise<DevPlan> {
  const rolls = Math.floor(input.rolls)
  if (!Number.isFinite(rolls) || rolls <= 0) {
    throw new PlanCapacityError('film')
  }
  if (!input.batchNo.trim()) {
    throw new PlanStateError('请填写批次号')
  }
  const expectedFilmRevision = input.expectedFilmRevision ?? 0
  const expectedDeveloperRevision = input.expectedDeveloperRevision ?? 0

  return database.transaction('rw', database.films, database.developers, database.plans, async () => {
    const film = await database.films.get(input.filmId)
    if (!film) throw new PlanStateError('所选胶片批次不存在，请刷新后重选')
    const developer = await database.developers.get(input.developerId)
    if (!developer) throw new PlanStateError('所选显影液不存在，请刷新后重选')
    if (developer.state === '报废') {
      throw new PlanStateError('该工作液已报废，不能再排片')
    }

    // 乐观锁：版本不一致说明另一个标签页已抢先提交
    if ((film.revision ?? 0) !== expectedFilmRevision) {
      throw new PlanConflictError('film', film, developer)
    }
    if ((developer.revision ?? 0) !== expectedDeveloperRevision) {
      throw new PlanConflictError('developer', film, developer)
    }

    if (film.rollsLeft < rolls) {
      throw new PlanCapacityError('film')
    }
    if (developerFreeRolls(developer) < rolls) {
      throw new PlanCapacityError('developer')
    }

    const plan: DevPlan = {
      batchNo: input.batchNo.trim(),
      filmId: input.filmId,
      developerId: input.developerId,
      rolls,
      expectedFilmRevision: film.revision ?? 0,
      expectedDeveloperRevision: developer.revision ?? 0,
      status: 'reserved',
      stage: 'idle',
      createdAt: nowIso(),
      updatedAt: nowIso()
    }
    const planId = await database.plans.add(plain(plan))

    await database.films.update(input.filmId, {
      rollsLeft: film.rollsLeft - rolls,
      reservedRolls: (film.reservedRolls ?? 0) + rolls,
      revision: (film.revision ?? 0) + 1
    })
    await database.developers.update(input.developerId, {
      reservedRolls: (developer.reservedRolls ?? 0) + rolls,
      revision: (developer.revision ?? 0) + 1
    })

    return { ...plan, id: planId }
  })
}

/**
 * 阶段二：确认实冲。占用转为正式记录。
 *
 * 同样在单个事务内完成：释放占用计数、显影液已用 +n、写入实冲记录、
 * 计划归档为 confirmed。任一步失败整体回滚。
 * （胶片余量已在占用阶段物理扣减，确认时只清占用计数。）
 *
 * 若 armSaveFailure() 已置位，先在独立事务里把计划标记为 stage='saving'
 * （模拟崩溃点），随后制造中断：计划留在 interrupted，占用保留，
 * 等待用户重试或释放。
 */
export async function confirmPlan(
  planId: number,
  payload: ConfirmInput,
  database: FilmDevDatabase = defaultDb
): Promise<{ plan: DevPlan; runId: number }> {
  if (!payload.result.trim()) {
    throw new PlanStateError('请填写实冲结果评价')
  }

  // 崩溃点模拟：saving 标记先落地，随后“断电”
  if (failNextConfirm) {
    failNextConfirm = false
    await database.transaction('rw', database.plans, async () => {
      const plan = await database.plans.get(planId)
      if (!plan) throw new PlanStateError('计划不存在或已被清理')
      if (plan.status !== 'reserved') {
        throw new PlanStateError('只有待确认的计划才能执行实冲保存')
      }
      await database.plans.update(planId, { stage: 'saving', updatedAt: nowIso() })
    })
    await markInterrupted(planId, '模拟保存失败：正式记录写入前中断', database)
    throw new PlanSaveInterruptedError(planId)
  }

  return database.transaction('rw', database.films, database.developers, database.plans, database.runs, async () => {
    const plan = await database.plans.get(planId)
    if (!plan) throw new PlanStateError('计划不存在或已被清理')
    if (plan.status !== 'reserved' || plan.stage !== 'idle') {
      throw new PlanStateError('该计划当前不是可确认状态，请刷新后查看')
    }
    const film = await database.films.get(plan.filmId)
    const developer = await database.developers.get(plan.developerId)
    if (!film) throw new PlanStateError('胶片批次已被删除，无法确认')
    if (!developer) throw new PlanStateError('显影液已被删除，无法确认')

    // 占用转正：reservedRolls -n，usedRolls +n；revision +1 使其他标签页的旧视图失效
    await database.films.update(plan.filmId, {
      reservedRolls: Math.max(0, (film.reservedRolls ?? 0) - plan.rolls),
      revision: (film.revision ?? 0) + 1
    })
    await database.developers.update(plan.developerId, {
      usedRolls: developer.usedRolls + plan.rolls,
      reservedRolls: Math.max(0, (developer.reservedRolls ?? 0) - plan.rolls),
      revision: (developer.revision ?? 0) + 1
    })

    const run: DevRun = {
      batchNo: plan.batchNo,
      actualTempC: payload.actualTempC,
      actualMinutes: payload.actualMinutes,
      tankType: payload.tankType,
      runDate: payload.runDate,
      result: payload.result.trim(),
      planId,
      rolls: plan.rolls,
      schemaRev: 3
    }
    const runId = await database.runs.add(plain(run))
    await database.plans.update(planId, {
      status: 'confirmed' as PlanStatus,
      stage: 'idle',
      runId,
      updatedAt: nowIso(),
      actualTempC: payload.actualTempC,
      actualMinutes: payload.actualMinutes,
      tankType: payload.tankType,
      runDate: payload.runDate,
      result: payload.result.trim(),
      failReason: undefined
    })

    const updated = await database.plans.get(planId)
    return { plan: updated as DevPlan, runId }
  })
}

/**
 * 释放占用：取消待确认计划、或放弃中断计划。
 * 恢复胶片余量与显影液可冲数（单事务），计划归档为 released。
 */
export async function releasePlan(
  planId: number,
  reason: string,
  database: FilmDevDatabase = defaultDb
): Promise<void> {
  await database.transaction('rw', database.films, database.developers, database.plans, async () => {
    const plan = await database.plans.get(planId)
    if (!plan) throw new PlanStateError('计划不存在或已被清理')
    if (plan.status !== 'reserved' && plan.status !== 'interrupted') {
      throw new PlanStateError('只有待确认或中断的计划才能释放')
    }
    const film = await database.films.get(plan.filmId)
    const developer = await database.developers.get(plan.developerId)
    if (film) {
      await database.films.update(plan.filmId, {
        rollsLeft: film.rollsLeft + plan.rolls,
        reservedRolls: Math.max(0, (film.reservedRolls ?? 0) - plan.rolls),
        revision: (film.revision ?? 0) + 1
      })
    }
    if (developer) {
      await database.developers.update(plan.developerId, {
        reservedRolls: Math.max(0, (developer.reservedRolls ?? 0) - plan.rolls),
        revision: (developer.revision ?? 0) + 1
      })
    }
    await database.plans.update(planId, {
      status: 'released' as PlanStatus,
      stage: 'idle',
      updatedAt: nowIso(),
      note: reason,
      failReason: undefined
    })
  })
}

/**
 * 中断计划重试保存：先在单事务内把 interrupted 复位为 reserved，
 * 再走正常确认事务（占用一直保留，所以不需要重新抢资源）。
 * 若期间资源已被删除等，确认事务会失败并给出明确提示。
 */
export async function retryInterruptedPlan(
  planId: number,
  payload: ConfirmInput,
  database: FilmDevDatabase = defaultDb
): Promise<{ plan: DevPlan; runId: number }> {
  await database.transaction('rw', database.plans, async () => {
    const plan = await database.plans.get(planId)
    if (!plan) throw new PlanStateError('计划不存在或已被清理')
    if (plan.status !== 'interrupted') {
      throw new PlanStateError('只有中断的计划可以重试保存')
    }
    await database.plans.update(planId, {
      status: 'reserved' as PlanStatus,
      stage: 'idle',
      updatedAt: nowIso(),
      failReason: undefined
    })
  })
  return confirmPlan(planId, payload, database)
}

async function markInterrupted(planId: number, reason: string, database: FilmDevDatabase): Promise<void> {
  await database.transaction('rw', database.plans, async () => {
    await database.plans.update(planId, {
      status: 'interrupted' as PlanStatus,
      stage: 'idle',
      updatedAt: nowIso(),
      failReason: reason
    })
  })
}

export interface RecoveredPlan {
  plan: DevPlan
  /** 实际处理方式：saving 阶段的计划统一释放占用 */
  action: 'released'
}

/**
 * 重启恢复：把崩溃在「确认实冲」事务（stage='saving'）中的计划释放占用，
 * 使胶片台账与显影液余量回到自洽状态；用户随后可重新排片。
 *
 * stage='reserving' 阶段的崩溃不会留下半成品——占用与计划写入处于
 * 同一个事务，要么一起可见、要么完全不存在，因此无需处理。
 * 已经是 reserved / interrupted 的计划属于正常未完成计划，保留占用，
 * 等待用户继续处理（确认 / 重试 / 取消）。
 */
export async function recoverInterruptedPlans(database: FilmDevDatabase = defaultDb): Promise<RecoveredPlan[]> {
  const recovered: RecoveredPlan[] = []
  const stuck = await database.plans.where('status').noneOf(['confirmed', 'released']).toArray()
  for (const plan of stuck) {
    if (plan.id === undefined || plan.stage !== 'saving') continue
    try {
      await releasePlan(plan.id, '重启后检测到保存中断，已自动恢复占用', database)
      recovered.push({ plan: { ...plan, status: 'released', stage: 'idle' }, action: 'released' })
    } catch {
      // 单个计划恢复失败不阻断其余计划；下次重启会再次尝试
    }
  }
  return recovered
}

export type IssueSeverity = 'error' | 'warning'

export interface ResourceIssue {
  severity: IssueSeverity
  kind: 'film' | 'developer'
  resourceId: number
  label: string
  message: string
}

export interface ReconcileReport {
  ok: boolean
  issues: ResourceIssue[]
  checkedAt: string
}

/**
 * 对账：校验「胶片台账 / 显影液余量 / 实冲记录」始终一致。
 *
 * 胶片不变量（每批次）：
 *   rollsTotal = rollsLeft + reservedRolls + Σ(confirmed 计划 rolls)
 *
 * 显影液不变量（每工作液）：
 *   maxRolls = 历史基线 + usedRolls + reservedRolls + 剩余可冲
 */
export async function reconcile(database: FilmDevDatabase = defaultDb): Promise<ReconcileReport> {
  const issues: ResourceIssue[] = []
  const [films, developers, plans] = await Promise.all([
    database.films.toArray(),
    database.developers.toArray(),
    database.plans.where('status').equals('confirmed').toArray()
  ])
  const filmConfirmed = new Map<number, number>()
  const devConfirmed = new Map<number, number>()
  for (const plan of plans) {
    filmConfirmed.set(plan.filmId, (filmConfirmed.get(plan.filmId) ?? 0) + plan.rolls)
    devConfirmed.set(plan.developerId, (devConfirmed.get(plan.developerId) ?? 0) + plan.rolls)
  }

  for (const film of films) {
    const id = film.id as number
    const reserved = film.reservedRolls ?? 0
    const confirmed = filmConfirmed.get(id) ?? 0
    const total = film.rollsTotal ?? 0
    if (film.rollsLeft < 0 || reserved < 0) {
      issues.push({ severity: 'error', kind: 'film', resourceId: id, label: film.emulsionNo, message: '出现负数卷数，台账已损坏' })
    }
    if (total !== film.rollsLeft + reserved + confirmed) {
      issues.push({
        severity: 'error',
        kind: 'film',
        resourceId: id,
        label: film.emulsionNo,
        message: `账面不平：总量 ${total} ≠ 剩余 ${film.rollsLeft} + 占用 ${reserved} + 实冲 ${confirmed}`
      })
    }
  }

  for (const developer of developers) {
    const id = developer.id as number
    const baseline = developer.baselineUsedRolls ?? 0
    const reserved = developer.reservedRolls ?? 0
    const committed = baseline + developer.usedRolls
    const free = remainingRolls(developer.maxRolls, committed + reserved)
    if (developer.usedRolls < 0 || reserved < 0) {
      issues.push({ severity: 'error', kind: 'developer', resourceId: id, label: developer.name, message: '出现负数卷数，余量已损坏' })
    }
    if (committed + reserved + free !== developer.maxRolls) {
      issues.push({
        severity: 'error',
        kind: 'developer',
        resourceId: id,
        label: developer.name,
        message: `余量不平：标称 ${developer.maxRolls} ≠ 历史已冲 ${baseline} + 实冲 ${developer.usedRolls} + 占用 ${reserved} + 空闲 ${free}`
      })
    }
    // 手工录入实冲可能超上限（历史行为），只作预警不视为账目损坏
    if (developer.state !== '报废' && committed > developer.maxRolls) {
      issues.push({ severity: 'warning', kind: 'developer', resourceId: id, label: developer.name, message: '累计实冲已超出可冲上限，建议评估报废' })
    }
  }

  return { ok: issues.every((issue) => issue.severity !== 'error'), issues, checkedAt: nowIso() }
}

export async function listPlans(database: FilmDevDatabase = defaultDb): Promise<DevPlan[]> {
  return database.plans.orderBy('createdAt').reverse().toArray()
}

export async function pendingCount(database: FilmDevDatabase = defaultDb): Promise<number> {
  return database.plans.where('status').anyOf(['reserved', 'interrupted']).count()
}

/** 供 UI 读取的资源视图（含可用余量） */
export interface FilmView {
  raw: FilmStock
  /** 可用于排片的卷数 = rollsLeft（已扣除占用） */
  available: number
}

export interface DeveloperView {
  raw: Developer
  /** 可用于排片的卷数 = maxRolls - 历史已冲 - 实冲 - 占用 */
  available: number
}

export async function listResources(database: FilmDevDatabase = defaultDb): Promise<{
  films: FilmView[]
  developers: DeveloperView[]
}> {
  const [films, developers] = await Promise.all([database.films.toArray(), database.developers.toArray()])
  return {
    films: films.map((raw) => ({ raw, available: Math.max(0, raw.rollsLeft) })),
    developers: developers.map((raw) => ({ raw, available: developerFreeRolls(raw) }))
  }
}

/** 测试辅助：把计划置于指定阶段（模拟断电现场） */
export async function __stagePlanForCrash(
  planId: number,
  stage: DevPlan['stage'],
  database: FilmDevDatabase = defaultDb
): Promise<void> {
  await database.plans.update(planId, { stage })
}
