#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const Redis = require('ioredis')
const config = require('../config/config')

const DEFAULT_OLD_MODEL = 'gpt-image-2'
const NUMERIC_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheCreateTokens',
  'cacheReadTokens',
  'allTokens',
  'requests',
  'ephemeral5mTokens',
  'ephemeral1hTokens',
  'realCostMicro',
  'ratedCostMicro'
]

function parseArgs(argv) {
  const args = {
    apply: false,
    yes: false,
    oldModel: DEFAULT_OLD_MODEL,
    targetModel: '',
    keyIds: '',
    date: '',
    month: '',
    includeHourly: false,
    cleanupZero: true,
    movePositive: false,
    allowPositiveApply: false,
    output: '',
    rollbackDir: ''
  }

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--apply') {
      args.apply = true
    } else if (arg === '--yes') {
      args.yes = true
    } else if (arg === '--include-hourly') {
      args.includeHourly = true
    } else if (arg === '--no-cleanup-zero') {
      args.cleanupZero = false
    } else if (arg === '--move-positive') {
      args.movePositive = true
    } else if (arg === '--allow-positive-apply') {
      args.allowPositiveApply = true
    } else if (arg.startsWith('--old-model=')) {
      args.oldModel = arg.slice('--old-model='.length)
    } else if (arg === '--old-model') {
      args.oldModel = next
      i++
    } else if (arg.startsWith('--target-model=')) {
      args.targetModel = arg.slice('--target-model='.length)
    } else if (arg === '--target-model') {
      args.targetModel = next
      i++
    } else if (arg.startsWith('--key-ids=')) {
      args.keyIds = arg.slice('--key-ids='.length)
    } else if (arg === '--key-ids') {
      args.keyIds = next
      i++
    } else if (arg.startsWith('--date=')) {
      args.date = arg.slice('--date='.length)
    } else if (arg === '--date') {
      args.date = next
      i++
    } else if (arg.startsWith('--month=')) {
      args.month = arg.slice('--month='.length)
    } else if (arg === '--month') {
      args.month = next
      i++
    } else if (arg.startsWith('--output=')) {
      args.output = arg.slice('--output='.length)
    } else if (arg === '--output') {
      args.output = next
      i++
    } else if (arg.startsWith('--rollback-dir=')) {
      args.rollbackDir = arg.slice('--rollback-dir='.length)
    } else if (arg === '--rollback-dir') {
      args.rollbackDir = next
      i++
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  args.oldModel = String(args.oldModel || '').trim()
  args.targetModel = String(args.targetModel || '').trim()
  args.keyIdSet = new Set(
    String(args.keyIds || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  )

  if (!args.oldModel) {
    throw new Error('--old-model is required')
  }
  if (args.movePositive && !args.targetModel) {
    throw new Error('--move-positive requires --target-model')
  }
  if (args.apply && !args.yes) {
    throw new Error('Apply mode requires --yes')
  }
  if (args.apply && args.movePositive && !args.allowPositiveApply) {
    throw new Error('Positive aggregate apply requires --allow-positive-apply')
  }

  return args
}

function printHelp() {
  console.log(`Usage:
  node scripts/fix-openai-image-model-residual-aggregates.js [options]

Default mode is dry-run and does not modify Redis. It scans customer-facing API-key
model aggregate hashes for residual old-model rows.

Options:
  --old-model <model>            Old model to scan, default: gpt-image-2
  --target-model <model>         Target model for positive aggregate preview
  --move-positive                Preview/apply moving positive old-model hashes to target model
  --allow-positive-apply         Required with --apply --move-positive
  --key-ids <csv>                Limit to specific API key IDs
  --date <yyyy-mm-dd>            Daily date, default: current service timezone date
  --month <yyyy-mm>              Monthly period, default: current service timezone month
  --include-hourly               Also scan hourly key-level hashes for the selected date
  --no-cleanup-zero              Do not include all-zero old-model hash cleanup candidates
  --output <path>                Write report JSON
  --apply --yes                  Apply planned zero cleanup and optional positive moves
  --rollback-dir <path>          Rollback output dir for apply mode
`)
}

function getDateParts() {
  const offset = config.system.timezoneOffset || 8
  const date = new Date(Date.now() + offset * 3600000)
  const day = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(
    date.getUTCDate()
  ).padStart(2, '0')}`
  const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
  return { day, month }
}

function parseNumber(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function extractStats(data) {
  const stats = {}
  for (const field of NUMERIC_FIELDS) {
    stats[field] = parseNumber(data[field])
  }
  return stats
}

function sumStats(stats) {
  return NUMERIC_FIELDS.reduce((sum, field) => sum + Math.abs(stats[field] || 0), 0)
}

function hasPositive(stats) {
  return NUMERIC_FIELDS.some((field) => (stats[field] || 0) > 0)
}

function hasNegative(stats) {
  return NUMERIC_FIELDS.some((field) => (stats[field] || 0) < 0)
}

function isZero(stats) {
  return sumStats(stats) === 0
}

function addStats(target, stats) {
  for (const field of NUMERIC_FIELDS) {
    target[field] = (target[field] || 0) + (stats[field] || 0)
  }
}

function buildScanSpecs(options) {
  const { day, month } = getDateParts()
  const date = options.date || day
  const targetMonth = options.month || month
  const specs = [
    {
      period: 'daily',
      pattern: `usage:*:model:daily:${options.oldModel}:${date}`,
      regex: /^usage:([^:]+):model:daily:(.+):(\d{4}-\d{2}-\d{2})$/,
      indexKey: (_keyId, datePart) => `usage:keymodel:daily:index:${datePart}`,
      indexMember: (keyId, model) => `${keyId}:${model}`
    },
    {
      period: 'monthly',
      pattern: `usage:*:model:monthly:${options.oldModel}:${targetMonth}`,
      regex: /^usage:([^:]+):model:monthly:(.+):(\d{4}-\d{2})$/,
      indexKey: null,
      indexMember: null
    },
    {
      period: 'alltime',
      pattern: `usage:*:model:alltime:${options.oldModel}`,
      regex: /^usage:([^:]+):model:alltime:(.+)$/,
      indexKey: null,
      indexMember: null
    }
  ]

  if (options.includeHourly) {
    specs.push({
      period: 'hourly',
      pattern: `usage:*:model:hourly:${options.oldModel}:${date}:*`,
      regex: /^usage:([^:]+):model:hourly:(.+):(\d{4}-\d{2}-\d{2}:\d{2})$/,
      indexKey: (_keyId, hourPart) => `usage:keymodel:hourly:index:${hourPart}`,
      indexMember: (keyId, model) => `${keyId}:${model}`
    })
  }

  return specs
}

function makeTargetKey(item, targetModel) {
  if (item.period === 'daily') {
    return `usage:${item.keyId}:model:daily:${targetModel}:${item.periodPart}`
  }
  if (item.period === 'monthly') {
    return `usage:${item.keyId}:model:monthly:${targetModel}:${item.periodPart}`
  }
  if (item.period === 'hourly') {
    return `usage:${item.keyId}:model:hourly:${targetModel}:${item.periodPart}`
  }
  return `usage:${item.keyId}:model:alltime:${targetModel}`
}

async function scanKeys(redis, pattern) {
  let cursor = '0'
  const keys = []
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500)
    cursor = nextCursor
    keys.push(...batch)
  } while (cursor !== '0')
  return keys
}

async function inspectResiduals(redis, options) {
  const specs = buildScanSpecs(options)
  const result = {
    scannedHashes: 0,
    skippedByKeyFilter: 0,
    skippedModelMismatch: 0,
    zeroItems: [],
    positiveItems: [],
    negativeItems: [],
    byKeyPositive: {},
    byPeriodPositive: {}
  }

  for (const spec of specs) {
    const keys = await scanKeys(redis, spec.pattern)
    for (const key of keys) {
      const match = key.match(spec.regex)
      if (!match) {
        continue
      }
      const keyId = match[1]
      const model = match[2]
      const periodPart = match[3] || ''
      if (model !== options.oldModel) {
        result.skippedModelMismatch += 1
        continue
      }
      if (options.keyIdSet.size > 0 && !options.keyIdSet.has(keyId)) {
        result.skippedByKeyFilter += 1
        continue
      }

      const data = await redis.hgetall(key)
      if (!data || Object.keys(data).length === 0) {
        continue
      }

      result.scannedHashes += 1
      const stats = extractStats(data)
      const item = {
        key,
        keyId,
        period: spec.period,
        periodPart,
        stats,
        ttl: await redis.ttl(key),
        indexKey: spec.indexKey ? spec.indexKey(keyId, periodPart) : null,
        oldIndexMember: spec.indexMember ? spec.indexMember(keyId, options.oldModel) : null,
        targetIndexMember:
          spec.indexMember && options.targetModel
            ? spec.indexMember(keyId, options.targetModel)
            : null
      }

      if (isZero(stats)) {
        result.zeroItems.push(item)
      } else if (hasPositive(stats) && !hasNegative(stats)) {
        item.targetKey = options.targetModel ? makeTargetKey(item, options.targetModel) : null
        result.positiveItems.push(item)
        if (!result.byKeyPositive[keyId]) {
          result.byKeyPositive[keyId] = { hashes: 0, stats: {} }
        }
        result.byKeyPositive[keyId].hashes += 1
        addStats(result.byKeyPositive[keyId].stats, stats)
        if (!result.byPeriodPositive[item.period]) {
          result.byPeriodPositive[item.period] = { hashes: 0, stats: {} }
        }
        result.byPeriodPositive[item.period].hashes += 1
        addStats(result.byPeriodPositive[item.period].stats, stats)
      } else {
        result.negativeItems.push(item)
      }
    }
  }

  return result
}

function createReport(options, inspected) {
  const plannedZeroCleanup = options.cleanupZero ? inspected.zeroItems.length : 0
  const plannedPositiveMoves = options.movePositive ? inspected.positiveItems.length : 0
  const warnings = [
    'Positive aggregate moves are key-level only and should be applied only after the target model mapping is confirmed.',
    'This script does not infer request body model for expired request details.'
  ]

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    oldModel: options.oldModel,
    targetModel: options.targetModel || null,
    filters: {
      keyIds: [...options.keyIdSet],
      date: options.date || getDateParts().day,
      month: options.month || getDateParts().month,
      includeHourly: options.includeHourly
    },
    options: {
      cleanupZero: options.cleanupZero,
      movePositive: options.movePositive
    },
    summary: {
      scannedHashes: inspected.scannedHashes,
      zeroCleanupCandidates: inspected.zeroItems.length,
      positiveResiduals: inspected.positiveItems.length,
      negativeOrMixedResiduals: inspected.negativeItems.length,
      plannedZeroCleanup,
      plannedPositiveMoves
    },
    byPeriodPositive: inspected.byPeriodPositive,
    byKeyPositive: inspected.byKeyPositive,
    positiveResiduals: inspected.positiveItems.map((item) => ({
      key: item.key,
      targetKey: item.targetKey,
      keyId: item.keyId,
      period: item.period,
      periodPart: item.periodPart,
      stats: item.stats
    })),
    zeroCleanupCandidates: inspected.zeroItems.map((item) => ({
      key: item.key,
      keyId: item.keyId,
      period: item.period,
      periodPart: item.periodPart,
      indexKey: item.indexKey,
      oldIndexMember: item.oldIndexMember,
      ttl: item.ttl
    })),
    negativeOrMixedResiduals: inspected.negativeItems.map((item) => ({
      key: item.key,
      keyId: item.keyId,
      period: item.period,
      periodPart: item.periodPart,
      stats: item.stats
    })),
    warnings
  }
}

function ensureRollbackDir(dir) {
  const target =
    dir ||
    path.join(
      process.cwd(),
      'local',
      'rollback',
      `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}_openai_image_residual_aggregate_fix`
    )
  fs.mkdirSync(target, { recursive: true })
  return target
}

async function applyZeroCleanup(redis, items, rollback) {
  for (const item of items) {
    const original = await redis.hgetall(item.key)
    const ttl = await redis.ttl(item.key)
    const pipeline = redis.pipeline()
    pipeline.del(item.key)
    if (item.indexKey && item.oldIndexMember) {
      pipeline.srem(item.indexKey, item.oldIndexMember)
      rollback.indexOps.push({ op: 'sadd', key: item.indexKey, member: item.oldIndexMember })
    }
    await pipeline.exec()
    rollback.deletedHashes.push({ key: item.key, ttl, data: original })
  }
}

async function applyPositiveMoves(redis, items, targetModel, rollback) {
  for (const item of items) {
    const targetKey = makeTargetKey(item, targetModel)
    const oldData = await redis.hgetall(item.key)
    const newData = await redis.hgetall(targetKey)
    const oldTtl = await redis.ttl(item.key)
    const newTtl = await redis.ttl(targetKey)
    const stats = extractStats(oldData)
    const pipeline = redis.pipeline()

    for (const field of NUMERIC_FIELDS) {
      if (stats[field]) {
        pipeline.hincrby(targetKey, field, stats[field])
      }
    }
    if (Object.keys(newData).length === 0 && oldTtl > 0) {
      pipeline.expire(targetKey, oldTtl)
    }
    pipeline.del(item.key)
    if (item.indexKey && item.oldIndexMember) {
      pipeline.srem(item.indexKey, item.oldIndexMember)
      rollback.indexOps.push({ op: 'sadd', key: item.indexKey, member: item.oldIndexMember })
    }
    if (item.indexKey && item.targetIndexMember) {
      pipeline.sadd(item.indexKey, item.targetIndexMember)
      rollback.indexOps.push({ op: 'srem', key: item.indexKey, member: item.targetIndexMember })
    }
    await pipeline.exec()

    rollback.movedHashes.push({
      oldKey: item.key,
      targetKey,
      oldTtl,
      newTtl,
      oldData,
      previousTargetData: newData
    })
  }
}

async function applyChanges(redis, options, inspected) {
  const rollbackDir = ensureRollbackDir(options.rollbackDir)
  const rollback = {
    createdAt: new Date().toISOString(),
    note: 'Rollback stores complete old and previous target key hashes for customer-facing key-level residual aggregate cleanup.',
    deletedHashes: [],
    movedHashes: [],
    indexOps: []
  }

  if (options.cleanupZero) {
    await applyZeroCleanup(redis, inspected.zeroItems, rollback)
  }
  if (options.movePositive) {
    await applyPositiveMoves(redis, inspected.positiveItems, options.targetModel, rollback)
  }

  const rollbackPath = path.join(rollbackDir, 'rollback.json')
  fs.writeFileSync(rollbackPath, JSON.stringify(rollback, null, 2))
  fs.writeFileSync(
    path.join(rollbackDir, 'README.md'),
    [
      '# OpenAI image residual aggregate rollback',
      '',
      'Use rollback.json to restore deleted old-model hashes and previous target hashes.',
      'This rollback is intentionally scoped to customer-facing key-level aggregate hashes.'
    ].join('\n')
  )
  return { rollbackDir, rollbackPath }
}

async function main() {
  const options = parseArgs(process.argv)
  const redis = new Redis({
    ...config.redis,
    tls: config.redis.enableTLS ? {} : undefined
  })

  try {
    await redis.ping()
    const inspected = await inspectResiduals(redis, options)
    const report = createReport(options, inspected)
    console.log(JSON.stringify(report, null, 2))

    if (options.output) {
      fs.mkdirSync(path.dirname(options.output), { recursive: true })
      fs.writeFileSync(options.output, JSON.stringify(report, null, 2))
    }

    if (options.apply) {
      const applyResult = await applyChanges(redis, options, inspected)
      console.log(JSON.stringify({ applied: report.summary, ...applyResult }, null, 2))
    }
  } finally {
    redis.disconnect()
  }
}

main().catch((error) => {
  console.error(`Failed: ${error.message}`)
  process.exit(1)
})
