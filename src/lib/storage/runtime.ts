import { STORAGE_CONTRACT } from './contracts'

interface StorageRuntimeOptions {
  postgresAvailable: boolean
  redisAvailable: boolean
  couchdbAvailable: boolean
}

export const getStorageRuntime = ({
  postgresAvailable,
  redisAvailable,
  couchdbAvailable,
}: StorageRuntimeOptions) => ({
  contract: STORAGE_CONTRACT,
  runtime: {
    primaryStore: {
      name: STORAGE_CONTRACT.primaryStore.name,
      connected: postgresAvailable,
    },
    syncBridge: {
      name: STORAGE_CONTRACT.syncBridge.name,
      connected: couchdbAvailable,
      mode: couchdbAvailable ? 'dual-write-enabled' : 'postgresql-only-fallback',
    },
    syncEventLog: {
      name: STORAGE_CONTRACT.syncEventLog.name,
      connected: redisAvailable,
    },
  },
})
