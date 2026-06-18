#!/usr/bin/env node

const fs = require('fs')
const Redis = require('ioredis')
const config = require('../config/config')

function parseArgs(argv) {
  const args = {
    file: '',
    yes: false
  }

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--yes') {
      args.yes = true
    } else if (arg.startsWith('--file=')) {
      args.file = arg.slice('--file='.length)
    } else if (arg === '--file') {
      args.file = next
      i++
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!args.file) {
    throw new Error('--file is required')
  }
  if (!args.yes) {
    throw new Error('Rollback requires --yes')
  }
  return args
}

function printHelp() {
  console.log(`Usage:
  node scripts/rollback-openai-image-model-residual-aggregates.js --file <rollback.json> --yes
`)
}

async function restoreHash(redis, key, data, ttl) {
  const pipeline = redis.pipeline()
  pipeline.del(key)
  if (data && Object.keys(data).length > 0) {
    pipeline.hset(key, data)
    if (ttl > 0) {
      pipeline.expire(key, ttl)
    }
  }
  await pipeline.exec()
}

async function main() {
  const args = parseArgs(process.argv)
  const rollback = JSON.parse(fs.readFileSync(args.file, 'utf8'))
  const redis = new Redis({
    ...config.redis,
    tls: config.redis.enableTLS ? {} : undefined
  })

  try {
    await redis.ping()

    for (const moved of rollback.movedHashes || []) {
      await restoreHash(redis, moved.oldKey, moved.oldData, moved.oldTtl)
      await restoreHash(redis, moved.targetKey, moved.previousTargetData, moved.newTtl)
    }

    for (const deleted of rollback.deletedHashes || []) {
      await restoreHash(redis, deleted.key, deleted.data, deleted.ttl)
    }

    if (Array.isArray(rollback.indexOps) && rollback.indexOps.length > 0) {
      const pipeline = redis.pipeline()
      for (const item of rollback.indexOps) {
        if (item.op === 'sadd') {
          pipeline.sadd(item.key, item.member)
        } else if (item.op === 'srem') {
          pipeline.srem(item.key, item.member)
        }
      }
      await pipeline.exec()
    }

    console.log(
      JSON.stringify(
        {
          restoredDeletedHashes: (rollback.deletedHashes || []).length,
          restoredMovedHashes: (rollback.movedHashes || []).length,
          restoredIndexOps: (rollback.indexOps || []).length
        },
        null,
        2
      )
    )
  } finally {
    redis.disconnect()
  }
}

main().catch((error) => {
  console.error(`Failed: ${error.message}`)
  process.exit(1)
})
