import { defineStore } from 'pinia'
import { db, plain } from '../utils/db'
import type { FilmStock } from '../types/film-stock'

type NewFilm = Omit<FilmStock, 'id' | 'schemaRev'>

export const useFilmStore = defineStore('film', {
  state: () => ({
    films: [] as FilmStock[],
    loading: false
  }),
  getters: {
    totalRolls: (state) => state.films.reduce((sum, film) => sum + film.rollsLeft, 0),
    lowStockCount: (state) => state.films.filter((film) => film.rollsLeft <= 2).length
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.films = await db.films.orderBy('id').reverse().toArray()
      } finally {
        this.loading = false
      }
    },
    async addFilm(payload: NewFilm): Promise<number> {
      const next = {
        ...payload,
        // v3：新批次账面总量 = 实物余量，占用计数与乐观锁版本初始化
        rollsTotal: payload.rollsTotal ?? payload.rollsLeft,
        rollsLeft: payload.rollsLeft,
        reservedRolls: payload.reservedRolls ?? 0,
        revision: 0,
        schemaRev: 3
      }
      const id = await db.films.add(plain(next))
      await this.load()
      return id
    },
    async changeRolls(id: number, rollsLeft: number): Promise<void> {
      // 手工盘点同时调整实物余量与账面总量，并推进版本号，
      // 使其他标签页里基于旧 revision 的排片提交收到冲突
      const film = await db.films.get(id)
      const nextLeft = Math.max(0, rollsLeft)
      if (!film) return
      const delta = nextLeft - film.rollsLeft
      await db.films.update(id, plain({
        rollsLeft: nextLeft,
        rollsTotal: Math.max(0, (film.rollsTotal ?? film.rollsLeft) + delta),
        revision: (film.revision ?? 0) + 1
      }))
      await this.load()
    }
  }
})
