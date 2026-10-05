import { defineStore } from 'pinia'
import { db, plain } from '../utils/db'
import type { DevRun } from '../types/dev-run'

type NewRun = Omit<DevRun, 'id' | 'schemaRev' | 'planId' | 'rolls'>

export const useRunStore = defineStore('run', {
  state: () => ({
    runs: [] as DevRun[],
    loading: false
  }),
  getters: {
    recentRuns: (state) => [...state.runs]
      .sort((a, b) => b.runDate.localeCompare(a.runDate))
      .slice(0, 6)
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.runs = await db.runs.orderBy('id').reverse().toArray()
      } finally {
        this.loading = false
      }
    },
    async addRun(payload: NewRun): Promise<number> {
      // 手工实冲记录：正式记录与显影液历史基线在同一事务内更新
      return db.transaction('rw', db.runs, db.recipes, db.developers, async () => {
        const id = await db.runs.add(plain({ ...payload, schemaRev: 3 }))
        if (payload.recipeId !== undefined) {
          const recipe = await db.recipes.get(payload.recipeId)
          if (recipe) {
            const developer = await db.developers.get(recipe.developerId)
            if (developer && developer.id !== undefined && developer.state !== '报废') {
              await db.developers.update(developer.id, plain({
                baselineUsedRolls: (developer.baselineUsedRolls ?? 0) + 1,
                revision: (developer.revision ?? 0) + 1
              }))
            }
          }
        }
        return id
      }).finally(() => {
        void this.load()
      })
    },
    async writeBackNote(runId: number, recipeId: number): Promise<void> {
      const run = await db.runs.get(runId)
      if (!run) return
      const note = `${run.runDate} 实冲 ${run.actualTempC}°C / ${run.actualMinutes} 分钟：${run.result}`
      await db.recipes.update(recipeId, plain({ note }))
    }
  }
})
