/**
 * 跨标签页变更通知。IndexedDB 数据在所有标签页间共享，
 * 一个标签页完成占用/确认/释放后，通知其他标签页立即刷新，
 * 避免它们拿着旧的 revision 提交后才收到冲突。
 */
const CHANNEL_NAME = 'gbfilmdev-db-changes'
const STORAGE_KEY = 'gbfilmdev-db-tick'

export type DbChangeTopic = 'plans' | 'resources' | 'all'

let channel: BroadcastChannel | null = null

function getChannel(): BroadcastChannel | null {
  if (channel) return channel
  if (typeof BroadcastChannel === 'undefined') return null
  channel = new BroadcastChannel(CHANNEL_NAME)
  return channel
}

export function notifyDbChange(topic: DbChangeTopic = 'all'): void {
  const payload = { topic, at: Date.now() }
  const bc = getChannel()
  if (bc) {
    bc.postMessage(payload)
    return
  }
  // 兜底：localStorage storage 事件只在其他文档触发
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // 无痕模式等场景忽略，其他标签页可手动刷新
  }
}

export function onDbChange(handler: (topic: DbChangeTopic) => void): () => void {
  const bc = getChannel()
  const onMessage = (event: MessageEvent) => {
    handler(event.data?.topic ?? 'all')
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return
    try {
      handler(JSON.parse(event.newValue).topic ?? 'all')
    } catch {
      handler('all')
    }
  }
  bc?.addEventListener('message', onMessage)
  window.addEventListener('storage', onStorage)
  return () => {
    bc?.removeEventListener('message', onMessage)
    window.removeEventListener('storage', onStorage)
  }
}
