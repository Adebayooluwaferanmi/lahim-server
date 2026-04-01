export type PrimaryStoreName = 'postgresql-prisma'
export type SyncBridgeName = 'couchdb-dual-write'
export type SyncEventLogName = 'redis-event-bus'

export interface StorageLayerContract {
  name: string
  role: string
  status: 'required' | 'transitional' | 'optional'
  removalCondition?: string
}

export interface StorageContract {
  version: string
  offlineSupportRequired: boolean
  primaryStore: StorageLayerContract
  syncBridge: StorageLayerContract
  syncEventLog: StorageLayerContract
  writePolicy: {
    authoritativeWriteTarget: PrimaryStoreName
    syncReplicationTarget: SyncBridgeName
  }
}

export const STORAGE_CONTRACT: StorageContract = {
  version: '2026-03-replacement-first',
  offlineSupportRequired: true,
  primaryStore: {
    name: 'postgresql-prisma',
    role: 'System of record for transactional writes, analytics, and production queries.',
    status: 'required',
  },
  syncBridge: {
    name: 'couchdb-dual-write',
    role: 'Transitional offline-sync bridge retained while the LaHIM sync layer is rolled out.',
    status: 'transitional',
    removalCondition:
      'Remove only after IndexedDB queue sync reaches parity, cutover checks pass, and rollback coverage is documented.',
  },
  syncEventLog: {
    name: 'redis-event-bus',
    role: 'Operational event fan-out and change-feed substrate for cache invalidation and future sync replay.',
    status: 'optional',
  },
  writePolicy: {
    authoritativeWriteTarget: 'postgresql-prisma',
    syncReplicationTarget: 'couchdb-dual-write',
  },
}
