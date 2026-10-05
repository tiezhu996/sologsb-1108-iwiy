<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElNotification } from 'element-plus'
import EmptyPanel from '../components/common/EmptyPanel.vue'
import PlanCard from '../components/common/PlanCard.vue'
import { useDeveloperStore } from '../stores/developerStore'
import { useFilmStore } from '../stores/filmStore'
import { usePlanStore } from '../stores/planStore'
import { useRecipeStore } from '../stores/recipeStore'
import { useRunStore } from '../stores/runStore'
import type { DevRecipe } from '../types/dev-recipe'
import type { DevPlan, PlanConflict, PlanItem } from '../types/plan'
import { availableDeveloperRolls, availableRollsFor } from '../utils/db'
import { onDbChange } from '../utils/dbSync'
import { armConfirmationFailure } from '../utils/planLedger'

interface DraftRow {
  key: string
  filmId: number | null
  developerId: number | null
}

const filmStore = useFilmStore()
const developerStore = useDeveloperStore()
const planStore = usePlanStore()
const recipeStore = useRecipeStore()
const runStore = useRunStore()

const showForm = ref(false)
const saving = ref(false)
const confirmingId = ref<number | null>(null)
const simulateFailure = ref(false)
const conflictNotice = ref<PlanConflict[]>([])
const today = new Date().toISOString().slice(0, 10)

const form = reactive({
  planNo: '',
  tankType: '双联罐' as DevPlan['tankType'],
  runDate: today,
  actualTempC: 20,
  actualMinutes: 9,
  result: '',
  rows: [{ key: newRowKey(), filmId: null as number | null, developerId: null as number | null }]
})

let rowSeq = 0
function newRowKey(): string {
  rowSeq += 1
  return `draft-${Date.now()}-${rowSeq}`
}

const filmById = computed(() => new Map(filmStore.films.map((film) => [film.id as number, film])))
const developerById = computed(() => new Map(developerStore.developers.map((developer) => [developer.id as number, developer])))

const selectableFilms = computed(() => filmStore.films.filter((film) => availableRollsFor(film) > 0))
const activeDevelopers = computed(() => developerStore.developers.filter((developer) => developer.state !== '报废'))

function developersForFilm(filmId: number | null): typeof activeDevelopers.value {
  if (filmId === null) return activeDevelopers.value
  const supportedIds = new Set(
    recipeStore.recipes
      .filter((recipe) => recipe.filmId === filmId)
      .map((recipe) => recipe.developerId)
  )
  return activeDevelopers.value.filter((developer) => supportedIds.has(developer.id as number))
}

function recipeForRow(row: DraftRow): DevRecipe | undefined {
  if (row.filmId === null || row.developerId === null) return undefined
  return recipeStore.recipes.find(
    (recipe) => recipe.filmId === row.filmId && recipe.developerId === row.developerId
  )
}

function filmLabel(filmId: number): string {
  const film = filmById.value.get(filmId)
  return film ? `${film.model} ${film.format} · ${film.emulsionNo}` : `胶片 #${filmId}`
}

function addRow(): void {
  form.rows.push({ key: newRowKey(), filmId: null, developerId: null })
}

function removeRow(key: string): void {
  if (form.rows.length === 1) return
  const index = form.rows.findIndex((row) => row.key === key)
  if (index >= 0) form.rows.splice(index, 1)
}

function onFilmPicked(row: DraftRow): void {
  // 换胶片后，若原显影液不再适配该胶片，清空等待重选
  if (row.developerId !== null && !developersForFilm(row.filmId).some((developer) => developer.id === row.developerId)) {
    row.developerId = null
  }
}

/** 草稿内对每种资源的需求合计，用于即时提示余量 */
const localDemand = computed(() => {
  const films = new Map<number, number>()
  const developers = new Map<number, number>()
  for (const row of form.rows) {
    if (row.filmId !== null) films.set(row.filmId, (films.get(row.filmId) ?? 0) + 1)
    if (row.developerId !== null) developers.set(row.developerId, (developers.get(row.developerId) ?? 0) + 1)
  }
  return { films, developers }
})

function filmRowState(filmId: number): { available: number; requested: number; tight: boolean } {
  const film = filmById.value.get(filmId)
  const available = film ? availableRollsFor(film) : 0
  const requested = localDemand.value.films.get(filmId) ?? 0
  return { available, requested, tight: requested > available }
}

function developerRowState(developerId: number): { available: number; requested: number; tight: boolean } {
  const developer = developerById.value.get(developerId)
  const available = developer ? availableDeveloperRolls(developer) : 0
  const requested = localDemand.value.developers.get(developerId) ?? 0
  return { available, requested, tight: requested > available }
}

function suggestPlanNo(): string {
  const stamp = form.runDate.replace(/-/g, '').slice(2)
  const sameDay = planStore.plans.filter((plan) => plan.planNo.includes(`-${stamp}-`)).length
  return `P-${stamp}-${String(sameDay + 1).padStart(2, '0')}`
}

function resetForm(): void {
  form.planNo = suggestPlanNo()
  form.tankType = '双联罐'
  form.runDate = today
  form.actualTempC = 20
  form.actualMinutes = 9
  form.result = ''
  form.rows = [{ key: newRowKey(), filmId: null, developerId: null }]
  conflictNotice.value = []
}

function openForm(): void {
  if (!form.planNo) resetForm()
  // 每次打开都以刚加载的资源版本为基准，避免长时间停留导致的误判
  captureVersions()
  conflictNotice.value = []
  showForm.value = !showForm.value
}

function buildItems(): PlanItem[] | null {
  const items: PlanItem[] = []
  for (const [index, row] of form.rows.entries()) {
    if (row.filmId === null || row.developerId === null) {
      ElMessage.warning(`第 ${index + 1} 卷还没有选好胶片批次或显影液`)
      return null
    }
    const recipe = recipeForRow(row)
    if (!recipe || recipe.id === undefined) {
      ElMessage.warning(`第 ${index + 1} 卷缺少匹配的冲洗配方，请先在配方表补齐`)
      return null
    }
    const film = filmById.value.get(row.filmId)
    const developer = developerById.value.get(row.developerId)
    items.push({
      itemKey: `${form.planNo}-${String(index + 1).padStart(2, '0')}`,
      filmId: row.filmId,
      filmLabel: film ? `${film.model} ${film.format}` : `胶片 #${row.filmId}`,
      developerId: row.developerId,
      developerLabel: developer?.name ?? `显影液 #${row.developerId}`,
      recipeId: recipe.id,
      rollCount: 1,
      pushPull: recipe.pushPull
    })
  }
  return items
}

/** 打开表单时的资源版本快照，提交时发现版本落后即可判定被别的标签页抢先 */
const versionSnapshot = reactive({
  films: new Map<number, number>(),
  developers: new Map<number, number>()
})

function captureVersions(): void {
  versionSnapshot.films = new Map(filmStore.films.map((film) => [film.id as number, film.version ?? 0]))
  versionSnapshot.developers = new Map(developerStore.developers.map((developer) => [developer.id as number, developer.version ?? 0]))
}

/** 表单开着时资源被别的标签页改动：提示用户重新核对，但不打断填写 */
const resourceVersionSig = computed(() => [
  ...filmStore.films.map((film) => `${film.id}:${film.version ?? 0}`),
  ...developerStore.developers.map((developer) => `${developer.id}:${developer.version ?? 0}`)
].join('|'))
watch(resourceVersionSig, (next, prev) => {
  if (!showForm.value || prev === undefined) return
  const staleFilm = filmStore.films.some((film) => film.id !== undefined && versionSnapshot.films.has(film.id) && versionSnapshot.films.get(film.id) !== (film.version ?? 0))
  const staleDev = developerStore.developers.some((developer) => developer.id !== undefined && versionSnapshot.developers.has(developer.id) && versionSnapshot.developers.get(developer.id) !== (developer.version ?? 0))
  if (staleFilm || staleDev) {
    ElNotification({
      title: '余量已被其它标签页更新',
      type: 'info',
      message: '你表单里看到的资源余量可能已过时，请重新核对胶片批次与显影液后再提交。'
    })
  }
})

async function submitPlan(): Promise<void> {
  if (!form.planNo.trim()) {
    ElMessage.warning('请填写本批排片号')
    return
  }
  const items = buildItems()
  if (!items) return

  const overflowFilm = [...localDemand.value.films.entries()]
    .some(([filmId, requested]) => requested > filmRowState(filmId).available)
  const overflowDev = [...localDemand.value.developers.entries()]
    .some(([developerId, requested]) => requested > developerRowState(developerId).available)
  if (overflowFilm || overflowDev) {
    ElMessage.warning('当前选择的余量不足，请调整胶片批次或显影液后再排片')
    return
  }

  saving.value = true
  try {
    const result = await planStore.reserve({
      planNo: form.planNo.trim(),
      tankType: form.tankType,
      runDate: form.runDate,
      actualTempC: Number(form.actualTempC),
      actualMinutes: Number(form.actualMinutes),
      result: form.result.trim(),
      items,
      expectedVersions: {
        films: versionSnapshot.films,
        developers: versionSnapshot.developers
      }
    })
    if (result.status === 'ok') {
      if (simulateFailure.value && result.plan.id !== undefined) {
        armConfirmationFailure(result.plan.id, Math.max(1, Math.floor(items.length / 2)))
      }
      ElMessage.success(`排片 ${result.plan.planNo} 已占用两类余量，确认实冲后转为正式记录`)
      resetForm()
      showForm.value = false
      return
    }
    if (result.status === 'duplicate') {
      ElMessage.warning(`排片号 ${result.planNo} 已存在，请换一个批次号`)
      return
    }
    conflictNotice.value = result.conflicts
    ElNotification({
      title: '资源已被他人先占用',
      type: 'warning',
      duration: 0,
      dangerouslyUseHTMLString: true,
      message: result.conflicts
        .map((conflict) => `<div>· ${conflict.resourceLabel}：需要 ${conflict.requested}，可用 ${conflict.available}（先落地：${conflict.blockedByPlan}）</div>`)
        .join('')
    })
  } finally {
    saving.value = false
  }
}

async function confirm(plan: DevPlan): Promise<void> {
  if (plan.id === undefined) return
  confirmingId.value = plan.id
  try {
    await planStore.confirm(plan.id)
    ElMessage.success(`批次 ${plan.planNo} 已实冲，正式记录与台账余量已同步`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '确认失败，占用已保留，可重试')
  } finally {
    confirmingId.value = null
  }
}

async function retry(plan: DevPlan): Promise<void> {
  if (plan.id === undefined) return
  confirmingId.value = plan.id
  try {
    await planStore.retry(plan.id)
    ElMessage.success(`批次 ${plan.planNo} 恢复完成，未落地部分已转为正式记录`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '重试失败，占用仍保留')
  } finally {
    confirmingId.value = null
  }
}

async function cancel(plan: DevPlan): Promise<void> {
  if (plan.id === undefined) return
  confirmingId.value = plan.id
  try {
    await planStore.cancel(plan.id)
    ElMessage.success(`排片 ${plan.planNo} 已取消，两类余量占用已释放`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '取消失败')
  } finally {
    confirmingId.value = null
  }
}

const pendingPlans = computed(() => planStore.pendingPlans)
const recentConfirmed = computed(() => planStore.confirmedPlans.slice(0, 5))

/** 每个待确认计划已落地的正式记录卷键 / 数量，用于中断后的逐卷状态 */
const landedByPlan = computed(() => {
  const map = new Map<number, { keys: Set<string>; count: number }>()
  for (const run of runStore.runs) {
    if (run.planId === undefined || !run.itemKey) continue
    const entry = map.get(run.planId) ?? { keys: new Set<string>(), count: 0 }
    entry.keys.add(run.itemKey)
    entry.count += 1
    map.set(run.planId, entry)
  }
  return map
})

function landed(plan: DevPlan): { keys: string[]; count: number } {
  const entry = plan.id !== undefined ? landedByPlan.value.get(plan.id) : undefined
  return { keys: entry ? [...entry.keys] : [], count: entry?.count ?? 0 }
}

let unsubscribe: Array<() => void> = []
onMounted(async () => {
  await Promise.all([
    filmStore.load(),
    developerStore.load(),
    recipeStore.load(),
    runStore.load(),
    planStore.load()
  ])
  resetForm()
  captureVersions()
  unsubscribe = [
    onDbChange('plan', () => { void refreshAll() }),
    onDbChange('film', () => { void filmStore.load() }),
    onDbChange('developer', () => { void developerStore.load() }),
    onDbChange('run', () => { void runStore.load() })
  ]
})

onUnmounted(() => {
  unsubscribe.forEach((off) => off())
})

async function refreshAll(): Promise<void> {
  await Promise.all([planStore.load(), filmStore.load(), developerStore.load(), runStore.load()])
}
</script>

<template>
  <section class="page-shell">
    <header class="page-hero page-hero--compact">
      <div>
        <span class="eyebrow">SCHEDULE BENCH</span>
        <h1>待冲批次排片</h1>
        <p>排片先占用胶片批次与显影液工作液两类余量；确认实冲后转成正式记录，保存中断会保留占用并可重试。</p>
      </div>
      <button type="button" class="primary-button" data-testid="new-plan" @click="openForm">
        {{ showForm ? '收起排片' : '新建排片' }}
      </button>
    </header>

    <div class="stat-strip">
      <div class="simple-stat"><span>待确认计划</span><strong data-testid="count-pending">{{ pendingPlans.length }}</strong><small>批</small></div>
      <div class="simple-stat"><span>占用卷数</span><strong>{{ planStore.pendingRollCount }}</strong><small>卷</small></div>
      <div class="simple-stat"><span>胶片可用</span><strong>{{ filmStore.totalAvailableRolls }}</strong><small>/ {{ filmStore.totalRolls }} 卷</small></div>
      <div class="simple-stat"><span>显影液可冲</span><strong>{{ developerStore.availableRolls }}</strong><small>卷</small></div>
    </div>

    <form v-if="showForm" class="inline-form" data-testid="form-plan" @submit.prevent="submitPlan">
      <div class="inline-form__head">
        <div>
          <h2>编排本批待冲胶片</h2>
          <p>同一乳剂批次或工作液被两个标签页同时提交时，只有先落地者占用成功；冲突后请改选可用资源。</p>
        </div>
      </div>
      <div class="form-grid form-grid--three">
        <label>
          <span>排片号</span>
          <input v-model="form.planNo" data-testid="field-planNo" type="text" placeholder="如 P-261005-01" />
        </label>
        <label>
          <span>罐型</span>
          <select v-model="form.tankType" data-testid="field-tankType">
            <option value="双联罐">双联罐</option>
            <option value="深罐">深罐</option>
          </select>
        </label>
        <label>
          <span>计划冲洗日期</span>
          <input v-model="form.runDate" data-testid="field-runDate" type="date" />
        </label>
        <label>
          <span>预填温度</span>
          <input v-model.number="form.actualTempC" data-testid="field-actualTempC" type="number" min="10" max="50" step="0.1" />
        </label>
        <label>
          <span>预填时间（分钟）</span>
          <input v-model.number="form.actualMinutes" data-testid="field-actualMinutes" type="number" min="0.25" max="90" step="0.25" />
        </label>
        <label>
          <span>排片备注</span>
          <input v-model="form.result" data-testid="field-result" type="text" placeholder="如 阴天外景，注意暗部" />
        </label>
      </div>

      <div class="plan-editor">
        <div class="plan-editor__head">
          <h3>卷次与资源</h3>
          <button type="button" class="ghost-button" data-testid="add-row" @click="addRow">加一卷</button>
        </div>
        <div v-for="row in form.rows" :key="row.key" class="plan-editor__row" data-testid="row-draft">
          <label>
            <span>乳剂批次</span>
            <select v-model="row.filmId" data-testid="row-film" @change="onFilmPicked(row)">
              <option :value="null" disabled>选择胶片批次</option>
              <option v-for="film in selectableFilms" :key="film.id" :value="film.id">
                {{ filmLabel(film.id as number) }}（可 {{ availableRollsFor(film) }} 卷）
              </option>
            </select>
          </label>
          <label>
            <span>显影液工作液</span>
            <select v-model="row.developerId" data-testid="row-developer">
              <option :value="null" disabled>选择工作液</option>
              <option v-for="developer in developersForFilm(row.filmId)" :key="developer.id" :value="developer.id">
                {{ developer.name }}（可冲 {{ availableDeveloperRolls(developer) }} 卷）
              </option>
            </select>
          </label>
          <div class="plan-editor__hint">
            <template v-if="row.filmId !== null">
              <small :class="{ 'text-danger': filmRowState(row.filmId).tight }">
                本批需 {{ filmRowState(row.filmId).requested }} / 可用 {{ filmRowState(row.filmId).available }} 卷
              </small>
            </template>
            <template v-if="row.developerId !== null">
              <small :class="{ 'text-danger': developerRowState(row.developerId).tight }">
                本批需 {{ developerRowState(row.developerId).requested }} / 可冲 {{ developerRowState(row.developerId).available }} 卷
              </small>
            </template>
            <small v-if="row.filmId !== null && row.developerId !== null && !recipeForRow(row)" class="text-danger">
              该胶片与显影液缺少配方
            </small>
          </div>
          <button
            type="button"
            class="text-button text-button--danger"
            data-testid="remove-row"
            :disabled="form.rows.length === 1"
            @click="removeRow(row.key)"
          >
            移除
          </button>
        </div>
      </div>

      <div v-if="conflictNotice.length" class="plan-conflict" data-testid="conflict-panel">
        <strong>资源冲突，请改选后重试：</strong>
        <ul>
          <li v-for="(conflict, index) in conflictNotice" :key="index">
            {{ conflict.resourceLabel }}：本批需要 {{ conflict.requested }} 卷，当前可用 {{ conflict.available }} 卷，
            已被排片「{{ conflict.blockedByPlan }}」先占用。
          </li>
        </ul>
      </div>

      <label class="plan-simulate">
        <input v-model="simulateFailure" type="checkbox" data-testid="simulate-failure" />
        <span>演示用：确认实冲时在中途制造一次保存中断（验证占用保留与断点续传）</span>
      </label>

      <div class="form-actions">
        <button type="button" class="ghost-button" @click="showForm = false">取消</button>
        <button type="submit" class="primary-button" data-testid="submit-plan" :disabled="saving">
          {{ saving ? '占用中…' : '占用余量并排片' }}
        </button>
      </div>
    </form>

    <section class="plan-section">
      <h2 class="plan-section__title">待确认 / 中断恢复</h2>
      <div v-if="pendingPlans.length" class="plan-list">
        <PlanCard
          v-for="plan in pendingPlans"
          :key="plan.id"
          :plan="plan"
          :recipes="recipeStore.recipes"
          :films="filmStore.films"
          :developers="developerStore.developers"
          :confirming="confirmingId === plan.id"
          :landed-keys="landed(plan).keys"
          :landed-count="landed(plan).count"
          @confirm="confirm"
          @retry="retry"
          @cancel="cancel"
        />
      </div>
      <EmptyPanel
        v-else
        title="没有进行中的排片"
        description="新建排片后，胶片余量与显影液可冲卷数会先被占用，直到确认实冲或取消。"
      />
    </section>

    <section class="plan-section">
      <h2 class="plan-section__title">最近已实冲批次</h2>
      <div v-if="recentConfirmed.length" class="run-list">
        <article v-for="plan in recentConfirmed" :key="plan.id" class="run-card" data-testid="row-confirmed">
          <div class="run-card__date">
            <strong>{{ plan.runDate.slice(5) }}</strong>
            <span>{{ plan.runDate.slice(0, 4) }}</span>
          </div>
          <div class="run-card__body">
            <div class="entity-card__title">
              <div>
                <h2>{{ plan.planNo }}</h2>
                <p>{{ plan.tankType }} · {{ plan.items.length }} 卷 · 正式记录 {{ plan.runIds.length }} 条</p>
              </div>
              <span class="status-chip status--ok">已实冲</span>
            </div>
            <blockquote v-if="plan.result">{{ plan.result }}</blockquote>
          </div>
        </article>
      </div>
      <EmptyPanel v-else title="还没有已实冲批次" description="待确认排片点击“确认实冲”后会在这里沉淀。" />
    </section>
  </section>
</template>
