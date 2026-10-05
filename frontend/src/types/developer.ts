import type { ReservationLease } from './plan'

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
  usedRolls: number
  state: DeveloperState
  /** 待确认计划的预占用明细，usedRolls 已含占用口径 */
  reservations?: ReservationLease[]
  /** 乐观锁：每次余量或占用变动 +1，跨标签页提交只认先落地者 */
  version?: number
  schemaRev?: number
}
