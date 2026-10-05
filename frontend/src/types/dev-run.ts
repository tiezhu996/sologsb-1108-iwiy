export type TankType = '双联罐' | '深罐'

export interface DevRun {
  id?: number
  batchNo: string
  recipeId: number
  actualTempC: number
  actualMinutes: number
  tankType: TankType
  runDate: string
  result: string
  /** 来源排片计划与卷次，保证确认重试不会重复生成正式记录 */
  planId?: number
  itemKey?: string
  schemaRev?: number
}
