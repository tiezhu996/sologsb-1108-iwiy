import { defineStore } from 'pinia'
import type { Developer } from '../types/developer'
import type { DevPlan } from '../types/dev-plan'
import type { TankType } from '../types/dev-run'
import type { FilmStock } from '../types/film-stock'
import {
  armSaveFailure,
  confirmPlan,
  developerFreeRolls,
  isSaveFailureArmed,
  listPlans,
  listResources,
  recoverInterruptedPlans,
  releasePlan,
  reservePlan,
  retryInterruptedPlan,
  type ConfirmInput,
  type RecoveredPlan,
  type ReserveInput
} from '../services/planService'
import { notifyDbChange } from '../utils/sync'

interface PlanFormPayload extends Omit<ConfirmInput, never> {
  actualTempC: number
  actualMinutes: number
  tankType: TankType
  runDate: string
  result: string
}

export const usePlanStore = defineStore('plan', {
  state: () => ({
    plans: [] as DevPlan[],
    films: [] as FilmStock[],
    developers: [] as Developer[],
    loading: false,
    /** 本次启动恢复的计划（用于顶部提示） */
    recovered: [] as RecoveredPlan[],
    /** 演示开关：下一次确认实冲会模拟保存失败 */
    failArmed: false
  }),
  getters: {
    pendingPlans: (state) => state.plans.filter((plan) => plan.status === 'reserved'),
    interruptedPlans: (state) => state.plans.filter((plan) => plan.status === 'interrupted'),
    historyPlans: (state) => state.plans.filter((plan) => plan.status === 'confirmed' || plan.status === 'released'),
    filmAvailable: () => (film: FilmStock): number => Math.max(0, film.rollsLeft),
    developerAvailable: () => (developer: Developer): number => developerFreeRolls(developer)
  },
  actions: {
    async loadAll(): Promise<void> {
      this.loading = true
      try {
        const [plans, resources] = await Promise.all([listPlans(), listResources()])
        this.plans = plans
        this.films = resources.films.map((item) => item.raw)
        this.developers = resources.developers.map((item) => item.raw)
        this.failArmed = isSaveFailureArmed()
      } finally {
        this.loading = false
      }
    },
    async runStartupRecovery(): Promise<RecoveredPlan[]> {
      this.recovered = await recoverInterruptedPlans()
      if (this.recovered.length) {
        notifyDbChange('all')
      }
      await this.loadAll()
      return this.recovered
    },
    findFilm(id: number): FilmStock | undefined {
      return this.films.find((film) => film.id === id)
    },
    findDeveloper(id: number): Developer | undefined {
      return this.developers.find((developer) => developer.id === id)
    },
    async reserve(input: ReserveInput): Promise<DevPlan> {
      try {
        const plan = await reservePlan(input)
        notifyDbChange('all')
        await this.loadAll()
        return plan
      } catch (error) {
        await this.loadAll()
        throw error
      }
    },
    async confirm(planId: number, payload: PlanFormPayload): Promise<number> {
      try {
        const { runId } = await confirmPlan(planId, normalizeConfirm(payload))
        notifyDbChange('all')
        await this.loadAll()
        return runId
      } catch (error) {
        await this.loadAll()
        throw error
      }
    },
    async retry(planId: number, payload: PlanFormPayload): Promise<number> {
      try {
        const { runId } = await retryInterruptedPlan(planId, normalizeConfirm(payload))
        notifyDbChange('all')
        await this.loadAll()
        return runId
      } catch (error) {
        await this.loadAll()
        throw error
      }
    },
    async release(planId: number, reason: string): Promise<void> {
      await releasePlan(planId, reason)
      notifyDbChange('all')
      await this.loadAll()
    },
    armFailure(): void {
      armSaveFailure()
      this.failArmed = true
    }
  }
})

function normalizeConfirm(payload: PlanFormPayload): ConfirmInput {
  return {
    actualTempC: Number(payload.actualTempC),
    actualMinutes: Number(payload.actualMinutes),
    tankType: payload.tankType,
    runDate: payload.runDate,
    result: payload.result.trim()
  }
}
