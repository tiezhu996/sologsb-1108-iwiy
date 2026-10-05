import type { PushPull } from './dev-recipe'
import type { TankType } from './dev-run'

/** 排片计划的生命周期：占用余量 → 确认实冲 / 失败释放 → 可重试 / 重启恢复 */
export type PlanStatus = '待确认' | '已实冲' | '保存失败' | '已取消'

/** 单卷占用项：一卷胶片对应一条显影液占用 */
export interface PlanItem {
  /** 单卷幂等键，同一条计划重试时保持不变，保证不会重复扣减余量 */
  itemKey: string
  filmId: number
  filmLabel: string
  developerId: number
  developerLabel: string
  recipeId: number
  rollCount: number
  pushPull: PushPull
}

export interface DevPlan {
  id?: number
  planNo: string
  status: PlanStatus
  tankType: TankType
  runDate: string
  /** 排片时预填、确认时可修改的实冲参数 */
  actualTempC: number
  actualMinutes: number
  result: string
  items: PlanItem[]
  /** 已生成的正式冲洗记录 id（确认成功后回填） */
  runIds: number[]
  /** 最近一次确认失败的原因，用于重试前提示 */
  lastError?: string
  createdAt: string
  updatedAt: string
  schemaRev?: number
}

/** 资源行上的一条占用记录，valueOf 用于事务内对账 */
export interface ReservationLease {
  planId: number
  itemKey: string
  amount: number
  /** 计划内序号，便于在台账上展示“哪一卷” */
  rollLabel: string
  createdAt: string
}

/** 一次提交尝试的快照，保存失败后凭它恢复占用并重试 */
export interface PlanAttempt {
  planId: number
  attempt: number
  planNo: string
  tankType: TankType
  runDate: string
  actualTempC: number
  actualMinutes: number
  result: string
  items: PlanItem[]
  /** 已落地的正式记录 id，断点续传时跳过、不重复插入 */
  createdRunIds: number[]
  /** 已完成正式扣减的 itemKey，断点续传时跳过 */
  consumedItemKeys: string[]
  updatedAt: string
}

/** 资源冲突描述，供“另一个标签页看到冲突后再选可用资源” */
export interface PlanConflict {
  type: 'film' | 'developer'
  resourceId: number
  resourceLabel: string
  available: number
  requested: number
  /** 先落地占用余量的计划号 */
  blockedByPlan: string
}

export class PlanConflictError extends Error {
  conflicts: PlanConflict[]

  constructor(conflicts: PlanConflict[]) {
    const first = conflicts[0]
    super(first
      ? `${first.resourceLabel} 可用余量仅剩 ${first.available}，已被计划 ${first.blockedByPlan} 先占用`
      : '资源余量冲突')
    this.name = 'PlanConflictError'
    this.conflicts = conflicts
  }
}
