import { defineStore } from 'pinia'
import { db } from '../utils/db'
import { notifyDbChange } from '../utils/dbSync'
import {
  cancelPlan as cancelLedgerPlan,
  confirmPlan as confirmLedgerPlan,
  reservePlan,
  retryConfirmPlan as retryLedgerPlan,
  type ConfirmOverrides,
  type ReserveResult
} from '../utils/planLedger'
import type { DevPlan, PlanItem } from '../types/plan'

interface ReservePayload {
  planNo: string
  tankType: '双联罐' | '深罐'
  runDate: string
  actualTempC: number
  actualMinutes: number
  result: string
  items: PlanItem[]
  expectedVersions?: {
    films: Map<number, number>
    developers: Map<number, number>
  }
}

export const usePlanStore = defineStore('plan', {
  state: () => ({
    plans: [] as DevPlan[],
    loading: false,
    acting: false
  }),
  getters: {
    pendingPlans: (state) => state.plans.filter((plan) => plan.status === '待确认' || plan.status === '保存失败'),
    confirmedPlans: (state) => state.plans.filter((plan) => plan.status === '已实冲'),
    /** 全店待确认占用卷数（去重 itemKey） */
    pendingRollCount: (state) => new Set(
      state.plans
        .filter((plan) => plan.status === '待确认' || plan.status === '保存失败')
        .flatMap((plan) => plan.items.map((item) => item.itemKey))
    ).size,
    failedPlans: (state) => state.plans.filter((plan) => plan.status === '保存失败')
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.plans = await db.plans.orderBy('updatedAt').reverse().toArray()
      } finally {
        this.loading = false
      }
    },
    async reserve(payload: ReservePayload): Promise<ReserveResult> {
      this.acting = true
      try {
        const result = await reservePlan(db, payload)
        if (result.status === 'ok') {
          await this.load()
          notifyDbChange('plan')
        }
        return result
      } finally {
        this.acting = false
      }
    },
    async confirm(planId: number, overrides: ConfirmOverrides = {}): Promise<DevPlan> {
      this.acting = true
      try {
        const plan = await confirmLedgerPlan(db, planId, overrides)
        await this.load()
        notifyDbChange('plan')
        return plan
      } finally {
        this.acting = false
      }
    },
    async retry(planId: number, overrides: ConfirmOverrides = {}): Promise<void> {
      this.acting = true
      try {
        await retryLedgerPlan(db, planId, overrides)
        await this.load()
        notifyDbChange('plan')
      } finally {
        this.acting = false
      }
    },
    async cancel(planId: number): Promise<void> {
      this.acting = true
      try {
        await cancelLedgerPlan(db, planId)
        await this.load()
        notifyDbChange('plan')
      } finally {
        this.acting = false
      }
    }
  }
})
