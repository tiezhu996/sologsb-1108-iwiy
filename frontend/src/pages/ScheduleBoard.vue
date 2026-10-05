<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import EmptyPanel from '../components/common/EmptyPanel.vue'
import { usePlanStore } from '../stores/planStore'
import { useFilmStore } from '../stores/filmStore'
import { useDeveloperStore } from '../stores/developerStore'
import { useRunStore } from '../stores/runStore'
import {
  PlanCapacityError,
  PlanConflictError,
  PlanSaveInterruptedError,
  reconcile,
  type ReconcileReport
} from '../services/planService'
import { onDbChange } from '../utils/sync'
import type { TankType } from '../types/dev-run'
import type { DevPlan } from '../types/dev-plan'

interface ReserveForm {
  batchNo: string
  filmId: number | undefined
  developerId: number | undefined
  rolls: number
}

interface ConfirmForm {
  actualTempC: number
  actualMinutes: number
  tankType: TankType
  runDate: string
  result: string
}

const planStore = usePlanStore()
const filmStore = useFilmStore()
const developerStore = useDeveloperStore()
const runStore = useRunStore()

const showForm = ref(false)
const saving = ref(false)
const today = new Date().toISOString().slice(0, 10)
const conflictTip = ref<string>('')
const report = ref<ReconcileReport | null>(null)
const checking = ref(false)

const form = reactive<ReserveForm>({
  batchNo: `P-${today.replace(/-/g, '')}-01`,
  filmId: undefined,
  developerId: undefined,
  rolls: 1
})

// 提交时携带的乐观锁版本（资源被其他标签页改动后会冲突）
const filmRevision = computed(() => form.filmId === undefined ? 0 : planStore.findFilm(form.filmId)?.revision ?? 0)
const developerRevision = computed(() => form.developerId === undefined ? 0 : planStore.findDeveloper(form.developerId)?.revision ?? 0)

const selectableFilms = computed(() =>
  planStore.films
    .filter((film) => film.rollsLeft > 0)
    .map((film) => ({ film, available: film.rollsLeft }))
)
const selectableDevelopers = computed(() =>
  planStore.developers
    .filter((developer) => developer.state !== '报废' && planStore.developerAvailable(developer) > 0)
    .map((developer) => ({ developer, available: planStore.developerAvailable(developer) }))
)

function makeConfirmForm(): ConfirmForm {
  return { actualTempC: 20, actualMinutes: 8, tankType: '双联罐', runDate: today, result: '' }
}

// 每个待确认/中断计划一张内联确认表单
const confirmForms = reactive<Record<number, ConfirmForm>>({})
const busyId = ref<number | null>(null)

function ensureConfirmForm(plan: DevPlan): ConfirmForm {
  if (!confirmForms[plan.id as number]) {
    confirmForms[plan.id as number] = makeConfirmForm()
  }
  return confirmForms[plan.id as number]
}

function filmLabel(id: number): string {
  const film = planStore.findFilm(id)
  return film ? `${film.model} · ${film.format} · ${film.emulsionNo}` : `已删除胶片 #${id}`
}

function developerLabel(id: number): string {
  const developer = planStore.findDeveloper(id)
  return developer ? `${developer.name}（${developer.dilution}）` : `已删除工作液 #${id}`
}

function planRunLabel(plan: DevPlan): string {
  return `${plan.batchNo} · ${filmLabel(plan.filmId)} / ${developerLabel(plan.developerId)} · ${plan.rolls} 卷`
}

async function submitReserve(): Promise<void> {
  conflictTip.value = ''
  if (!form.batchNo.trim()) {
    ElMessage.warning('请填写待冲批次号')
    return
  }
  if (form.filmId === undefined) {
    ElMessage.warning('请选择乳剂批次')
    return
  }
  if (form.developerId === undefined) {
    ElMessage.warning('请选择显影液工作液')
    return
  }
  saving.value = true
  try {
    const plan = await planStore.reserve({
      batchNo: form.batchNo.trim(),
      filmId: form.filmId,
      developerId: form.developerId,
      rolls: Number(form.rolls),
      expectedFilmRevision: filmRevision.value,
      expectedDeveloperRevision: developerRevision.value
    })
    ElMessage.success(`已占用 ${plan.rolls} 卷胶片与等量显影液余量，等待确认实冲`)
    form.batchNo = `P-${today.replace(/-/g, '')}-${String(planStore.plans.length + 1).padStart(2, '0')}`
    showForm.value = false
  } catch (error) {
    if (error instanceof PlanConflictError) {
      conflictTip.value = error.message
      ElMessage.error('资源冲突：另一个标签页已抢先提交，请在下方重新选择可用资源')
    } else if (error instanceof PlanCapacityError) {
      ElMessage.error(error.message)
    } else {
      ElMessage.error(error instanceof Error ? error.message : '排片失败')
    }
  } finally {
    saving.value = false
  }
}

async function submitConfirm(plan: DevPlan): Promise<void> {
  const payload = ensureConfirmForm(plan)
  if (!payload.result.trim()) {
    ElMessage.warning('请填写实冲结果评价')
    return
  }
  busyId.value = plan.id as number
  try {
    await planStore.confirm(plan.id as number, payload)
    await Promise.all([filmStore.load(), developerStore.load(), runStore.load()])
    ElMessage.success('已确认实冲：占用转为正式记录，胶片与显影液台账已更新')
  } catch (error) {
    if (error instanceof PlanSaveInterruptedError) {
      ElMessage.warning(error.message)
    } else {
      ElMessage.error(error instanceof Error ? error.message : '确认失败')
    }
  } finally {
    busyId.value = null
  }
}

async function submitRetry(plan: DevPlan): Promise<void> {
  const payload = ensureConfirmForm(plan)
  if (!payload.result.trim()) {
    ElMessage.warning('请填写实冲结果评价后再重试')
    return
  }
  busyId.value = plan.id as number
  try {
    await planStore.retry(plan.id as number, payload)
    await Promise.all([filmStore.load(), developerStore.load(), runStore.load()])
    ElMessage.success('重试成功，正式记录已补写')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '重试失败')
  } finally {
    busyId.value = null
  }
}

async function cancelPlan(plan: DevPlan): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `释放「${plan.batchNo}」占用的 ${plan.rolls} 卷胶片与显影液余量？`,
      '取消待冲计划',
      { type: 'warning', confirmButtonText: '释放占用', cancelButtonText: '再想想' }
    )
  } catch {
    return
  }
  await planStore.release(plan.id as number, '用户主动取消计划')
  ElMessage.success('占用已恢复，资源可重新排片')
}

async function abandonInterrupted(plan: DevPlan): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `放弃「${plan.batchNo}」并恢复其占用的 ${plan.rolls} 卷余量？`,
      '中断计划处理',
      { type: 'warning', confirmButtonText: '恢复占用', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await planStore.release(plan.id as number, '保存中断后用户放弃，占用已恢复')
  ElMessage.success('占用已恢复')
}

function armFailure(): void {
  planStore.armFailure()
  ElMessage.info('已设置故障注入：下一次「确认实冲」会在保存时中断（占用保留，可重试）')
}

async function runReconcile(): Promise<void> {
  checking.value = true
  try {
    report.value = await reconcile()
    if (report.value.ok && report.value.issues.length === 0) {
      ElMessage.success('对账通过：胶片台账、显影液余量与实冲记录完全一致')
    } else if (report.value.ok) {
      ElMessage.warning('账目平衡，存在超限预警')
    } else {
      ElMessage.error('对账发现不平账目，请查看明细')
    }
  } finally {
    checking.value = false
  }
}

let unsubscribe: (() => void) | null = null

onMounted(async () => {
  // 启动恢复已在 App.vue 统一执行；这里只加载数据
  await Promise.all([
    filmStore.load(),
    developerStore.load(),
    runStore.load(),
    planStore.loadAll()
  ])
  await runReconcile()
  unsubscribe = onDbChange((topic) => {
    if (topic === 'all' || topic === 'plans' || topic === 'resources') {
      void planStore.loadAll()
      void filmStore.load()
      void developerStore.load()
      void runStore.load()
    }
  })
})

onUnmounted(() => {
  unsubscribe?.()
})
</script>

<template>
  <section class="page-shell">
    <header class="page-hero page-hero--compact">
      <div>
        <span class="eyebrow">SCHEDULE DESK</span>
        <h1>待冲批次排片</h1>
        <p>排片先原子占用胶片余量与显影液可冲数，确认实冲后转为正式记录；保存中断可恢复占用并重试。</p>
      </div>
      <div class="hero-actions">
        <button type="button" class="ghost-button" data-testid="arm-failure" @click="armFailure">
          注入保存故障
        </button>
        <button type="button" class="primary-button" data-testid="new-plan" @click="showForm = !showForm">
          {{ showForm ? '收起表单' : '新建待冲批次' }}
        </button>
      </div>
    </header>

    <div class="stat-strip">
      <div class="simple-stat"><span>待确认</span><strong data-testid="count-reserved">{{ planStore.pendingPlans.length }}</strong><small>个计划</small></div>
      <div class="simple-stat"><span>保存中断</span><strong :class="{ 'text-danger': planStore.interruptedPlans.length > 0 }">{{ planStore.interruptedPlans.length }}</strong><small>待处理</small></div>
      <div class="simple-stat"><span>占用胶片 / 显影液</span>
        <strong>{{ planStore.films.reduce((sum, film) => sum + (film.reservedRolls ?? 0), 0) }} / {{ planStore.developers.reduce((sum, dev) => sum + (dev.reservedRolls ?? 0), 0) }}</strong>
        <small>卷</small>
      </div>
    </div>

    <form v-if="showForm" class="inline-form" data-testid="form-plan" @submit.prevent="submitReserve">
      <div class="inline-form__head">
        <div>
          <h2>占用两类余量</h2>
          <p>提交即在单个事务内占用胶片与显影液；若其他标签页抢先落地，你会看到冲突提示并重选资源。</p>
        </div>
      </div>
      <div v-if="conflictTip" class="conflict-banner" data-testid="conflict-tip">
        <strong>资源冲突</strong>
        <span>{{ conflictTip }}</span>
      </div>
      <div class="form-grid form-grid--three">
        <label>
          <span>待冲批次号</span>
          <input v-model="form.batchNo" data-testid="field-plan-batchNo" type="text" />
        </label>
        <label>
          <span>乳剂批次（可用 / 总量）</span>
          <select v-model.number="form.filmId" data-testid="field-plan-filmId">
            <option :value="undefined" disabled>请选择</option>
            <option v-for="item in selectableFilms" :key="item.film.id" :value="item.film.id">
              {{ item.film.model }} · {{ item.film.format }} · {{ item.film.emulsionNo }}（可排 {{ item.available }} 卷）
            </option>
          </select>
        </label>
        <label>
          <span>显影液工作液（可冲余量）</span>
          <select v-model.number="form.developerId" data-testid="field-plan-developerId">
            <option :value="undefined" disabled>请选择</option>
            <option v-for="item in selectableDevelopers" :key="item.developer.id" :value="item.developer.id">
              {{ item.developer.name }}（可冲 {{ item.available }} 卷）
            </option>
          </select>
        </label>
        <label>
          <span>本次卷数</span>
          <input v-model.number="form.rolls" data-testid="field-plan-rolls" type="number" min="1" max="20" />
        </label>
      </div>
      <div class="form-actions">
        <button type="button" class="ghost-button" @click="showForm = false">取消</button>
        <button type="submit" class="primary-button" data-testid="submit-plan" :disabled="saving">
          {{ saving ? '占用中…' : '占用余量并保存计划' }}
        </button>
      </div>
    </form>

    <section v-if="planStore.interruptedPlans.length" class="plan-group">
      <h2 class="plan-group__title text-danger">保存中断 · 半截计划</h2>
      <p class="plan-group__hint">占用仍然生效、正式记录未写入。可填写结果后「重试保存」，或「恢复占用」释放余量。</p>
      <article v-for="plan in planStore.interruptedPlans" :key="plan.id" class="plan-card plan-card--broken" data-testid="row-interrupted">
        <header class="plan-card__head">
          <div>
            <h3>{{ planRunLabel(plan) }}</h3>
            <small>{{ plan.failReason }} · 提交于 {{ new Date(plan.createdAt).toLocaleString() }}</small>
          </div>
          <div class="plan-card__ops">
            <button type="button" class="ghost-button" data-testid="abandon-interrupted" @click="abandonInterrupted(plan)">恢复占用</button>
            <button type="button" class="primary-button" data-testid="retry-interrupted" :disabled="busyId === plan.id" @click="submitRetry(plan)">
              {{ busyId === plan.id ? '重试中…' : '重试保存' }}
            </button>
          </div>
        </header>
        <div class="confirm-grid">
          <label><span>实测温度</span><input v-model.number="ensureConfirmForm(plan).actualTempC" type="number" min="10" max="50" step="0.1" /></label>
          <label><span>实际时间</span><input v-model.number="ensureConfirmForm(plan).actualMinutes" type="number" min="0.25" max="90" step="0.25" /></label>
          <label><span>罐型</span>
            <select v-model="ensureConfirmForm(plan).tankType">
              <option value="双联罐">双联罐</option>
              <option value="深罐">深罐</option>
            </select>
          </label>
          <label><span>实冲日期</span><input v-model="ensureConfirmForm(plan).runDate" type="date" /></label>
          <label class="confirm-grid__wide"><span>结果评价</span><input v-model="ensureConfirmForm(plan).result" type="text" placeholder="重试时补写正式记录" /></label>
        </div>
      </article>
    </section>

    <section class="plan-group">
      <h2 class="plan-group__title">待确认实冲</h2>
      <div v-if="planStore.pendingPlans.length" class="plan-stack">
        <article v-for="plan in planStore.pendingPlans" :key="plan.id" class="plan-card" data-testid="row-reserved">
          <header class="plan-card__head">
            <div>
              <h3>{{ planRunLabel(plan) }}</h3>
              <small>占用中 · 排片于 {{ new Date(plan.createdAt).toLocaleString() }}</small>
            </div>
            <div class="plan-card__ops">
              <button type="button" class="ghost-button" data-testid="cancel-reserved" @click="cancelPlan(plan)">取消并释放</button>
              <button type="button" class="primary-button" data-testid="confirm-reserved" :disabled="busyId === plan.id" @click="submitConfirm(plan)">
                {{ busyId === plan.id ? '保存中…' : '确认实冲' }}
              </button>
            </div>
          </header>
          <div class="confirm-grid">
            <label><span>实测温度</span><input v-model.number="ensureConfirmForm(plan).actualTempC" data-testid="field-confirm-temp" type="number" min="10" max="50" step="0.1" /></label>
            <label><span>实际时间</span><input v-model.number="ensureConfirmForm(plan).actualMinutes" data-testid="field-confirm-minutes" type="number" min="0.25" max="90" step="0.25" /></label>
            <label><span>罐型</span>
              <select v-model="ensureConfirmForm(plan).tankType" data-testid="field-confirm-tank">
                <option value="双联罐">双联罐</option>
                <option value="深罐">深罐</option>
              </select>
            </label>
            <label><span>实冲日期</span><input v-model="ensureConfirmForm(plan).runDate" data-testid="field-confirm-date" type="date" /></label>
            <label class="confirm-grid__wide"><span>结果评价</span><input v-model="ensureConfirmForm(plan).result" data-testid="field-confirm-result" type="text" placeholder="填写反差、密度与灰雾表现" /></label>
          </div>
        </article>
      </div>
      <EmptyPanel v-else title="没有待确认的排片" description="新建待冲批次，或在另一个标签页查看是否已有同事占用资源。" />
    </section>

    <section class="plan-group reconcile-panel" data-testid="reconcile-panel">
      <header class="reconcile-panel__head">
        <h2>台账对账</h2>
        <button type="button" class="ghost-button" data-testid="run-reconcile" :disabled="checking" @click="runReconcile">
          {{ checking ? '对账中…' : '重新对账' }}
        </button>
      </header>
      <p v-if="!report" class="plan-group__hint">启动时自动对账一次。</p>
      <div v-else-if="report.issues.length === 0" class="reconcile-ok" data-testid="reconcile-ok">
        ✓ 对账通过：胶片台账、显影液余量、实冲记录完全一致（{{ new Date(report.checkedAt).toLocaleTimeString() }}）
      </div>
      <ul v-else class="reconcile-issues">
        <li v-for="(issue, index) in report.issues" :key="index" :class="issue.severity === 'error' ? 'text-danger' : 'text-warning'" data-testid="reconcile-issue">
          <strong>{{ issue.kind === 'film' ? '胶片' : '显影液' }} · {{ issue.label }}</strong>：{{ issue.message }}
        </li>
      </ul>
    </section>

    <section v-if="planStore.historyPlans.length" class="plan-group">
      <h2 class="plan-group__title">计划历史</h2>
      <div class="history-table" data-testid="history-list">
        <article v-for="plan in planStore.historyPlans" :key="plan.id" class="history-row">
          <span class="status-chip" :class="plan.status === 'confirmed' ? 'status--ok' : 'status--warning'">
            {{ plan.status === 'confirmed' ? '已实冲' : '已释放' }}
          </span>
          <div class="history-row__main">
            <strong>{{ plan.batchNo }}</strong>
            <small>{{ filmLabel(plan.filmId) }} / {{ developerLabel(plan.developerId) }} · {{ plan.rolls }} 卷</small>
            <small v-if="plan.note">{{ plan.note }}</small>
          </div>
          <small>{{ new Date(plan.updatedAt).toLocaleString() }}</small>
        </article>
      </div>
    </section>
  </section>
</template>
