export type DeveloperCategory = 'D-76' | 'HC-110' | 'Rodinal' | 'C-41'
export type Dilution = '1:1' | '1:3'
export type DeveloperState = '新配' | '在用' | '报废'

export interface Developer {
  id?: number
  name: string
  category: DeveloperCategory
  dilution: Dilution
  volumeMl: number
  mixedAt: string
  maxRolls: number
  /** 已实冲消耗卷数（v3 起只统计通过计划确认的实冲，历史值计入 baselineUsedRolls） */
  usedRolls: number
  /** v2 时代手工录入的实冲基线，v3 升级时回填，用于对账 */
  baselineUsedRolls?: number
  /** 待冲计划占用卷数（v3 起） */
  reservedRolls?: number
  /** 乐观锁版本号（v3 起），每次占用/确认/释放 +1 */
  revision?: number
  state: DeveloperState
  schemaRev?: number
}
