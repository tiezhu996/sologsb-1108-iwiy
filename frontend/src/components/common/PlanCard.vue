<script setup lang="ts">
import { computed, reactive } from 'vue'
import PushPullTag from './PushPullTag.vue'
import type { DevPlan } from '../../types/plan'
import type { DevRecipe } from '../../types/dev-recipe'
import type { FilmStock } from '../../types/film-stock'
import type { Developer } from '../../types/developer'
import { availableRollsFor, availableDeveloperRolls } from '../../utils/db'

const props = defineProps<{
  plan: DevPlan
  recipes: DevRecipe[]
  films: FilmStock[]
  developers: Developer[]
  confirming: boolean
  /** 已落地的正式记录数（保存中断时用于断点续传展示） */
  landedCount?: number
  /** 已转实冲的卷键，用于逐卷标记状态 */
  landedKeys?: string[]
}>()

const emit = defineEmits<{
  (event: 'confirm', plan: DevPlan): void
  (event: 'retry', plan: DevPlan): void
  (event: 'cancel', plan: DevPlan): void
}>()

const filmById = computed(() => new Map(props.films.map((film) => [film.id as number, film])))
const developerById = computed(() => new Map(props.developers.map((developer) => [developer.id as number, developer])))
const recipeById = computed(() => new Map(props.recipes.map((recipe) => [recipe.id as number, recipe])))

const isFailed = computed(() => props.plan.status === '保存失败')
const consumedCount = computed(() => props.landedCount ?? props.plan.runIds.length)
const toneClass = computed(() => (isFailed.value ? 'status--danger' : 'status--warning'))

function primaryAction(plan: DevPlan): void {
  if (isFailed.value) emit('retry', plan)
  else emit('confirm', plan)
}

function itemRecipe(item: DevPlan['items'][number]): DevRecipe | undefined {
  return recipeById.value.get(item.recipeId)
}

function cancelAction(plan: DevPlan): void {
  emit('cancel', plan)
}

/** 该卡自身的胶片占用（可能已部分转实冲，用于逐卷展示状态） */
function filmAvailability(filmId: number): string {
  const film = filmById.value.get(filmId)
  if (!film) return '台账中不存在'
  return `可用 ${availableRollsFor(film)} / ${film.rollsLeft} 卷`
}

function developerAvailability(developerId: number): string {
  const developer = developerById.value.get(developerId)
  if (!developer) return '台账中不存在'
  return `可冲 ${availableDeveloperRolls(developer)} / 余 ${Math.max(0, developer.maxRolls - developer.usedRolls)} 卷`
}
</script>

<template>
  <article class="entity-card plan-card" :class="{ 'plan-card--failed': isFailed }" data-testid="row-plan">
    <div class="entity-card__main">
      <div class="entity-card__title">
        <div>
          <span class="status-chip" :class="toneClass" data-testid="plan-status">{{ plan.status }}</span>
          <h2>{{ plan.planNo }}</h2>
          <p>{{ plan.runDate }} · {{ plan.tankType }} · 共 {{ plan.items.length }} 卷</p>
        </div>
        <div v-if="plan.planNo" class="plan-card__actions">
          <button
            type="button"
            class="primary-button"
            data-testid="confirm-plan"
            :disabled="confirming"
            @click="primaryAction(plan)"
          >
            {{ confirming ? '处理中…' : isFailed ? `恢复并重试（${consumedCount}/${plan.items.length} 已落地）` : '确认实冲' }}
          </button>
          <button
            type="button"
            class="ghost-button"
            data-testid="cancel-plan"
            :disabled="confirming"
            @click="cancelAction(plan)"
          >
            取消排片
          </button>
        </div>
      </div>

      <div v-if="isFailed" class="plan-card__alert" data-testid="plan-error">
        <strong>保存中断：</strong>{{ plan.lastError || '正式记录未全部落地，胶片与显影液占用已保留，可直接重试。' }}
      </div>

      <ul class="plan-items">
        <li
          v-for="(item, index) in plan.items"
          class="plan-items__row"
          :class="{ 'plan-items__row--done': (landedKeys ?? []).includes(item.itemKey) }"
          :key="item.itemKey"
        >
          <span class="plan-items__no">#{{ index + 1 }}</span>
          <div class="plan-items__resource">
            <strong>{{ item.filmLabel }}</strong>
            <small>{{ filmAvailability(item.filmId) }}</small>
          </div>
          <div class="plan-items__resource">
            <strong>{{ item.developerLabel }}</strong>
            <small>{{ developerAvailability(item.developerId) }}</small>
          </div>
          <PushPullTag v-if="itemRecipe(item)" :value="itemRecipe(item)?.pushPull ?? 'N'" />
          <span v-if="(landedKeys ?? []).includes(item.itemKey)" class="status-chip status--ok">已实冲</span>
        </li>
      </ul>

      <dl class="data-pairs">
        <div><dt>预填温度 / 时间</dt><dd>{{ plan.actualTempC }}°C · {{ plan.actualMinutes }} 分钟</dd></div>
        <div><dt>排片备注</dt><dd>{{ plan.result || '—' }}</dd></div>
      </dl>
    </div>
  </article>
</template>
