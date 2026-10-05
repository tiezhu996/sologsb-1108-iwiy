import { afterEach } from 'vitest'
import { FilmDevDatabase, type FilmDevDatabase as DbType } from '../utils/db'

/** 测试专用库：不写入演示种子，所有用例共用同一连接（每例由 setup 重建） */
export const testDb: DbType = new FilmDevDatabase({ populate: false })

export function getDb(): DbType {
  return testDb
}

export async function resetAndSeed(): Promise<DbType> {
  await testDb.open()
  await testDb.films.bulkAdd([
    { id: 1, model: 'GP3', format: '135', boxIso: 100, realIso: 100, emulsionNo: 'GP3-T1', expireDate: '2027-01-01', rollsLeft: 5, rollsTotal: 5, reservedRolls: 0, revision: 0, schemaRev: 3 },
    { id: 2, model: 'HP5', format: '135', boxIso: 400, realIso: 400, emulsionNo: 'HP5-T2', expireDate: '2027-01-01', rollsLeft: 2, rollsTotal: 2, reservedRolls: 0, revision: 0, schemaRev: 3 }
  ])
  await testDb.developers.bulkAdd([
    { id: 1, name: 'D76 测试液', category: 'D-76', dilution: '1:1', volumeMl: 1000, mixedAt: '2026-10-01', maxRolls: 6, usedRolls: 0, baselineUsedRolls: 1, reservedRolls: 0, revision: 0, state: '在用', schemaRev: 3 }
  ])
  return testDb
}

/** 模拟「另一个标签页」：对同一个内存库建立第二个 Dexie 连接 */
export async function secondConnection(): Promise<DbType> {
  const other = new FilmDevDatabase({ populate: false })
  await other.open()
  connections.push(other)
  return other
}

const connections: DbType[] = []

export function confirmPayload(overrides: Partial<{ result: string }> = {}) {
  return {
    actualTempC: 20,
    actualMinutes: 8,
    tankType: '双联罐' as const,
    runDate: '2026-10-05',
    result: overrides.result ?? '密度均匀'
  }
}

afterEach(() => {
  for (const connection of connections) {
    if (connection.isOpen()) connection.close()
  }
  connections.length = 0
})
