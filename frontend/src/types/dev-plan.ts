import type { TankType } from './dev-run'

/**
 * 待冲批次（排片计划）状态机：
 *
 *   reserved    已原子占用胶片余量与显影液可冲数，等待确认实冲
 *   interrupted 保存中断：占用已落地、正式保存失败（模拟掉电/写失败），
 *               可「重试保存」或「释放占用」
 *   confirmed   已确认实冲，占用转为正式记录，计划归档
 *   released    占用被释放（主动取消 / 中断后放弃 / 重启恢复中断计划）
 */
export type PlanStatus = 'reserved' | 'interrupted' | 'confirmed' | 'released'

/**
 * 计划所处的保存阶段（崩溃恢复标记）：
 *
 *   reserving 正在执行「占用 + 写计划」事务；若崩溃于此阶段，
 *             因为占用与计划写入在同一个 IndexedDB 事务中，重启后不会留下任何痕迹
 *   saving    占用已落地，正在执行「确认实冲」事务；崩溃于此阶段的计划重启后
 *             被判定为 interrupted，统一释放占用后可重新排片
 *   idle      稳定状态（reserved / interrupted / released / confirmed）
 */
export type PlanStage = 'reserving' | 'saving' | 'idle'

export interface DevPlan {
  id?: number
  batchNo: string
  filmId: number
  developerId: number
  rolls: number
  /** 提交排片时看到的资源版本，用于乐观锁冲突检测 */
  expectedFilmRevision: number
  expectedDeveloperRevision: number
  status: PlanStatus
  stage: PlanStage
  createdAt: string
  updatedAt: string
  /** 确认实冲时产生的正式记录 id（confirmed 后回填） */
  runId?: number
  /** 中断原因（保存失败时的错误信息） */
  failReason?: string
  /** 释放/中断备注，如「重启后自动恢复」 */
  note?: string

  // —— 确认实冲时录入的参数（reserved 阶段为空）——
  actualTempC?: number
  actualMinutes?: number
  tankType?: TankType
  runDate?: string
  result?: string
}
