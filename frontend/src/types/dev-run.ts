export type TankType = '双联罐' | '深罐'

export interface DevRun {
  id?: number
  batchNo: string
  recipeId?: number
  actualTempC: number
  actualMinutes: number
  tankType: TankType
  runDate: string
  result: string
  /** v3：由待冲计划确认产生时回填的计划 id（历史手工记录无此字段） */
  planId?: number
  /** v3：本次实冲卷数（历史手工记录无此字段，对账时按 1 计） */
  rolls?: number
  schemaRev?: number
}
