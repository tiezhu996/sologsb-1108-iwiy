/**
 * 同源多标签页协作：
 * - notifyDbChange：资源或计划落库后广播，其它标签页立即重载，看到冲突后的最新余量
 * - acquireTabLock：基于 localStorage 的跨页互斥，保证重启恢复时只有一个标签页执行对账
 */

export type DbChangeKind = 'plan' | 'film' | 'developer' | 'run'

const CHANNEL_NAME = 'gbfilmdev-db-change'
const LOCK_PREFIX = 'gbfilmdev-lock:'
const LOCK_TTL_MS = 15_000

let channel: BroadcastChannel | null = null
if (typeof BroadcastChannel !== 'undefined') {
  channel = new BroadcastChannel(CHANNEL_NAME)
}

function storageKey(kind: DbChangeKind): string {
  return `gbfilmdev-bump:${kind}`
}

/** 通知其它标签页某类数据已变化（同页不触发回调） */
export function notifyDbChange(kind: DbChangeKind): void {
  const payload = String(Date.now())
  // BroadcastChannel 覆盖常规多标签页
  channel?.postMessage({ kind, at: payload })
  // storage 事件兜底（隐私模式 / 不支持 BroadcastChannel 的环境）
  try {
    localStorage.setItem(storageKey(kind), payload)
  } catch {
    /* 存储不可用时仅依赖 BroadcastChannel */
  }
}

/** 监听其它标签页的数据变化，返回取消监听函数 */
export function onDbChange(kind: DbChangeKind, handler: () => void): () => void {
  const onMessage = (event: MessageEvent) => {
    if (event.data?.kind === kind) handler()
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey(kind)) handler()
  }
  channel?.addEventListener('message', onMessage)
  window.addEventListener('storage', onStorage)
  return () => {
    channel?.removeEventListener('message', onMessage)
    window.removeEventListener('storage', onStorage)
  }
}

/**
 * 尝试获取跨标签页短时锁；获取成功返回 release()，失败返回 null。
 * 持锁页崩溃时靠 TTL 自动释放，避免死锁。
 */
export function acquireTabLock(name: string, ttlMs = LOCK_TTL_MS): (() => void) | null {
  const key = LOCK_PREFIX + name
  const now = Date.now()
  const staleAt = now - ttlMs
  try {
    const raw = localStorage.getItem(key)
    if (raw !== null) {
      const heldAt = Number(raw)
      if (Number.isFinite(heldAt) && heldAt > staleAt) return null
    }
    localStorage.setItem(key, String(now))
    // 双标签页可能同时通过上面的检查，写后回读确认自己是持有者
    if (localStorage.getItem(key) !== String(now)) return null
  } catch {
    return null
  }
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      if (localStorage.getItem(key) === String(now)) localStorage.removeItem(key)
    } catch {
      /* 忽略释放时的存储异常，锁会随 TTL 过期 */
    }
  }
}
