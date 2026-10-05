import type { ReservationLease } from './plan'

export type FilmModel = 'GP3' | 'HP5' | 'Portra'
export type FilmFormat = '135' | '120' | '4×5'

export interface FilmStock {
  id?: number
  model: FilmModel
  format: FilmFormat
  boxIso: number
  realIso: number
  emulsionNo: string
  expireDate: string
  rollsLeft: number
  /** 待确认计划的预占用明细，rollsLeft 已含扣减口径 */
  reservations?: ReservationLease[]
  /** 乐观锁：每次余量或占用变动 +1，跨标签页提交只认先落地者 */
  version?: number
  schemaRev?: number
}
