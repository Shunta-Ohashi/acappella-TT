import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

import {
  analyzeCloudEventMigrationInspection,
  KNOWN_CLOUD_EVENT_MIGRATION_VERSIONS,
  NEW_CLOUD_EVENT_MIGRATION_VERSION,
  OLD_CLOUD_EVENT_MIGRATION_VERSION,
  REQUIRED_AUTH_WORKSPACE_SCHEMA_CHECKS,
  REQUIRED_BASE_SCHEMA_CHECKS,
  REQUIRED_LATER_SCHEMA_CHECKS,
  runCloudEventMigrationRepair,
} from '../scripts/cloudEventMigrationRepair.mjs'

const AUTH_VERSION = '20261007'
const LATER_VERSIONS = {
  authorizedDelete: '20261008120000',
  rpcOnlyDelete: '20261008130000',
  authorizedPage: '20261008140000',
  authorizedSave: '20261008150000',
  rpcOnlySave: '20261008160000',
  workspaceGeneration: '20261008170000',
  workspaceMasterFoundation: '20261012100000',
  workspaceMasterContracts: '20261012110000',
  workspaceMasterBackfill: '20261013100000',
  cloudEventV2Persistence: '20261013110000',
  cloudV2CutoverInspection: '20261014100000',
}

const createInspection = ({
  versions = [],
  cloudEventsExists = true,
  overrides = {},
} = {}) => {
  const applied = new Set(versions)
  const baseSchemaChecks = Object.fromEntries(
    REQUIRED_BASE_SCHEMA_CHECKS.map(check => [check, cloudEventsExists]),
  )
  const authWorkspaceChecks = Object.fromEntries(
    REQUIRED_AUTH_WORKSPACE_SCHEMA_CHECKS.map(check => [check, cloudEventsExists]),
  )
  return {
    target: {
      database: 'postgres',
      currentUser: 'postgres',
      serverAddress: '127.0.0.1',
      serverPort: 54322,
    },
    historyTableExists: versions.length > 0,
    appliedVersions: [...versions],
    authWorkspaceReady: cloudEventsExists,
    authWorkspaceChecks,
    cloudEventsExists,
    baseSchemaChecks,
    laterSchema: {
      authorizedDeleteFunction: applied.has(LATER_VERSIONS.authorizedDelete),
      authorizedDeleteSecurityDefiner: applied.has(LATER_VERSIONS.authorizedDelete),
      deleteFunctionPermissionCatalogReady: applied.has(LATER_VERSIONS.authorizedDelete),
      authenticatedDeleteExecute: applied.has(LATER_VERSIONS.authorizedDelete),
      publicDeleteExecute: false,
      anonDeleteExecute: false,
      serviceRoleDeleteExecute: false,
      authorizedPageIndex: applied.has(LATER_VERSIONS.authorizedPage),
      authorizedPageFunction: applied.has(LATER_VERSIONS.authorizedPage),
      authorizedPageSecurityDefiner: applied.has(LATER_VERSIONS.authorizedPage),
      pageFunctionPermissionCatalogReady: applied.has(LATER_VERSIONS.authorizedPage),
      authenticatedPageExecute: applied.has(LATER_VERSIONS.authorizedPage),
      publicPageExecute: false,
      anonPageExecute: false,
      serviceRolePageExecute: false,
      workspaceGenerationTable: applied.has(LATER_VERSIONS.workspaceGeneration),
      workspaceGenerationFunctions: applied.has(LATER_VERSIONS.workspaceGeneration),
      workspaceGenerationTriggers: applied.has(LATER_VERSIONS.workspaceGeneration),
      authorizedPageGenerationGuard: applied.has(LATER_VERSIONS.workspaceGeneration),
      authorizedSaveFunction: applied.has(LATER_VERSIONS.authorizedSave),
      authorizedSaveSecurityDefiner: applied.has(LATER_VERSIONS.authorizedSave),
      saveFunctionPermissionCatalogReady: applied.has(LATER_VERSIONS.authorizedSave),
      serviceRoleSaveExecute: applied.has(LATER_VERSIONS.authorizedSave),
      publicSaveExecute: false,
      anonSaveExecute: false,
      authenticatedSaveExecute: false,
      authenticatedSelect: cloudEventsExists,
      authenticatedInsert: cloudEventsExists && !applied.has(LATER_VERSIONS.rpcOnlySave),
      authenticatedUpdate: cloudEventsExists && !applied.has(LATER_VERSIONS.rpcOnlySave),
      authenticatedDelete: cloudEventsExists && !applied.has(LATER_VERSIONS.rpcOnlyDelete),
      authenticatedColumnInsert:
        cloudEventsExists && !applied.has(LATER_VERSIONS.rpcOnlySave),
      authenticatedColumnUpdate:
        cloudEventsExists && !applied.has(LATER_VERSIONS.rpcOnlySave),
      permissionCatalogReady: cloudEventsExists,
      anonTableWrite: false,
      anonColumnWrite: false,
      publicTableWrite: false,
      publicColumnWrite: false,
      workspaceMasterTables: applied.has(LATER_VERSIONS.workspaceMasterFoundation),
      workspaceMasterConstraints: applied.has(LATER_VERSIONS.workspaceMasterFoundation),
      workspaceMasterStateInitializer:
        applied.has(LATER_VERSIONS.workspaceMasterFoundation),
      workspaceMasterMetadataTriggers:
        applied.has(LATER_VERSIONS.workspaceMasterFoundation),
      workspaceMasterGenerationTriggers:
        applied.has(LATER_VERSIONS.workspaceMasterFoundation),
      workspaceMasterRowLevelSecurity:
        applied.has(LATER_VERSIONS.workspaceMasterFoundation),
      workspaceMasterPrivileges:
        applied.has(LATER_VERSIONS.workspaceMasterFoundation),
      workspaceMasterContractFunctions:
        applied.has(LATER_VERSIONS.workspaceMasterContracts),
      workspaceMasterContractPrivileges:
        applied.has(LATER_VERSIONS.workspaceMasterContracts),
      workspaceMasterBackfillContract:
        applied.has(LATER_VERSIONS.workspaceMasterBackfill),
      cloudEventV2PersistenceContract:
        applied.has(LATER_VERSIONS.cloudEventV2Persistence),
      cloudV2CutoverInspectionContract:
        applied.has(LATER_VERSIONS.cloudV2CutoverInspection),
    },
    cloudData: {
      rowCount: cloudEventsExists ? 1 : 0,
      digest: cloudEventsExists ? 'fixture-digest' : 'absent',
    },
    workspaceMasterData: {
      rowCount: applied.has(LATER_VERSIONS.workspaceMasterFoundation) ? 1 : 0,
      digest: applied.has(LATER_VERSIONS.workspaceMasterFoundation)
        ? 'fixture-master-digest'
        : 'absent',
    },
    ...overrides,
  }
}

const createKnownVersions = baseVersion => [
  AUTH_VERSION,
  baseVersion,
  ...Object.values(LATER_VERSIONS),
]

test('migration history判定はfresh・旧のみ・新のみ・両方を明示的に分ける', () => {
  assert.equal(analyzeCloudEventMigrationInspection(createInspection({
    cloudEventsExists: false,
  })).kind, 'fresh')

  const oldOnly = analyzeCloudEventMigrationInspection(createInspection({
    versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
  }))
  assert.equal(oldOnly.kind, 'old-only')
  assert.deepEqual(oldOnly.repairCommands, [
    { version: NEW_CLOUD_EVENT_MIGRATION_VERSION, status: 'applied' },
    { version: OLD_CLOUD_EVENT_MIGRATION_VERSION, status: 'reverted' },
  ])

  assert.equal(analyzeCloudEventMigrationInspection(createInspection({
    versions: createKnownVersions(NEW_CLOUD_EVENT_MIGRATION_VERSION),
  })).kind, 'new-only')

  const both = analyzeCloudEventMigrationInspection(createInspection({
    versions: [
      ...createKnownVersions(NEW_CLOUD_EVENT_MIGRATION_VERSION),
      OLD_CLOUD_EVENT_MIGRATION_VERSION,
    ],
  }))
  assert.equal(both.kind, 'both')
  assert.deepEqual(both.repairCommands, [
    { version: OLD_CLOUD_EVENT_MIGRATION_VERSION, status: 'reverted' },
  ])

  assert.equal(analyzeCloudEventMigrationInspection(createInspection({
    versions: [AUTH_VERSION],
    cloudEventsExists: false,
  })).kind, 'fresh')
})

test('migration historyは既知versionだけを一意なlater prefixとして受け入れる', () => {
  assert.deepEqual(KNOWN_CLOUD_EVENT_MIGRATION_VERSIONS, [
    AUTH_VERSION,
    OLD_CLOUD_EVENT_MIGRATION_VERSION,
    NEW_CLOUD_EVENT_MIGRATION_VERSION,
    ...Object.values(LATER_VERSIONS),
  ])

  for (const [label, baseVersions] of [
    ['old-only', createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION)],
    ['new-only', createKnownVersions(NEW_CLOUD_EVENT_MIGRATION_VERSION)],
    ['both', [
      ...createKnownVersions(NEW_CLOUD_EVENT_MIGRATION_VERSION),
      OLD_CLOUD_EVENT_MIGRATION_VERSION,
    ]],
  ]) {
    const inspection = createInspection({
      versions: [...baseVersions, '20990101000000'],
    })
    const result = analyzeCloudEventMigrationInspection(inspection)
    assert.equal(result.kind, 'unknown', label)
    assert.match(result.mismatches.join('\n'), /unknown migration history versions/i)
  }

  for (const [label, versions] of [
    ['old base', [
      ...createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
      OLD_CLOUD_EVENT_MIGRATION_VERSION,
    ]],
    ['new base', [
      ...createKnownVersions(NEW_CLOUD_EVENT_MIGRATION_VERSION),
      NEW_CLOUD_EVENT_MIGRATION_VERSION,
    ]],
    ['known non-base', [
      ...createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
      LATER_VERSIONS.authorizedPage,
    ]],
  ]) {
    const result = analyzeCloudEventMigrationInspection(createInspection({ versions }))
    assert.equal(result.kind, 'unknown', label)
    assert.match(result.mismatches.join('\n'), /duplicate migration history versions/i)
  }

  for (const [label, versions] of [
    ['rpcOnlySave without predecessors', [
      AUTH_VERSION,
      OLD_CLOUD_EVENT_MIGRATION_VERSION,
      LATER_VERSIONS.rpcOnlySave,
    ]],
    ['authorizedPage missing rpcOnlyDelete', [
      AUTH_VERSION,
      OLD_CLOUD_EVENT_MIGRATION_VERSION,
      LATER_VERSIONS.authorizedDelete,
      LATER_VERSIONS.authorizedPage,
    ]],
    ['authorizedSave missing authorizedPage', [
      AUTH_VERSION,
      OLD_CLOUD_EVENT_MIGRATION_VERSION,
      LATER_VERSIONS.authorizedDelete,
      LATER_VERSIONS.rpcOnlyDelete,
      LATER_VERSIONS.authorizedSave,
    ]],
  ]) {
    const result = analyzeCloudEventMigrationInspection(createInspection({ versions }))
    assert.equal(result.kind, 'unknown', label)
    assert.match(result.mismatches.join('\n'), /later migration history is not a prefix/i)
  }
})

test('履歴とcatalogが一致しない状態はrepairせず停止する', () => {
  const missingTable = createInspection({
    versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
    cloudEventsExists: false,
  })
  assert.equal(analyzeCloudEventMigrationInspection(missingTable).kind, 'unknown')

  const tableWithoutHistory = createInspection({ versions: [] })
  assert.equal(analyzeCloudEventMigrationInspection(tableWithoutHistory).kind, 'unknown')

  const oldIntermediateSchema = createInspection({
    versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
  })
  oldIntermediateSchema.baseSchemaChecks.strictSnapshotCheck = false
  const intermediate = analyzeCloudEventMigrationInspection(oldIntermediateSchema)
  assert.equal(intermediate.kind, 'unknown')
  assert.match(intermediate.mismatches.join('\n'), /strictSnapshotCheck/)

  const missingLaterObject = createInspection({
    versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
  })
  missingLaterObject.laterSchema.authorizedSaveFunction = false
  assert.equal(analyzeCloudEventMigrationInspection(missingLaterObject).kind, 'unknown')
})

test('Auth / Workspaceの既知catalog契約は1項目でも不一致ならunknownになる', () => {
  for (const check of REQUIRED_AUTH_WORKSPACE_SCHEMA_CHECKS) {
    const inspection = createInspection({
      versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
    })
    inspection.authWorkspaceChecks[check] = false
    inspection.authWorkspaceReady = false
    const result = analyzeCloudEventMigrationInspection(inspection)
    assert.equal(result.kind, 'unknown', check)
    assert.match(result.mismatches.join('\n'), new RegExp(check), check)
  }
})

test('Workspace master foundationの既知catalog契約はhistoryと一致しなければunknownになる', () => {
  for (const check of [
    'workspaceMasterTables',
    'workspaceMasterConstraints',
    'workspaceMasterStateInitializer',
    'workspaceMasterMetadataTriggers',
    'workspaceMasterGenerationTriggers',
    'workspaceMasterRowLevelSecurity',
    'workspaceMasterPrivileges',
  ]) {
    const inspection = createInspection({
      versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
    })
    inspection.laterSchema[check] = false
    const result = analyzeCloudEventMigrationInspection(inspection)
    assert.equal(result.kind, 'unknown', check)
    assert.match(result.mismatches.join('\n'), new RegExp(check), check)
  }

  const prematureCatalog = createInspection({
    versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION)
      .filter(version => version !== LATER_VERSIONS.workspaceMasterFoundation),
  })
  prematureCatalog.laterSchema.workspaceMasterTables = true
  assert.equal(
    analyzeCloudEventMigrationInspection(prematureCatalog).kind,
    'unknown',
  )
})

test('Workspace Master API契約はfunctionまたはACL不一致をfail closedする', () => {
  const versions = createKnownVersions(NEW_CLOUD_EVENT_MIGRATION_VERSION)
  for (const check of [
    'workspaceMasterContractFunctions',
    'workspaceMasterContractPrivileges',
    'workspaceMasterBackfillContract',
  ]) {
    const inspection = createInspection({
      versions,
      overrides: {
        laterSchema: {
          ...createInspection({ versions }).laterSchema,
          [check]: false,
        },
      },
    })
    const result = analyzeCloudEventMigrationInspection(inspection)
    assert.equal(result.kind, 'unknown', check)
    assert.match(result.mismatches.join('\n'), new RegExp(check, 'i'), check)
  }
})

test('Cloud Event V2保存契約はmigration historyとcatalogの不一致をfail closedする', () => {
  const versions = createKnownVersions(NEW_CLOUD_EVENT_MIGRATION_VERSION)
  const missingContract = createInspection({ versions })
  missingContract.laterSchema.cloudEventV2PersistenceContract = false
  const missingResult = analyzeCloudEventMigrationInspection(missingContract)
  assert.equal(missingResult.kind, 'unknown')
  assert.match(missingResult.mismatches.join('\n'), /cloudEventV2PersistenceContract/i)

  const beforeV2 = versions.slice(
    0,
    versions.indexOf(LATER_VERSIONS.cloudEventV2Persistence),
  )
  assert.equal(analyzeCloudEventMigrationInspection(createInspection({
    versions: beforeV2,
  })).kind, 'new-only')

  const prematureContract = createInspection({ versions: beforeV2 })
  prematureContract.laterSchema.cloudEventV2PersistenceContract = true
  assert.equal(
    analyzeCloudEventMigrationInspection(prematureContract).kind,
    'unknown',
  )
})

test('Cloud V2 cutover inspection契約はmigration historyとcatalogの不一致をfail closedする', () => {
  const versions = createKnownVersions(NEW_CLOUD_EVENT_MIGRATION_VERSION)
  const missingContract = createInspection({ versions })
  missingContract.laterSchema.cloudV2CutoverInspectionContract = false
  const missingResult = analyzeCloudEventMigrationInspection(missingContract)
  assert.equal(missingResult.kind, 'unknown')
  assert.match(missingResult.mismatches.join('\n'), /cloudV2CutoverInspectionContract/i)

  const beforeInspection = versions.filter(
    version => version !== LATER_VERSIONS.cloudV2CutoverInspection,
  )
  assert.equal(analyzeCloudEventMigrationInspection(createInspection({
    versions: beforeInspection,
  })).kind, 'new-only')

  const prematureContract = createInspection({ versions: beforeInspection })
  prematureContract.laterSchema.cloudV2CutoverInspectionContract = true
  assert.equal(analyzeCloudEventMigrationInspection(prematureContract).kind, 'unknown')
})

test('Cloud Eventのbrowser/PUBLIC実効table・column権限とcatalog不明を個別に拒否する', () => {
  for (const [check, mismatchPattern] of [
    ['authenticatedInsert', /authenticated INSERT privilege/i],
    ['authenticatedUpdate', /authenticated UPDATE privilege/i],
    ['authenticatedDelete', /authenticated DELETE privilege/i],
    ['authenticatedColumnInsert', /authenticated column INSERT privilege/i],
    ['authenticatedColumnUpdate', /authenticated column UPDATE privilege/i],
    ['anonTableWrite', /anonTableWrite privilege/i],
    ['anonColumnWrite', /anonColumnWrite privilege/i],
    ['publicTableWrite', /publicTableWrite privilege/i],
    ['publicColumnWrite', /publicColumnWrite privilege/i],
  ]) {
    const inspection = createInspection({
      versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
    })
    inspection.laterSchema[check] = true
    const result = analyzeCloudEventMigrationInspection(inspection)
    assert.equal(result.kind, 'unknown', check)
    assert.match(result.mismatches.join('\n'), mismatchPattern, check)
  }

  const unavailable = createInspection({
    versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
  })
  unavailable.laterSchema.permissionCatalogReady = false
  assert.equal(analyzeCloudEventMigrationInspection(unavailable).kind, 'unknown')
})

test('authorized save RPCのSECURITY DEFINERと実効EXECUTE権限をfail-closedで検査する', () => {
  for (const check of [
    'publicSaveExecute',
    'anonSaveExecute',
    'authenticatedSaveExecute',
  ]) {
    const inspection = createInspection({
      versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
    })
    inspection.laterSchema[check] = true
    const result = analyzeCloudEventMigrationInspection(inspection)
    assert.equal(result.kind, 'unknown', check)
    assert.match(result.mismatches.join('\n'), new RegExp(check), check)
  }

  for (const check of [
    'authorizedSaveSecurityDefiner',
    'saveFunctionPermissionCatalogReady',
    'serviceRoleSaveExecute',
  ]) {
    const inspection = createInspection({
      versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
    })
    inspection.laterSchema[check] = false
    const result = analyzeCloudEventMigrationInspection(inspection)
    assert.equal(result.kind, 'unknown', check)
    assert.match(result.mismatches.join('\n'), /authorized save|service_role/i, check)
  }

  const beforeAuthorizedSave = createInspection({
    versions: [
      AUTH_VERSION,
      OLD_CLOUD_EVENT_MIGRATION_VERSION,
      LATER_VERSIONS.authorizedDelete,
      LATER_VERSIONS.rpcOnlyDelete,
      LATER_VERSIONS.authorizedPage,
    ],
  })
  assert.equal(analyzeCloudEventMigrationInspection(beforeAuthorizedSave).kind, 'old-only')
})

test('authorized delete/page RPCのSECURITY DEFINERと実効EXECUTE契約をfail-closedで検査する', () => {
  for (const check of [
    'authorizedDeleteSecurityDefiner',
    'deleteFunctionPermissionCatalogReady',
    'authenticatedDeleteExecute',
    'authorizedPageSecurityDefiner',
    'pageFunctionPermissionCatalogReady',
    'authenticatedPageExecute',
  ]) {
    const inspection = createInspection({
      versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
    })
    inspection.laterSchema[check] = false
    const result = analyzeCloudEventMigrationInspection(inspection)
    assert.equal(result.kind, 'unknown', check)
    assert.match(result.mismatches.join('\n'), /authorized (delete|page)|authenticated/i)
  }

  for (const check of [
    'publicDeleteExecute',
    'anonDeleteExecute',
    'serviceRoleDeleteExecute',
    'publicPageExecute',
    'anonPageExecute',
    'serviceRolePageExecute',
  ]) {
    const inspection = createInspection({
      versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
    })
    inspection.laterSchema[check] = true
    const result = analyzeCloudEventMigrationInspection(inspection)
    assert.equal(result.kind, 'unknown', check)
    assert.match(result.mismatches.join('\n'), new RegExp(check), check)
  }
})

test('危険・不明なcatalogではapplyとresumeのrepairを一度も呼ばない', async () => {
  const cases = []
  const unsafeAuth = createInspection({
    versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
  })
  unsafeAuth.authWorkspaceChecks.policies = false
  unsafeAuth.authWorkspaceReady = false
  cases.push({ inspection: unsafeAuth, resume: false })

  const unsafePermission = createInspection({
    versions: [
      ...createKnownVersions(NEW_CLOUD_EVENT_MIGRATION_VERSION),
      OLD_CLOUD_EVENT_MIGRATION_VERSION,
    ],
  })
  unsafePermission.laterSchema.publicColumnWrite = true
  cases.push({ inspection: unsafePermission, resume: true })

  const unsafeSaveExecute = createInspection({
    versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
  })
  unsafeSaveExecute.laterSchema.authenticatedSaveExecute = true
  cases.push({ inspection: unsafeSaveExecute, resume: false })

  const unknownHistory = createInspection({
    versions: [
      ...createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
      '20990101000000',
    ],
  })
  cases.push({ inspection: unknownHistory, resume: false })

  for (const { inspection, resume } of cases) {
    let repairCalls = 0
    const result = await runCloudEventMigrationRepair({
      databaseUrl: 'postgresql://test.invalid/postgres',
      apply: true,
      resume,
      confirmTarget: 'not-used-for-unknown-state',
      inspectTarget: async () => structuredClone(inspection),
      repairMigration: async () => {
        repairCalls += 1
        return { ok: true }
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'UNKNOWN_STATE')
    assert.equal(repairCalls, 0)
  }

  const missingField = createInspection({
    versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
  })
  delete missingField.authWorkspaceChecks.profilesColumns
  let repairCalls = 0
  const invalidShape = await runCloudEventMigrationRepair({
    databaseUrl: 'postgresql://test.invalid/postgres',
    apply: true,
    inspectTarget: async () => missingField,
    repairMigration: async () => {
      repairCalls += 1
      return { ok: true }
    },
  })
  assert.equal(invalidShape.ok, false)
  assert.equal(invalidShape.code, 'INVALID_INSPECTION')
  assert.equal(repairCalls, 0)

  const missingPermissionField = createInspection({
    versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
  })
  delete missingPermissionField.laterSchema.permissionCatalogReady
  const invalidPermissionShape = await runCloudEventMigrationRepair({
    databaseUrl: 'postgresql://test.invalid/postgres',
    apply: true,
    inspectTarget: async () => missingPermissionField,
    repairMigration: async () => {
      repairCalls += 1
      return { ok: true }
    },
  })
  assert.equal(invalidPermissionShape.ok, false)
  assert.equal(invalidPermissionShape.code, 'INVALID_INSPECTION')
  assert.equal(repairCalls, 0)
})

test('確認modeは対象を判定するだけで履歴変更を行わない', async () => {
  const inspection = createInspection({
    versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
  })
  let repairCalls = 0
  const result = await runCloudEventMigrationRepair({
    databaseUrl: 'postgresql://test.invalid/postgres',
    inspectTarget: async () => structuredClone(inspection),
    repairMigration: async () => {
      repairCalls += 1
      return { ok: true }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.applied, false)
  assert.equal(result.plan.state, 'old-only')
  assert.equal(repairCalls, 0)

  for (const inspection of [
    createInspection({ cloudEventsExists: false }),
    createInspection({
      versions: createKnownVersions(NEW_CLOUD_EVENT_MIGRATION_VERSION),
    }),
  ]) {
    const noOp = await runCloudEventMigrationRepair({
      databaseUrl: 'postgresql://test.invalid/postgres',
      apply: true,
      inspectTarget: async () => structuredClone(inspection),
      repairMigration: async () => {
        repairCalls += 1
        return { ok: true }
      },
    })
    assert.equal(noOp.ok, true)
    assert.equal(noOp.applied, false)
  }
  assert.equal(repairCalls, 0)
})

test('旧のみのknown schemaは新登録後に再確認してから旧履歴を除去する', async () => {
  const versions = new Set(createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION))
  const repairCalls = []
  let inspectionCalls = 0
  const inspectTarget = async () => {
    inspectionCalls += 1
    return createInspection({ versions: [...versions] })
  }
  const repairMigration = async (_databaseUrl, command) => {
    repairCalls.push(command)
    if (command.status === 'applied') versions.add(command.version)
    else versions.delete(command.version)
    return { ok: true }
  }
  const check = await runCloudEventMigrationRepair({
    databaseUrl: 'postgresql://test.invalid/postgres',
    inspectTarget,
    repairMigration,
  })
  const applied = await runCloudEventMigrationRepair({
    databaseUrl: 'postgresql://test.invalid/postgres',
    apply: true,
    confirmTarget: check.plan.targetFingerprint,
    inspectTarget,
    repairMigration,
  })

  assert.equal(applied.ok, true)
  assert.equal(applied.finalState, 'new-only')
  assert.deepEqual(repairCalls, [
    { version: NEW_CLOUD_EVENT_MIGRATION_VERSION, status: 'applied' },
    { version: OLD_CLOUD_EVENT_MIGRATION_VERSION, status: 'reverted' },
  ])
  assert.equal(versions.has(NEW_CLOUD_EVENT_MIGRATION_VERSION), true)
  assert.equal(versions.has(OLD_CLOUD_EVENT_MIGRATION_VERSION), false)
  assert.equal(inspectionCalls, 6)
})

test('両方登録済みの中断状態は明示resume時だけ旧履歴を除去する', async () => {
  const versions = new Set([
    ...createKnownVersions(NEW_CLOUD_EVENT_MIGRATION_VERSION),
    OLD_CLOUD_EVENT_MIGRATION_VERSION,
  ])
  const repairCalls = []
  const inspectTarget = async () => createInspection({ versions: [...versions] })
  const repairMigration = async (_databaseUrl, command) => {
    repairCalls.push(command)
    versions.delete(command.version)
    return { ok: true }
  }
  const check = await runCloudEventMigrationRepair({
    databaseUrl: 'postgresql://test.invalid/postgres',
    inspectTarget,
    repairMigration,
  })
  const withoutResume = await runCloudEventMigrationRepair({
    databaseUrl: 'postgresql://test.invalid/postgres',
    apply: true,
    confirmTarget: check.plan.targetFingerprint,
    inspectTarget,
    repairMigration,
  })
  assert.equal(withoutResume.ok, false)
  assert.equal(withoutResume.code, 'EXPLICIT_RESUME_REQUIRED')
  assert.equal(repairCalls.length, 0)

  let resumedInspectionCalls = 0
  const resumed = await runCloudEventMigrationRepair({
    databaseUrl: 'postgresql://test.invalid/postgres',
    apply: true,
    resume: true,
    confirmTarget: check.plan.targetFingerprint,
    inspectTarget: async () => {
      resumedInspectionCalls += 1
      return inspectTarget()
    },
    repairMigration,
  })
  assert.equal(resumed.ok, true)
  assert.deepEqual(repairCalls, [
    { version: OLD_CLOUD_EVENT_MIGRATION_VERSION, status: 'reverted' },
  ])
  assert.equal(resumedInspectionCalls, 3)
})

test('各repair直前の再inspectionは初回mutation前のschema・data・history・target raceを拒否する', async () => {
  const initial = createInspection({
    versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
  })
  const preview = await runCloudEventMigrationRepair({
    databaseUrl: 'postgresql://test.invalid/postgres',
    inspectTarget: async () => structuredClone(initial),
    repairMigration: async () => ({ ok: true }),
  })

  const cases = [
    ['schema', inspection => { inspection.baseSchemaChecks.columns = false }],
    ['data', inspection => { inspection.cloudData.digest = 'changed-before-repair' }],
    ['master data', inspection => {
      inspection.workspaceMasterData.digest = 'changed-master-before-repair'
    }],
    ['unknown history', inspection => {
      inspection.appliedVersions.push('20990101000000')
    }],
    ['target', inspection => { inspection.target.database = 'other-database' }],
  ]
  for (const [label, mutate] of cases) {
    let inspectionCalls = 0
    let repairCalls = 0
    const changed = structuredClone(initial)
    mutate(changed)
    const result = await runCloudEventMigrationRepair({
      databaseUrl: 'postgresql://test.invalid/postgres',
      apply: true,
      confirmTarget: preview.plan.targetFingerprint,
      inspectTarget: async () => {
        inspectionCalls += 1
        return structuredClone(inspectionCalls === 1 ? initial : changed)
      },
      repairMigration: async () => {
        repairCalls += 1
        return { ok: true }
      },
    })
    assert.equal(result.ok, false, label)
    assert.equal(result.code, 'PRE_REPAIR_STATE_CHANGED', label)
    assert.equal(repairCalls, 0, label)
  }
})

test('mutation直前のinspection失敗またはinvalid shapeではrepairを開始しない', async () => {
  const initial = createInspection({
    versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
  })
  const preview = await runCloudEventMigrationRepair({
    databaseUrl: 'postgresql://test.invalid/postgres',
    inspectTarget: async () => structuredClone(initial),
    repairMigration: async () => ({ ok: true }),
  })

  for (const secondInspection of ['throw', 'invalid']) {
    let inspectionCalls = 0
    let repairCalls = 0
    const result = await runCloudEventMigrationRepair({
      databaseUrl: 'postgresql://test.invalid/postgres',
      apply: true,
      confirmTarget: preview.plan.targetFingerprint,
      inspectTarget: async () => {
        inspectionCalls += 1
        if (inspectionCalls === 1) return structuredClone(initial)
        if (secondInspection === 'throw') throw new Error('preflight unavailable')
        return { invalid: true }
      },
      repairMigration: async () => {
        repairCalls += 1
        return { ok: true }
      },
    })
    assert.equal(result.ok, false, secondInspection)
    assert.equal(result.code, 'PRE_REPAIR_INSPECTION_FAILED', secondInspection)
    assert.equal(repairCalls, 0, secondInspection)
  }
})

test('old-onlyの1回目後も2回目直前にschema/data/historyを再検査して停止する', async () => {
  const oldOnly = createInspection({
    versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
  })
  const both = createInspection({
    versions: [
      ...createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
      NEW_CLOUD_EVENT_MIGRATION_VERSION,
    ],
  })
  const preview = await runCloudEventMigrationRepair({
    databaseUrl: 'postgresql://test.invalid/postgres',
    inspectTarget: async () => structuredClone(oldOnly),
    repairMigration: async () => ({ ok: true }),
  })

  const cases = [
    ['schema', inspection => { inspection.baseSchemaChecks.columns = false }],
    ['data', inspection => { inspection.cloudData.digest = 'changed-between-repairs' }],
    ['master data', inspection => {
      inspection.workspaceMasterData.digest = 'changed-master-between-repairs'
    }],
    ['history', inspection => { inspection.appliedVersions.push('20990101000000') }],
  ]
  for (const [label, mutate] of cases) {
    const preSecondRepair = structuredClone(both)
    mutate(preSecondRepair)
    const inspections = [oldOnly, oldOnly, both, preSecondRepair]
    let inspectionIndex = 0
    let repairCalls = 0
    const result = await runCloudEventMigrationRepair({
      databaseUrl: 'postgresql://test.invalid/postgres',
      apply: true,
      confirmTarget: preview.plan.targetFingerprint,
      inspectTarget: async () => structuredClone(inspections[inspectionIndex++]),
      repairMigration: async () => {
        repairCalls += 1
        return { ok: true }
      },
    })
    assert.equal(result.ok, false, label)
    assert.equal(result.code, 'PRE_REPAIR_STATE_CHANGED', label)
    assert.equal(repairCalls, 1, label)
    assert.deepEqual(result.completedCommands, [
      { version: NEW_CLOUD_EVENT_MIGRATION_VERSION, status: 'applied' },
    ], label)
  }
})

test('repair失敗・schema/data変化・対象未指定では次の操作へ進まない', async () => {
  let repairCalls = 0
  const missingTarget = await runCloudEventMigrationRepair({
    databaseUrl: '',
    inspectTarget: async () => { throw new Error('not called') },
    repairMigration: async () => { throw new Error('not called') },
  })
  assert.deepEqual(missingTarget, { ok: false, code: 'TARGET_REQUIRED' })
  assert.deepEqual(await runCloudEventMigrationRepair({
    databaseUrl: 'not-a-postgres-url',
    inspectTarget: async () => { throw new Error('not called') },
    repairMigration: async () => { throw new Error('not called') },
  }), { ok: false, code: 'INVALID_TARGET' })

  const oldInspection = createInspection({
    versions: createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION),
  })
  const check = await runCloudEventMigrationRepair({
    databaseUrl: 'postgresql://test.invalid/postgres',
    inspectTarget: async () => structuredClone(oldInspection),
    repairMigration: async () => ({ ok: true }),
  })
  const failed = await runCloudEventMigrationRepair({
    databaseUrl: 'postgresql://test.invalid/postgres',
    apply: true,
    confirmTarget: check.plan.targetFingerprint,
    inspectTarget: async () => structuredClone(oldInspection),
    repairMigration: async () => {
      repairCalls += 1
      return { ok: false }
    },
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'REPAIR_FAILED')
  assert.equal(repairCalls, 1)

  const versions = new Set(createKnownVersions(OLD_CLOUD_EVENT_MIGRATION_VERSION))
  let inspections = 0
  repairCalls = 0
  const changedData = await runCloudEventMigrationRepair({
    databaseUrl: 'postgresql://test.invalid/postgres',
    apply: true,
    confirmTarget: check.plan.targetFingerprint,
    inspectTarget: async () => {
      inspections += 1
      const inspection = createInspection({ versions: [...versions] })
      if (inspections > 1) inspection.cloudData.digest = 'changed'
      return inspection
    },
    repairMigration: async (_databaseUrl, command) => {
      repairCalls += 1
      versions.add(command.version)
      return { ok: true }
    },
  })
  assert.equal(changedData.ok, false)
  assert.equal(changedData.code, 'PRE_REPAIR_STATE_CHANGED')
  assert.equal(repairCalls, 0)
  assert.equal(versions.has(OLD_CLOUD_EVENT_MIGRATION_VERSION), true)
})

test('履歴移行成果物はread-only preflight・明示CLI repair・fixtureを備える', async () => {
  const [
    preflightSql,
    fixtureSql,
    catalogRegressionSql,
    catalogRegressionRunner,
    guide,
    dbReadme,
    migrationFiles,
  ] = await Promise.all([
    readFile(new URL(
      '../supabase/tests/cloud_event_migration_history_preflight.sql',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../supabase/tests/cloud_event_migration_history_fixture.sql',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../supabase/tests/cloud_event_migration_history_catalog_regression.sql',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../scripts/cloudEventMigrationCatalogRegression.mjs',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL('../docs/cloud-event-migration-history-repair.md', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/tests/README.md', import.meta.url), 'utf8'),
    readdir(new URL('../supabase/migrations', import.meta.url)),
  ])

  assert.doesNotMatch(
    preflightSql,
    /^\s*(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/im,
  )
  assert.match(preflightSql, /supabase_migrations\.schema_migrations/i)
  assert.match(preflightSql, /cloud_events_snapshot_shape_check/i)
  assert.match(preflightSql, /cloud_data_digest/i)
  assert.match(preflightSql, /workspace_master_data_digest/i)
  assert.match(preflightSql,
    /workspace_master_foundation_state_safe[\s\S]*status <> 'legacy'/i)
  assert.match(preflightSql,
    /to_jsonb\(workspace_master_band_members\)[\s\S]*order by kind, row_key/i)
  for (const check of REQUIRED_AUTH_WORKSPACE_SCHEMA_CHECKS) {
    assert.match(preflightSql, new RegExp(`'${check}'`), check)
  }
  for (const check of REQUIRED_LATER_SCHEMA_CHECKS) {
    assert.match(preflightSql, new RegExp(`'${check}'`), check)
  }
  assert.match(preflightSql, /has_function_privilege\s*\(/i)
  assert.match(preflightSql, /has_table_privilege\s*\(/i)
  assert.match(preflightSql, /has_column_privilege\s*\(/i)
  assert.match(preflightSql, /authorized_delete_function\.prosecdef/i)
  assert.match(preflightSql, /authorized_page_function\.prosecdef/i)
  assert.match(preflightSql, /authorized_save_function\.prosecdef/i)
  assert.match(
    preflightSql,
    /workspace_master_mutation_function\.prosrc[\s\S]*errcode = ''pma01''/i,
  )
  for (const nullGuard of [
    'p_operation is null',
    'p_master_kind is null',
    'p_payload is null',
  ]) {
    assert.match(
      preflightSql,
      new RegExp(`workspace_master_mutation_function\\.prosrc[\\s\\S]*${nullGuard}`, 'i'),
      nullGuard,
    )
  }
  for (const requiredJsonGuard of [
    "jsonb_typeof(p_payload -> ''realname'') is distinct from ''string''",
    "jsonb_typeof(p_payload -> ''active'') is distinct from ''boolean''",
    "jsonb_typeof(p_payload -> ''name'') is distinct from ''string''",
    "jsonb_typeof(p_payload -> ''defaultmemberids'') is distinct from ''array''",
  ]) {
    assert.match(
      preflightSql,
      new RegExp(requiredJsonGuard.replace(/[()]/gu, '\\$&'), 'i'),
      requiredJsonGuard,
    )
  }
  assert.match(preflightSql, /aclexplode\s*\(coalesce\([\s\S]*acldefault\('f'/i)
  const authWorkspaceChecksStart = preflightSql.indexOf('auth_workspace_checks as (')
  const authWorkspaceChecksEnd = preflightSql.indexOf('\nbase_checks as (')
  assert.ok(
    authWorkspaceChecksStart >= 0 && authWorkspaceChecksEnd > authWorkspaceChecksStart,
  )
  const authWorkspaceChecksSql = preflightSql.slice(
    authWorkspaceChecksStart,
    authWorkspaceChecksEnd,
  )
  assert.match(
    authWorkspaceChecksSql,
    /'check\(btrim\(display_name\)<>''''::text\)'/i,
  )
  assert.match(authWorkspaceChecksSql, /'check\(btrim\(name\)<>''''::text\)'/i)
  assert.match(
    authWorkspaceChecksSql,
    /'check\(role=any\(array\[''owner''::text,''editor''::text,''viewer''::text\]\)\)'/i,
  )
  assert.match(
    authWorkspaceChecksSql,
    /'check\(\(btrim\(display_name\)<>''''::text\)\)'/i,
  )
  assert.match(authWorkspaceChecksSql, /'check\(\(btrim\(name\)<>''''::text\)\)'/i)
  assert.ok(authWorkspaceChecksSql.includes(
    "'check((role=any(array[''owner''::text,''editor''::text,''viewer''::text])))'",
  ))
  assert.doesNotMatch(authWorkspaceChecksSql, /guest/i)
  const workspaceMasterConstraintsStart = preflightSql.indexOf(
    "'workspaceMasterConstraints'",
  )
  const workspaceMasterConstraintsEnd = preflightSql.indexOf(
    "\n    'workspaceMasterStateInitializer'",
    workspaceMasterConstraintsStart,
  )
  assert.ok(
    workspaceMasterConstraintsStart >= 0 &&
      workspaceMasterConstraintsEnd > workspaceMasterConstraintsStart,
  )
  const workspaceMasterConstraintsSql = preflightSql.slice(
    workspaceMasterConstraintsStart,
    workspaceMasterConstraintsEnd,
  )
  assert.match(workspaceMasterConstraintsSql, /'check\("position">=0\)'/i)
  assert.match(workspaceMasterConstraintsSql,
    /'unique\(workspace_id,band_id,"position"\)'/i)
  assert.match(workspaceMasterConstraintsSql,
    /not convalidated or condeferrable or condeferred/i)
  assert.equal(
    (workspaceMasterConstraintsSql.match(/confdeltype\s*=\s*'r'/gi) ?? []).length,
    3,
  )
  const workspaceMasterStateInitializerStart = preflightSql.indexOf(
    "'workspaceMasterStateInitializer'",
  )
  const workspaceMasterStateInitializerEnd = preflightSql.indexOf(
    "\n    'workspaceMasterMetadataTriggers'",
    workspaceMasterStateInitializerStart,
  )
  assert.ok(
    workspaceMasterStateInitializerStart >= 0 &&
      workspaceMasterStateInitializerEnd > workspaceMasterStateInitializerStart,
  )
  const workspaceMasterStateInitializerSql = preflightSql.slice(
    workspaceMasterStateInitializerStart,
    workspaceMasterStateInitializerEnd,
  )
  assert.match(workspaceMasterStateInitializerSql,
    /prepare_master_cascade_function[\s\S]*prosecdef/i)
  assert.match(workspaceMasterStateInitializerSql,
    /cloud_event_member_references[\s\S]*cloud_event_band_references[\s\S]*workspace_master_band_members/i)
  assert.match(workspaceMasterStateInitializerSql,
    /workspaces_prepare_workspace_master_cascade[\s\S]*tgtype = 11/i)
  assert.match(workspaceMasterStateInitializerSql,
    /workspaces_initialize_cloud_workspace_master_state[\s\S]*tgtype = 5/i)
  assert.match(workspaceMasterStateInitializerSql,
    /workspace_master_members_guard_delete_until_ready[\s\S]*tgtype = 11/i)
  assert.match(workspaceMasterStateInitializerSql,
    /workspace_master_bands_guard_delete_until_ready[\s\S]*tgtype = 11/i)
  assert.match(workspaceMasterStateInitializerSql,
    /select count\(\*\) = 2[\s\S]*guard_master_delete_function/i)
  assert.match(workspaceMasterStateInitializerSql,
    /guard_master_delete_function[\s\S]*for share[\s\S]*master_status is distinct from ''ready''/i)
  const workspaceMasterMetadataTriggersStart = preflightSql.indexOf(
    "'workspaceMasterMetadataTriggers'",
  )
  const workspaceMasterMetadataTriggersEnd = preflightSql.indexOf(
    "\n    'workspaceMasterGenerationTriggers'",
    workspaceMasterMetadataTriggersStart,
  )
  assert.ok(
    workspaceMasterMetadataTriggersStart >= 0 &&
      workspaceMasterMetadataTriggersEnd > workspaceMasterMetadataTriggersStart,
  )
  const workspaceMasterMetadataTriggersSql = preflightSql.slice(
    workspaceMasterMetadataTriggersStart,
    workspaceMasterMetadataTriggersEnd,
  )
  for (const [triggerName, triggerType] of [
    ['workspace_master_members_initialize_metadata', 7],
    ['workspace_master_members_protect_identity_and_revision', 19],
    ['workspace_master_bands_initialize_metadata', 7],
    ['workspace_master_bands_protect_identity_and_revision', 19],
    ['cloud_workspace_master_states_set_current_updated_at', 19],
    ['workspace_master_band_members_protect_identity', 19],
  ]) {
    assert.match(workspaceMasterMetadataTriggersSql,
      new RegExp(`${triggerName}[\\s\\S]*?${triggerType}`), triggerName)
  }
  assert.match(workspaceMasterMetadataTriggersSql,
    /protect_workspace_master_band_member_identity\(\)/i)
  const workspaceMasterGenerationTriggersStart = preflightSql.indexOf(
    "'workspaceMasterGenerationTriggers'",
  )
  const workspaceMasterGenerationTriggersEnd = preflightSql.indexOf(
    "\n    'workspaceMasterRowLevelSecurity'",
    workspaceMasterGenerationTriggersStart,
  )
  assert.ok(
    workspaceMasterGenerationTriggersStart >= 0 &&
      workspaceMasterGenerationTriggersEnd > workspaceMasterGenerationTriggersStart,
  )
  const workspaceMasterGenerationTriggersSql = preflightSql.slice(
    workspaceMasterGenerationTriggersStart,
    workspaceMasterGenerationTriggersEnd,
  )
  for (const triggerName of [
    'workspace_master_members_advance_workspace_generation',
    'workspace_master_bands_advance_workspace_generation',
    'workspace_master_band_members_advance_workspace_generation',
    'cloud_workspace_master_states_advance_workspace_generation',
  ]) {
    assert.match(workspaceMasterGenerationTriggersSql, new RegExp(triggerName), triggerName)
  }
  assert.match(workspaceMasterGenerationTriggersSql, /29[\s\S]*17/)
  assert.match(workspaceMasterGenerationTriggersSql, /select count\(\*\) = 4/i)
  assert.doesNotMatch(
    preflightSql,
    /aclexplode\s*\(\s*coalesce\(pg_attribute\.attacl,\s*'\{\}'::aclitem\[\]\s*\)/i,
  )
  const publicColumnWriteStart = preflightSql.indexOf("'publicColumnWrite'")
  const publicColumnWriteEnd = preflightSql.indexOf('\n  ) as value', publicColumnWriteStart)
  assert.ok(publicColumnWriteStart >= 0 && publicColumnWriteEnd > publicColumnWriteStart)
  const publicColumnWriteSql = preflightSql.slice(
    publicColumnWriteStart,
    publicColumnWriteEnd,
  )
  assert.match(
    publicColumnWriteSql,
    /aclexplode\s*\(pg_attribute\.attacl\)[\s\S]*pg_attribute\.attacl is not null/i,
  )
  assert.match(publicColumnWriteSql, /column_acl\.grantee = 0/i)
  assert.match(
    publicColumnWriteSql,
    /column_acl\.privilege_type in \('INSERT', 'UPDATE'\)/i,
  )
  assert.match(fixtureSql, /migration-history-event/)
  assert.match(catalogRegressionSql, /begin;[\s\S]*\\ir cloud_event_migration_history_preflight\.sql[\s\S]*rollback;/i)
  assert.match(
    catalogRegressionSql,
    /when 'membership_role_check_broad'[\s\S]*check \(role in \('owner', 'editor', 'viewer', 'guest'\)\)/i,
  )
  assert.match(
    catalogRegressionSql,
    /when 'membership_foreign_key_wrong_target'[\s\S]*create table public\.catalog_regression_workspaces[\s\S]*insert into public\.catalog_regression_workspaces \(id\)\s*select distinct workspace_id\s*from public\.workspace_members;[\s\S]*references public\.catalog_regression_workspaces\(id\)/i,
  )
  assert.match(
    catalogRegressionSql,
    /when 'profiles_column_type'[\s\S]*alter column display_name type varchar;/i,
  )
  assert.match(
    catalogRegressionSql,
    /when 'workspace_master_initializer_after_update'[\s\S]*after update on public\.workspaces[\s\S]*for each row/i,
  )
  assert.match(
    catalogRegressionSql,
    /when 'workspace_master_initializer_statement_level'[\s\S]*after insert on public\.workspaces[\s\S]*for each statement/i,
  )
  assert.match(
    catalogRegressionSql,
    /when 'workspace_master_member_delete_guard_after'[\s\S]*after delete on public\.workspace_master_members[\s\S]*for each row/i,
  )
  assert.match(
    catalogRegressionSql,
    /when 'workspace_master_delete_guard_misplaced'[\s\S]*drop trigger workspace_master_members_guard_delete_until_ready[\s\S]*before delete on public\.workspace_master_bands/i,
  )
  assert.match(
    catalogRegressionSql,
    /when 'workspace_master_delete_guard_unlocked'[\s\S]*create or replace function public\.guard_workspace_master_delete_until_ready/i,
  )
  assert.match(
    catalogRegressionSql,
    /when 'workspace_master_metadata_trigger_after_insert'[\s\S]*after insert on public\.workspace_master_bands/i,
  )
  assert.match(
    catalogRegressionSql,
    /when 'workspace_master_metadata_trigger_wrong_table'[\s\S]*workspace_master_members_initialize_metadata[\s\S]*on public\.workspace_master_bands/i,
  )
  assert.match(
    catalogRegressionSql,
    /when 'workspace_master_metadata_trigger_wrong_function'[\s\S]*protect_workspace_master_band_identity_and_revision/i,
  )
  assert.doesNotMatch(
    catalogRegressionSql,
    /alter column display_name type varchar\s*\(\s*\d+\s*\)/i,
  )
  for (const scenario of [
    'cloud_anon_column_insert',
    'cloud_anon_column_update',
    'cloud_public_column_insert',
    'cloud_public_column_update',
    'cloud_anon_inherited_delete',
    'cloud_authenticated_inherited_delete',
    'cloud_anon_inherited_table_insert',
    'cloud_anon_inherited_table_update',
    'cloud_authenticated_inherited_table_insert',
    'cloud_authenticated_inherited_table_update',
    'cloud_anon_inherited_column_write',
    'cloud_authenticated_inherited_column_write',
    'cloud_anon_column_grant_option',
    'profiles_missing',
    'profiles_column_type',
    'membership_primary_key_missing',
    'membership_role_check_broad',
    'membership_foreign_key_wrong_target',
    'workspace_rls_disabled',
    'workspace_policy_broad',
    'workspace_policy_extra',
    'updated_at_function_invalid',
    'auth_workspace_anon_column_write',
    'delete_function_security_invoker',
    'delete_authenticated_execute_missing',
    'delete_public_execute',
    'delete_anon_execute',
    'delete_service_role_execute',
    'delete_anon_inherited_execute',
    'page_function_security_invoker',
    'page_authenticated_execute_missing',
    'page_public_execute',
    'page_anon_execute',
    'page_service_role_execute',
    'page_anon_inherited_execute',
    'workspace_generation_trigger_missing',
    'workspace_generation_table_missing',
    'workspace_generation_function_security_invoker',
    'page_generation_guard_missing',
    'save_function_security_invoker',
    'save_public_execute',
    'save_anon_execute',
    'save_authenticated_execute',
    'save_anon_inherited_execute',
    'save_authenticated_inherited_execute',
    'save_service_role_execute_missing',
    'workspace_master_table_missing',
    'workspace_master_constraint_missing',
    'workspace_master_state_initializer_missing',
    'workspace_master_cascade_trigger_missing',
    'workspace_master_cascade_trigger_after',
    'workspace_master_cascade_cleanup_incomplete',
    'workspace_master_initializer_after_update',
    'workspace_master_initializer_statement_level',
    'workspace_master_member_delete_guard_missing',
    'workspace_master_band_delete_guard_missing',
    'workspace_master_member_delete_guard_after',
    'workspace_master_delete_guard_misplaced',
    'workspace_master_delete_guard_unlocked',
    'workspace_master_metadata_initialize_missing',
    'workspace_master_member_metadata_protect_missing',
    'workspace_master_band_metadata_protect_missing',
    'workspace_master_metadata_trigger_disabled',
    'workspace_master_metadata_trigger_after_insert',
    'workspace_master_state_updated_at_missing',
    'workspace_master_relation_identity_trigger_missing',
    'workspace_master_metadata_trigger_wrong_table',
    'workspace_master_metadata_trigger_wrong_function',
    'workspace_master_nonlegacy_state',
    'workspace_master_generation_trigger_missing',
    'workspace_master_rls_disabled',
    'workspace_master_authenticated_table_write',
    'workspace_master_authenticated_inherited_write',
    'workspace_master_read_function_missing',
    'workspace_master_mutation_function_missing',
    'workspace_master_authenticated_mutation_execute',
    'workspace_master_authenticated_inherited_mutation_execute',
    'workspace_master_anon_read_execute',
    'workspace_master_public_read_execute',
    'workspace_master_backfill_table_missing',
    'workspace_master_backfill_authenticated_execute',
    'workspace_master_backfill_authenticated_inherited_execute',
    'workspace_master_backfill_authenticated_inherited_table_read',
    'cloud_event_v2_save_security_invoker',
    'cloud_event_v2_ready_guard_missing',
    'cloud_event_v2_save_authenticated_execute',
    'cloud_event_v2_save_authenticated_inherited_execute',
    'cloud_v2_cutover_inspection_missing',
    'cloud_v2_cutover_inspection_authenticated_execute',
    'cloud_v2_cutover_inspection_authenticated_inherited_execute',
  ]) {
    assert.match(catalogRegressionSql, new RegExp(`'${scenario}'`), scenario)
    assert.match(catalogRegressionRunner, new RegExp(`'${scenario}'`), scenario)
  }
  const scenarioRegistry = catalogRegressionRunner.slice(
    catalogRegressionRunner.indexOf('const scenarios = ['),
    catalogRegressionRunner.indexOf('const parseArguments ='),
  )
  assert.equal([...scenarioRegistry.matchAll(/^\s*\['[^']+'/gmu)].length, 97)
  assert.match(catalogRegressionRunner,
    /JSON\.stringify\(\{ ok: true, scenarios: scenarios\.length \+ 1 \}\)/)
  for (const removedScenario of [
    'save_service_role_missing',
    'required_role_missing',
  ]) {
    assert.doesNotMatch(
      catalogRegressionSql,
      new RegExp(`'${removedScenario}'`),
      removedScenario,
    )
    assert.doesNotMatch(
      catalogRegressionRunner,
      new RegExp(`'${removedScenario}'`),
      removedScenario,
    )
  }
  for (const reservedRole of ['service_role', 'anon', 'authenticated']) {
    assert.doesNotMatch(
      catalogRegressionSql,
      new RegExp(
        `\\b(?:alter|drop)\\s+(?:role|user)\\s+` +
          `(?:if\\s+exists\\s+)?"?${reservedRole}"?(?:\\s|;|$)`,
        'i',
      ),
      reservedRole,
    )
  }
  const baselineGuard = catalogRegressionRunner.slice(
    catalogRegressionRunner.indexOf("inspectScenario(databaseUrl, 'baseline')"),
    catalogRegressionRunner.indexOf('for (const [scenario, detected] of scenarios)'),
  )
  assert.match(baselineGuard, /!baseline\.laterSchema\.authenticatedSelect\b/)
  for (const privilege of [
    'authenticatedInsert',
    'authenticatedUpdate',
    'authenticatedDelete',
    'authenticatedColumnInsert',
    'authenticatedColumnUpdate',
  ]) {
    assert.match(
      baselineGuard,
      new RegExp(`\\|\\|\\s*baseline\\.laterSchema\\.${privilege}\\b`),
      privilege,
    )
  }
  for (const check of [
    'workspaceMasterTables',
    'workspaceMasterConstraints',
    'workspaceMasterStateInitializer',
    'workspaceMasterMetadataTriggers',
    'workspaceMasterGenerationTriggers',
    'workspaceMasterRowLevelSecurity',
    'workspaceMasterPrivileges',
    'cloudV2CutoverInspectionContract',
  ]) {
    assert.match(
      baselineGuard,
      new RegExp(`\\|\\|\\s*!baseline\\.laterSchema\\.${check}\\b`),
      check,
    )
  }
  assert.match(catalogRegressionRunner, /--confirm-disposable/)
  assert.match(guide, /20261008110000[\s\S]*--status applied/)
  assert.match(guide, /20261007120000[\s\S]*--status reverted/)
  assert.match(guide, /--db-url/)
  assert.match(guide, /--dry-run/)
  assert.match(guide,
    /Both revoke migrations perform their direct REVOKEs and privilege guards in one[\s\S]*explicit transaction/i)
  assert.match(guide, /direct REVOKEs roll back with the rest of that migration/i)
  assert.match(guide, /cloud_event_delete_guard_probe/i)
  assert.match(guide, /cloud_event_save_guard_probe/i)
  assert.match(guide, /Expected the inherited DELETE privilege guard to reject the cutover/i)
  assert.match(guide, /where version = '20261008130000'/i)
  assert.match(guide, /where version = '20261008160000'/i)
  assert.match(guide, /ports `54322`, `54422`,\s+`54522`, or `54622`/i)
  assert.match(guide, /All thirteen repository migrations have one explicit `BEGIN` \/ `COMMIT` boundary/i)
  assert.match(guide,
    /migration-history write is a separate runner responsibility[\s\S]*PostgreSQL catalog[\s\S]*supabase_migrations\.schema_migrations/i)
  const fullTransactionExercise = guide.slice(
    guide.indexOf('### Full migration transaction rollback exercise'),
    guide.indexOf('### RPC-only cutover rollback exercise'),
  )
  assert.match(fullTransactionExercise, /select 1 \/ 0;/i)
  assert.match(fullTransactionExercise, /finally/i)
  assert.match(fullTransactionExercise, /to_regclass\('public\.profiles'\) is null/i)
  assert.match(fullTransactionExercise, /to_regclass\('public\.cloud_events'\) is null/i)
  assert.match(fullTransactionExercise,
    /to_regprocedure\('public\.delete_cloud_event_authorized\(uuid,text\)'\) is null/i)
  assert.match(fullTransactionExercise,
    /to_regprocedure\('public\.load_cloud_events_page_authorized\(uuid,text,integer\)'\) is null/i)
  assert.match(fullTransactionExercise, /where version = 'TARGET_VERSION'/i)
  assert.match(fullTransactionExercise, /rerun `supabase db push`/i)
  const disposableExercise = guide.slice(
    guide.indexOf('## Disposable-database exercise'),
  )
  assert.match(disposableExercise, /Supabase CLI 2\.120\.0/)
  const temporaryCopy = disposableExercise.indexOf(
    'Copy-Item -LiteralPath $currentBase -Destination $temporaryOldBase',
  )
  const markOldApplied = disposableExercise.indexOf(
    'migration repair 20261007120000 --status applied',
  )
  const removeTemporaryCopy = disposableExercise.indexOf(
    'Remove-Item -LiteralPath $temporaryOldBase -Force',
  )
  const markCurrentReverted = disposableExercise.indexOf(
    'migration repair 20261008110000 --status reverted',
  )
  assert.ok(temporaryCopy >= 0)
  assert.ok(markOldApplied > temporaryCopy)
  assert.ok(removeTemporaryCopy > markOldApplied)
  assert.ok(markCurrentReverted > removeTemporaryCopy)
  assert.match(
    disposableExercise,
    /git status --short --[\s\S]*20261007120000_cloud_event_persistence\.sql/,
  )
  assert.match(disposableExercise, /Never create it during production or staging repair/i)
  assert.match(disposableExercise, /never commit or[\s\S]*push it/i)
  assert.match(disposableExercise, /repairCommands` list/)
  assert.match(dbReadme, /cloud-event-migration-history-repair\.md/)
  assert.match(dbReadme, /cloudEventMigrationCatalogRegression\.mjs/)
  assert.ok(migrationFiles.includes('20261008110000_cloud_event_persistence.sql'))
  assert.ok(!migrationFiles.includes('20261007120000_cloud_event_persistence.sql'))
  assert.deepEqual(
    migrationFiles.map(file => file.split('_')[0]).sort(),
    KNOWN_CLOUD_EVENT_MIGRATION_VERSIONS
      .filter(version => version !== OLD_CLOUD_EVENT_MIGRATION_VERSION)
      .sort(),
  )
})
