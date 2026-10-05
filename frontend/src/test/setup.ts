import 'fake-indexeddb/auto'
import { beforeEach } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { testDb } from './helpers'

/**
 * 每个用例前关闭测试库并更换内存 IndexedDB 工厂，
 * 之后测试首次使用时在全新库上 open（无演示种子，用例自行 seed）。
 */
beforeEach(async () => {
  testDb.close()
  await testDb.delete()
  globalThis.indexedDB = new IDBFactory()
})
