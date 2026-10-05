import { defineStore } from 'pinia'
import { db, plain, availableRollsFor, reservedRolls } from '../utils/db'
import type { FilmStock } from '../types/film-stock'
import { notifyDbChange } from '../utils/dbSync'

type NewFilm = Omit<FilmStock, 'id' | 'schemaRev' | 'reservations' | 'version'>

export const useFilmStore = defineStore('film', {
  state: () => ({
    films: [] as FilmStock[],
    loading: false
  }),
  getters: {
    totalRolls: (state) => state.films.reduce((sum, film) => sum + film.rollsLeft, 0),
    totalAvailableRolls: (state) => state.films.reduce((sum, film) => sum + availableRollsFor(film), 0),
    totalReservedRolls: (state) => state.films.reduce((sum, film) => sum + reservedRolls(film.reservations), 0),
    lowStockCount: (state) => state.films.filter((film) => availableRollsFor(film) <= 2).length
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
      const next = { ...payload, reservations: [], version: 0, schemaRev: 3 }
      const id = await db.films.add(plain(next))
      await this.load()
      notifyDbChange('film')
      return id
    },
    async changeRolls(id: number, rollsLeft: number): Promise<void> {
      const film = await db.films.get(id)
      if (!film) return
      film.rollsLeft = Math.max(0, rollsLeft)
      film.version = (film.version ?? 0) + 1
      await db.films.put(plain(film))
      await this.load()
      notifyDbChange('film')
    }
  }
})
