#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const Redis = require('ioredis')
const config = require('../config/config')

const OLD_MODEL = 'gpt-image-2'
const RESPONSE_ENDPOINTS = new Set([
  '/openai/responses',
  '/openai/v1/responses',
  '/openai/responses/compact',
  '/openai/v1/responses/compact'
])
const REQUEST_DETAIL_DAY_INDEX_PREFIX = 'request_detail:index:day:'
const REQUEST_DETAIL_ITEM_PREFIX = 'request_detail:item:'

function parseArgs(argv) {
  const args = {
    apply: false,
    yes: false,
    start: null,
    end: null,
    batchSize: 50,
    sleepMs: 150,
    limit: 0,
    keyId: '',
    accountId: '',
    models: '',
    output: '',
    rollbackDir: '',
    includeUnknownBodyModel: false
  }

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--apply') {
      args.apply = true
    } else if (arg === '--yes') {
      args.yes = true
    } else if (arg === '--include-unknown-body-model') {
      args.includeUnknownBodyModel = true
    } else if (arg.startsWith('--start=')) {
      args.start = arg.slice('--start='.length)
    } else if (arg === '--start') {
      args.start = next
      i++
    } else if (arg.startsWith('--end=')) {
      args.end = arg.slice('--end='.length)
    } else if (arg === '--end') {
      args.end = next
      i++
    } else if (arg.startsWith('--batch-size=')) {
      args.batchSize = Number.parseInt(arg.slice('--batch-size='.length), 10)
    } else if (arg === '--batch-size') {
      args.batchSize = Number.parseInt(next, 10)
      i++
    } else if (arg.startsWith('--sleep-ms=')) {
      args.sleepMs = Number.parseInt(arg.slice('--sleep-ms='.length), 10)
    } else if (arg === '--sleep-ms') {
      args.sleepMs = Number.parseInt(next, 10)
      i++
    } else if (arg.startsWith('--limit=')) {
      args.limit = Number.parseInt(arg.slice('--limit='.length), 10)
    } else if (arg === '--limit') {
      args.limit = Number.parseInt(next, 10)
      i++
    } else if (arg.startsWith('--key-id=')) {
      args.keyId = arg.slice('--key-id='.length)
    } else if (arg === '--key-id') {
      args.keyId = next
      i++
    } else if (arg.startsWith('--account-id=')) {
      args.accountId = arg.slice('--account-id='.length)
    } else if (arg === '--account-id') {
      args.accountId = next
      i++
    } else if (arg.startsWith('--models=')) {
      args.models = arg.slice('--models='.length)
    } else if (arg === '--models') {
      args.models = next
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

  args.batchSize = Number.isFinite(args.batchSize) && args.batchSize > 0 ? args.batchSize : 50
  args.sleepMs = Number.isFinite(args.sleepMs) && args.sleepMs >= 0 ? args.sleepMs : 150
  args.limit = Number.isFinite(args.limit) && args.limit > 0 ? args.limit : 0
  return args
}

function printHelp() {
  console.log(`Usage:
  node scripts/fix-openai-image-model-attribution.js [options]

Default mode is dry-run and does not modify Redis.

Options:
  --start <iso>                  Start time, default: now - 72h
  --end <iso>                    End time, default: now
  --models <csv>                 Only repair request body models in CSV list
  --key-id <id>                  Only repair one API Key
  --account-id <id>              Only repair one upstream account
  --limit <n>                    Stop after n candidates
  --output <path>                Write dry-run report JSON
  --apply --yes                  Apply Redis changes
  --batch-size <n>               Apply batch size, default: 50
  --sleep-ms <n>                 Sleep between apply batches, default: 150
  --rollback-dir <path>          Rollback output dir for apply mode
  --include-unknown-body-model   Allow records without requestBodySnapshot.model
`)
}

function parseDate(value, fallback) {
  if (!value) {
    return fallback
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${value}`)
  }
  return parsed
}

function listUtcDayKeys(startDate, endDate) {
  const keys = []
  const cursor = new Date(
    Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())
  )
  const endCursor = new Date(
    Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate())
  )

  while (cursor <= endCursor) {
    keys.push(`${REQUEST_DETAIL_DAY_INDEX_PREFIX}${cursor.toISOString().slice(0, 10)}`)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return keys
}

function getDateInTimezone(date) {
  const offset = config.system.timezoneOffset || 8
  return new Date(date.getTime() + offset * 3600000)
}

function getAggregationParts(timestamp) {
  const date = new Date(timestamp)
  const tzDate = getDateInTimezone(date)
  const day = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(
    2,
    '0'
  )}-${String(tzDate.getUTCDate()).padStart(2, '0')}`
  const month = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}`
  const hour = `${day}:${String(tzDate.getUTCHours()).padStart(2, '0')}`
  return { day, month, hour }
}

function normalizeEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'string') {
    return ''
  }
  return endpoint.split('?')[0]
}

function isNonImageModel(model) {
  return typeof model === 'string' && model.trim() && !model.toLowerCase().startsWith(OLD_MODEL)
}

function extractTargetModel(detail) {
  const body = detail.requestBodySnapshot || detail.requestBody || {}
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  return isNonImageModel(model) ? model : ''
}

function toUsage(detail) {
  return {
    inputTokens: Number(detail.inputTokens || 0),
    outputTokens: Number(detail.outputTokens || 0),
    cacheCreateTokens: Number(detail.cacheCreateTokens || 0),
    cacheReadTokens: Number(detail.cacheReadTokens || 0),
    totalTokens: Number(detail.totalTokens || 0)
  }
}

function addUsage(summary, targetModel, detail) {
  const usage = toUsage(detail)
  const current = summary.byTargetModel[targetModel] || {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    ratedCost: 0,
    realCost: 0
  }
  current.requests += 1
  current.inputTokens += usage.inputTokens
  current.outputTokens += usage.outputTokens
  current.cacheCreateTokens += usage.cacheCreateTokens
  current.cacheReadTokens += usage.cacheReadTokens
  current.totalTokens += usage.totalTokens
  current.ratedCost += Number(detail.cost || 0)
  current.realCost += Number(detail.realCost || 0)
  summary.byTargetModel[targetModel] = current
}

function shouldRepair(detail, options) {
  if (!detail || detail.model !== OLD_MODEL) {
    return { ok: false, reason: 'model_not_gpt_image' }
  }

  const endpoint = normalizeEndpoint(detail.endpoint)
  if (!RESPONSE_ENDPOINTS.has(endpoint)) {
    return { ok: false, reason: 'not_responses_endpoint' }
  }

  if (detail.accountType && !['openai', 'openai-responses'].includes(detail.accountType)) {
    return { ok: false, reason: 'not_openai_account_type' }
  }

  if (options.keyId && detail.apiKeyId !== options.keyId) {
    return { ok: false, reason: 'key_filter' }
  }

  if (options.accountId && detail.accountId !== options.accountId) {
    return { ok: false, reason: 'account_filter' }
  }

  const targetModel = extractTargetModel(detail)
  if (!targetModel && !options.includeUnknownBodyModel) {
    return { ok: false, reason: 'missing_request_body_model' }
  }

  if (options.modelSet.size > 0 && !options.modelSet.has(targetModel)) {
    return { ok: false, reason: 'model_filter' }
  }

  return { ok: true, targetModel: targetModel || 'unknown' }
}

async function loadCandidates(redis, options) {
  const dayKeys = listUtcDayKeys(options.startDate, options.endDate)
  const candidates = []
  const summary = {
    scannedPointers: 0,
    scannedDetails: 0,
    skipped: {},
    byTargetModel: {},
    byApiKey: {},
    byAccount: {}
  }

  for (const dayKey of dayKeys) {
    const pointers = await redis.zrangebyscore(
      dayKey,
      options.startDate.getTime(),
      options.endDate.getTime()
    )
    summary.scannedPointers += pointers.length

    for (const requestId of pointers) {
      if (options.limit && candidates.length >= options.limit) {
        return { candidates, summary, dayKeys }
      }

      const raw = await redis.get(`${REQUEST_DETAIL_ITEM_PREFIX}${requestId}`)
      if (!raw) {
        summary.skipped.missing_detail = (summary.skipped.missing_detail || 0) + 1
        continue
      }

      let detail
      try {
        detail = JSON.parse(raw)
      } catch (_error) {
        summary.skipped.invalid_json = (summary.skipped.invalid_json || 0) + 1
        continue
      }

      summary.scannedDetails += 1
      const decision = shouldRepair(detail, options)
      if (!decision.ok) {
        summary.skipped[decision.reason] = (summary.skipped[decision.reason] || 0) + 1
        continue
      }

      addUsage(summary, decision.targetModel, detail)
      summary.byApiKey[detail.apiKeyId] = (summary.byApiKey[detail.apiKeyId] || 0) + 1
      summary.byAccount[detail.accountId] = (summary.byAccount[detail.accountId] || 0) + 1
      candidates.push({
        requestId,
        apiKeyId: detail.apiKeyId,
        accountId: detail.accountId,
        accountType: detail.accountType,
        endpoint: detail.endpoint,
        timestamp: detail.timestamp,
        oldModel: OLD_MODEL,
        targetModel: decision.targetModel,
        usage: toUsage(detail),
        ratedCost: Number(detail.cost || 0),
        realCost: Number(detail.realCost || 0),
        detail
      })
    }
  }

  return { candidates, summary, dayKeys }
}

function addHashDelta(deltas, key, field, value) {
  if (!value) {
    return
  }
  deltas.push({ op: 'hincrby', key, field, value })
}

function addCostDelta(deltas, key, field, value) {
  const micro = Math.round(Number(value || 0) * 1000000)
  if (micro) {
    deltas.push({ op: 'hincrby', key, field, value: micro })
  }
}

function buildAggregationDeltas(candidate) {
  const { day, month, hour } = getAggregationParts(candidate.timestamp)
  const { apiKeyId, accountId, oldModel, targetModel, usage } = candidate
  const deltas = []
  const metrics = [
    ['inputTokens', usage.inputTokens],
    ['outputTokens', usage.outputTokens],
    ['cacheCreateTokens', usage.cacheCreateTokens],
    ['cacheReadTokens', usage.cacheReadTokens],
    ['allTokens', usage.totalTokens || usage.inputTokens + usage.outputTokens]
  ]

  const modelKeys = [
    `usage:model:daily:${oldModel}:${day}`,
    `usage:model:monthly:${oldModel}:${month}`,
    `usage:model:hourly:${oldModel}:${hour}`,
    `usage:${apiKeyId}:model:daily:${oldModel}:${day}`,
    `usage:${apiKeyId}:model:monthly:${oldModel}:${month}`,
    `usage:${apiKeyId}:model:hourly:${oldModel}:${hour}`,
    `account_usage:model:daily:${accountId}:${oldModel}:${day}`,
    `account_usage:model:monthly:${accountId}:${oldModel}:${month}`,
    `account_usage:model:hourly:${accountId}:${oldModel}:${hour}`
  ]
  const targetKeys = [
    `usage:model:daily:${targetModel}:${day}`,
    `usage:model:monthly:${targetModel}:${month}`,
    `usage:model:hourly:${targetModel}:${hour}`,
    `usage:${apiKeyId}:model:daily:${targetModel}:${day}`,
    `usage:${apiKeyId}:model:monthly:${targetModel}:${month}`,
    `usage:${apiKeyId}:model:hourly:${targetModel}:${hour}`,
    `account_usage:model:daily:${accountId}:${targetModel}:${day}`,
    `account_usage:model:monthly:${accountId}:${targetModel}:${month}`,
    `account_usage:model:hourly:${accountId}:${targetModel}:${hour}`
  ]

  for (const key of modelKeys) {
    for (const [field, value] of metrics) {
      addHashDelta(deltas, key, field, -value)
    }
    addHashDelta(deltas, key, 'requests', -1)
  }

  for (const key of targetKeys) {
    for (const [field, value] of metrics) {
      addHashDelta(deltas, key, field, value)
    }
    addHashDelta(deltas, key, 'requests', 1)
  }

  const alltimeOld = `usage:${apiKeyId}:model:alltime:${oldModel}`
  const alltimeNew = `usage:${apiKeyId}:model:alltime:${targetModel}`
  for (const [field, value] of metrics.filter(([metricName]) => metricName !== 'allTokens')) {
    addHashDelta(deltas, alltimeOld, field, -value)
    addHashDelta(deltas, alltimeNew, field, value)
  }
  addHashDelta(deltas, alltimeOld, 'requests', -1)
  addHashDelta(deltas, alltimeNew, 'requests', 1)

  for (const key of [
    `usage:${apiKeyId}:model:daily:${oldModel}:${day}`,
    `usage:${apiKeyId}:model:monthly:${oldModel}:${month}`,
    `usage:${apiKeyId}:model:hourly:${oldModel}:${hour}`,
    alltimeOld
  ]) {
    addCostDelta(deltas, key, 'realCostMicro', -candidate.realCost)
    addCostDelta(deltas, key, 'ratedCostMicro', -candidate.ratedCost)
  }

  for (const key of [
    `usage:${apiKeyId}:model:daily:${targetModel}:${day}`,
    `usage:${apiKeyId}:model:monthly:${targetModel}:${month}`,
    `usage:${apiKeyId}:model:hourly:${targetModel}:${hour}`,
    alltimeNew
  ]) {
    addCostDelta(deltas, key, 'realCostMicro', candidate.realCost)
    addCostDelta(deltas, key, 'ratedCostMicro', candidate.ratedCost)
  }

  const accountHourly = `account_usage:hourly:${accountId}:${hour}`
  for (const [field, value] of metrics) {
    addHashDelta(deltas, accountHourly, `model:${oldModel}:${field}`, -value)
    addHashDelta(deltas, accountHourly, `model:${targetModel}:${field}`, value)
  }
  addHashDelta(deltas, accountHourly, `model:${oldModel}:requests`, -1)
  addHashDelta(deltas, accountHourly, `model:${targetModel}:requests`, 1)

  return {
    deltas,
    indexes: {
      day,
      month,
      hour,
      apiKeyId,
      accountId,
      targetModel
    }
  }
}

function patchDetail(detail, targetModel) {
  return {
    ...detail,
    model: targetModel,
    correctedFromModel: detail.correctedFromModel || OLD_MODEL,
    correctedAt: new Date().toISOString(),
    correctionReason: 'openai_image_tool_declaration_false_positive'
  }
}

async function patchUsageRecord(redis, candidate, rollback) {
  const key = `usage:records:${candidate.apiKeyId}`
  const entries = await redis.lrange(key, 0, 199)

  for (let index = 0; index < entries.length; index++) {
    let record
    try {
      record = JSON.parse(entries[index])
    } catch (_error) {
      continue
    }

    if (record.requestId !== candidate.requestId || record.model !== OLD_MODEL) {
      continue
    }

    const patched = patchDetail(record, candidate.targetModel)
    await redis.lset(key, index, JSON.stringify(patched))
    rollback.usageRecords.push({
      key,
      index,
      requestId: candidate.requestId,
      originalRecord: record
    })
    return true
  }

  rollback.missingUsageRecords.push({
    key,
    requestId: candidate.requestId
  })
  return false
}

async function addIndexes(redis, indexInfo) {
  const { day, month, hour, apiKeyId, accountId, targetModel } = indexInfo
  await redis
    .pipeline()
    .sadd(`usage:model:daily:index:${day}`, targetModel)
    .sadd(`usage:model:hourly:index:${hour}`, targetModel)
    .sadd(`usage:model:monthly:index:${month}`, targetModel)
    .sadd(`usage:keymodel:daily:index:${day}`, `${apiKeyId}:${targetModel}`)
    .sadd(`usage:keymodel:hourly:index:${hour}`, `${apiKeyId}:${targetModel}`)
    .sadd(`account_usage:model:daily:index:${day}`, `${accountId}:${targetModel}`)
    .sadd(`account_usage:model:hourly:index:${hour}`, `${accountId}:${targetModel}`)
    .exec()
}

async function applyCandidate(redis, candidate, rollback) {
  const detailKey = `${REQUEST_DETAIL_ITEM_PREFIX}${candidate.requestId}`
  const patchedDetail = patchDetail(candidate.detail, candidate.targetModel)
  const ttl = await redis.ttl(detailKey)
  await redis.set(detailKey, JSON.stringify(patchedDetail))
  if (ttl > 0) {
    await redis.expire(detailKey, ttl)
  }

  rollback.requestDetails.push({
    key: detailKey,
    requestId: candidate.requestId,
    ttl,
    originalFields: {
      model: candidate.detail.model,
      correctedFromModel: candidate.detail.correctedFromModel,
      correctedAt: candidate.detail.correctedAt,
      correctionReason: candidate.detail.correctionReason
    }
  })

  await patchUsageRecord(redis, candidate, rollback)

  const { deltas, indexes } = buildAggregationDeltas(candidate)
  const pipeline = redis.pipeline()
  for (const delta of deltas) {
    pipeline.hincrby(delta.key, delta.field, delta.value)
  }
  await pipeline.exec()
  await addIndexes(redis, indexes)
  rollback.deltas.push(...deltas.map((delta) => ({ ...delta, value: -delta.value })))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createReport(options, result) {
  const sample = result.candidates.slice(0, 20).map((candidate) => ({
    requestId: candidate.requestId,
    apiKeyId: candidate.apiKeyId,
    accountId: candidate.accountId,
    timestamp: candidate.timestamp,
    endpoint: candidate.endpoint,
    oldModel: candidate.oldModel,
    targetModel: candidate.targetModel,
    totalTokens: candidate.usage.totalTokens,
    ratedCost: candidate.ratedCost,
    realCost: candidate.realCost
  }))

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    start: options.startDate.toISOString(),
    end: options.endDate.toISOString(),
    dayKeys: result.dayKeys,
    candidateCount: result.candidates.length,
    summary: result.summary,
    sample
  }
}

function ensureRollbackDir(dir) {
  const target =
    dir ||
    path.join(
      process.cwd(),
      'local',
      'rollback',
      `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}_openai_image_model_redis_fix`
    )
  fs.mkdirSync(target, { recursive: true })
  return target
}

async function applyCandidates(redis, options, candidates) {
  if (!options.yes) {
    throw new Error('Apply mode requires --yes')
  }

  const rollbackDir = ensureRollbackDir(options.rollbackDir)
  const rollback = {
    createdAt: new Date().toISOString(),
    note: 'Rollback data contains only mutable fields and usage records, not request body snapshots.',
    requestDetails: [],
    usageRecords: [],
    missingUsageRecords: [],
    deltas: []
  }

  for (let i = 0; i < candidates.length; i += options.batchSize) {
    const batch = candidates.slice(i, i + options.batchSize)
    for (const candidate of batch) {
      await applyCandidate(redis, candidate, rollback)
    }
    console.log(`Applied ${Math.min(i + batch.length, candidates.length)}/${candidates.length}`)
    if (options.sleepMs > 0 && i + batch.length < candidates.length) {
      await sleep(options.sleepMs)
    }
  }

  const rollbackPath = path.join(rollbackDir, 'rollback.json')
  fs.writeFileSync(rollbackPath, JSON.stringify(rollback, null, 2))
  fs.writeFileSync(
    path.join(rollbackDir, 'README.md'),
    [
      '# OpenAI image model Redis fix rollback',
      '',
      'This directory stores rollback metadata for the Redis history attribution fix.',
      'Use the JSON file to restore request detail model fields, usage record entries, and reverse aggregation deltas.',
      'It intentionally does not store request body snapshots.'
    ].join('\n')
  )

  return { rollbackDir, rollbackPath }
}

async function main() {
  const args = parseArgs(process.argv)
  const now = new Date()
  const defaultStart = new Date(now.getTime() - 72 * 3600 * 1000)
  const options = {
    ...args,
    startDate: parseDate(args.start, defaultStart),
    endDate: parseDate(args.end, now),
    modelSet: new Set(
      args.models
        ? args.models
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : []
    )
  }

  if (options.startDate > options.endDate) {
    throw new Error('Start date must be before end date')
  }

  const redis = new Redis({
    ...config.redis,
    tls: config.redis.enableTLS ? {} : undefined
  })

  try {
    await redis.ping()
    const result = await loadCandidates(redis, options)
    const report = createReport(options, result)
    console.log(JSON.stringify(report, null, 2))

    if (options.output) {
      fs.mkdirSync(path.dirname(options.output), { recursive: true })
      fs.writeFileSync(options.output, JSON.stringify(report, null, 2))
    }

    if (options.apply) {
      const applyResult = await applyCandidates(redis, options, result.candidates)
      console.log(JSON.stringify({ applied: result.candidates.length, ...applyResult }, null, 2))
    }
  } finally {
    redis.disconnect()
  }
}

main().catch((error) => {
  console.error(`Failed: ${error.message}`)
  process.exit(1)
})
