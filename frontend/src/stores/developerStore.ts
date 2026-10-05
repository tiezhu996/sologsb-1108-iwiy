import { defineStore } from 'pinia'
import { db, plain } from '../utils/db'
import type { Developer } from '../types/developer'
import { remainingRolls } from '../utils/ratio'

type NewDeveloper = Omit<Developer, 'id' | 'schemaRev'>

export const useDeveloperStore = defineStore('developer', {
  state: () => ({
    developers: [] as Developer[],
    loading: false
  }),
  getters: {
    activeDevelopers: (state) => state.developers.filter((developer) => developer.state !== '报废'),
    availableRolls(): number {
      // v3：可冲余量需扣除历史基线、计划实冲与占用
      return this.activeDevelopers.reduce(
        (sum, developer) => sum + remainingRolls(
          developer.maxRolls,
          (developer.baselineUsedRolls ?? 0) + developer.usedRolls + (developer.reservedRolls ?? 0)
        ),
        0
      )
    }
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
      const next = {
        ...payload,
        // v3：表单录入的已冲卷数视为历史基线，计划确认只累加 usedRolls
        baselineUsedRolls: payload.baselineUsedRolls ?? payload.usedRolls,
        usedRolls: 0,
        reservedRolls: payload.reservedRolls ?? 0,
        revision: 0,
        schemaRev: 3
      }
      const id = await db.developers.add(plain(next))
      await this.load()
      return id
    },
    async incrementUsed(id: number): Promise<void> {
      const developer = await db.developers.get(id)
      if (!developer) return
      // 手工记录统一计入历史基线，保证「标称 = 基线 + 实冲 + 占用 + 空闲」
      await db.developers.update(id, plain({
        baselineUsedRolls: (developer.baselineUsedRolls ?? 0) + 1,
        revision: (developer.revision ?? 0) + 1
      }))
      await this.load()
    },
    async scrap(id: number): Promise<void> {
      const developer = await db.developers.get(id)
      if (!developer) return
      await db.developers.update(id, plain({
        state: '报废',
        revision: (developer.revision ?? 0) + 1
      }))
      await this.load()
    }
  }
})
