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
  /** 物理剩余卷数（已扣除实冲与待冲占用） */
  rollsLeft: number
  /** 台账账面总量：rollsLeft + 已实冲卷数（v3 起用于对账） */
  rollsTotal?: number
  /** 待冲计划占用卷数（v3 起） */
  reservedRolls?: number
  /** 乐观锁版本号（v3 起），每次占用/确认/释放 +1 */
  revision?: number
  schemaRev?: number
}
