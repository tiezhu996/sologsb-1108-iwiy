import { defineStore } from 'pinia'
import { db, plain, availableDeveloperRolls, reservedRolls } from '../utils/db'
import type { Developer } from '../types/developer'
import { notifyDbChange } from '../utils/dbSync'

type NewDeveloper = Omit<Developer, 'id' | 'schemaRev' | 'reservations' | 'version'>

export const useDeveloperStore = defineStore('developer', {
  state: () => ({
    developers: [] as Developer[],
    loading: false
  }),
  getters: {
    activeDevelopers: (state) => state.developers.filter((developer) => developer.state !== '报废'),
    /** 可冲卷数合计 = 上限 − 已冲 − 待确认计划占用 */
    availableRolls(): number {
      return this.activeDevelopers.reduce((sum, developer) => sum + availableDeveloperRolls(developer), 0)
    },
    reservedRolls: (state) => state.developers.reduce((sum, developer) => sum + reservedRolls(developer.reservations), 0)
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.developers = await db.developers.orderBy('id').reverse().toArray()
      } finally {
        this.loading = false
      }
    },
    async addDeveloper(payload: NewDeveloper): Promise<number> {
      const next = { ...payload, reservations: [], version: 0, schemaRev: 3 }
      const id = await db.developers.add(plain(next))
      await this.load()
      notifyDbChange('developer')
      return id
    },
    async scrap(id: number): Promise<void> {
      const developer = await db.developers.get(id)
      if (!developer) return
      developer.state = '报废'
      developer.version = (developer.version ?? 0) + 1
      await db.developers.put(plain(developer))
      await this.load()
      notifyDbChange('developer')
    }
  }
})
