const express = require('express')
const redis = require('../../models/redis')
const { authenticateAdmin } = require('../../middleware/auth')
const logger = require('../../utils/logger')

const router = express.Router()

const SUPPORTED_TYPES = new Set(['string', 'hash', 'list', 'set', 'zset'])
const PREVIEW_MAX_ITEMS = 10
const DETAIL_MAX_ITEMS = 500
const SEARCH_LIMIT_MAX = 200

function clampInt(value, defaultValue, min, max) {
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    return defaultValue
  }
  return Math.min(Math.max(parsed, min), max)
}

function safeJsonParse(value) {
  try {
    return { ok: true, value: JSON.parse(value) }
  } catch (error) {
    return { ok: false, error }
  }
}

async function getKeySize(client, key, type) {
  switch (type) {
    case 'string':
      return await client.strlen(key)
    case 'hash':
      return await client.hlen(key)
    case 'list':
      return await client.llen(key)
    case 'set':
      return await client.scard(key)
    case 'zset':
      return await client.zcard(key)
    default:
      return 0
  }
}

async function getKeyPreview(client, key, type) {
  switch (type) {
    case 'string': {
      const value = await client.get(key)
      if (value === null) {
        return null
      }
      return value.length > 200 ? `${value.slice(0, 200)}...` : value
    }
    case 'hash': {
      const entries = await client.hscan(key, '0', 'COUNT', PREVIEW_MAX_ITEMS)
      const flat = entries[1] || []
      const preview = {}
      for (let i = 0; i < flat.length; i += 2) {
        preview[flat[i]] = flat[i + 1]
      }
      return preview
    }
    case 'list':
      return await client.lrange(key, 0, PREVIEW_MAX_ITEMS - 1)
    case 'set':
      return await client.srandmember(key, PREVIEW_MAX_ITEMS)
    case 'zset': {
      const rows = await client.zrange(key, 0, PREVIEW_MAX_ITEMS - 1, 'WITHSCORES')
      const preview = []
      for (let i = 0; i < rows.length; i += 2) {
        preview.push({ value: rows[i], score: Number(rows[i + 1]) })
      }
      return preview
    }
    default:
      return null
  }
}

async function getKeyDetail(client, key) {
  const type = await client.type(key)
  if (type === 'none') {
    return null
  }

  const ttlSeconds = await client.ttl(key)
  const pttl = await client.pttl(key)
  const size = await getKeySize(client, key, type)

  let value = null
  switch (type) {
    case 'string':
      value = await client.get(key)
      break
    case 'hash':
      value = await client.hgetall(key)
      break
    case 'list':
      value = await client.lrange(key, 0, DETAIL_MAX_ITEMS - 1)
      break
    case 'set':
      value = await client.smembers(key)
      break
    case 'zset': {
      const rows = await client.zrange(key, 0, DETAIL_MAX_ITEMS - 1, 'WITHSCORES')
      value = []
      for (let i = 0; i < rows.length; i += 2) {
        value.push({ value: rows[i], score: Number(rows[i + 1]) })
      }
      break
    }
    default:
      value = null
  }

  return {
    key,
    type,
    ttlSeconds,
    pttl,
    size,
    value,
    truncated: size > DETAIL_MAX_ITEMS
  }
}

async function writeKeyValue(client, key, type, parsedValue, ttlSeconds) {
  const pipeline = client.pipeline()
  pipeline.del(key)

  switch (type) {
    case 'string':
      pipeline.set(key, String(parsedValue))
      break
    case 'hash': {
      const entries = Object.entries(parsedValue || {})
      if (entries.length > 0) {
        pipeline.hset(key, Object.fromEntries(entries.map(([field, value]) => [field, String(value)])))
      } else {
        pipeline.hset(key, '__empty__', '__empty__')
        pipeline.hdel(key, '__empty__')
      }
      break
    }
    case 'list': {
      const values = Array.isArray(parsedValue) ? parsedValue.map((item) => String(item)) : []
      if (values.length > 0) {
        pipeline.rpush(key, ...values)
      } else {
        pipeline.rpush(key, '__empty__')
        pipeline.lpop(key)
      }
      break
    }
    case 'set': {
      const values = Array.isArray(parsedValue) ? parsedValue.map((item) => String(item)) : []
      if (values.length > 0) {
        pipeline.sadd(key, ...values)
      } else {
        pipeline.sadd(key, '__empty__')
        pipeline.srem(key, '__empty__')
      }
      break
    }
    case 'zset': {
      const rows = Array.isArray(parsedValue) ? parsedValue : []
      if (rows.length > 0) {
        const args = []
        rows.forEach((item) => {
          args.push(Number(item.score) || 0, String(item.value))
        })
        pipeline.zadd(key, ...args)
      } else {
        pipeline.zadd(key, 0, '__empty__')
        pipeline.zrem(key, '__empty__')
      }
      break
    }
    default:
      throw new Error(`Unsupported Redis type: ${type}`)
  }

  if (ttlSeconds > 0) {
    pipeline.expire(key, ttlSeconds)
  }

  await pipeline.exec()
}

router.get('/redis-browser/search', authenticateAdmin, async (req, res) => {
  try {
    const client = redis.getClientSafe()
    const pattern = (req.query.pattern || '*').trim() || '*'
    const cursor = req.query.cursor || '0'
    const limit = clampInt(req.query.limit, 50, 1, SEARCH_LIMIT_MAX)

    const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', limit)

    const pipeline = client.pipeline()
    keys.forEach((key) => {
      pipeline.type(key)
      pipeline.ttl(key)
    })
    const metaResults = keys.length > 0 ? await pipeline.exec() : []

    const data = []
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      const type = metaResults[i * 2]?.[1]
      const ttlSeconds = metaResults[i * 2 + 1]?.[1]
      const size = await getKeySize(client, key, type)
      const preview = SUPPORTED_TYPES.has(type) ? await getKeyPreview(client, key, type) : null

      data.push({
        key,
        type,
        ttlSeconds,
        size,
        preview,
        editable: SUPPORTED_TYPES.has(type)
      })
    }

    return res.json({
      success: true,
      data,
      cursor: nextCursor,
      hasMore: nextCursor !== '0'
    })
  } catch (error) {
    logger.error('Failed to search Redis keys:', error)
    return res.status(500).json({ error: 'Failed to search Redis keys', message: error.message })
  }
})

router.get('/redis-browser/key', authenticateAdmin, async (req, res) => {
  try {
    const key = (req.query.key || '').trim()
    if (!key) {
      return res.status(400).json({ error: 'Key is required', message: 'Key is required' })
    }

    const client = redis.getClientSafe()
    const detail = await getKeyDetail(client, key)
    if (!detail) {
      return res.status(404).json({ error: 'Key not found', message: 'Redis key not found' })
    }

    return res.json({ success: true, data: detail })
  } catch (error) {
    logger.error('Failed to get Redis key detail:', error)
    return res
      .status(500)
      .json({ error: 'Failed to get Redis key detail', message: error.message })
  }
})

router.put('/redis-browser/key', authenticateAdmin, async (req, res) => {
  try {
    const key = (req.body.key || '').trim()
    const editorValue = req.body.value

    if (!key) {
      return res.status(400).json({ error: 'Key is required', message: 'Key is required' })
    }

    if (typeof editorValue !== 'string') {
      return res
        .status(400)
        .json({ error: 'Value must be string', message: 'Value must be JSON text' })
    }

    const client = redis.getClientSafe()
    const detail = await getKeyDetail(client, key)
    if (!detail) {
      return res.status(404).json({ error: 'Key not found', message: 'Redis key not found' })
    }

    if (!SUPPORTED_TYPES.has(detail.type)) {
      return res.status(400).json({
        error: 'Unsupported type',
        message: `Type ${detail.type} is not editable in this UI`
      })
    }

    let parsedValue = editorValue
    if (detail.type !== 'string') {
      const parsed = safeJsonParse(editorValue)
      if (!parsed.ok) {
        return res.status(400).json({
          error: 'Invalid JSON',
          message: `JSON parse failed: ${parsed.error.message}`
        })
      }
      parsedValue = parsed.value
    }

    if (detail.type === 'hash' && (parsedValue === null || Array.isArray(parsedValue))) {
      return res
        .status(400)
        .json({ error: 'Invalid hash value', message: 'Hash value must be a JSON object' })
    }
    if ((detail.type === 'list' || detail.type === 'set') && !Array.isArray(parsedValue)) {
      return res
        .status(400)
        .json({ error: 'Invalid array value', message: 'Value must be a JSON array' })
    }
    if (detail.type === 'zset') {
      if (!Array.isArray(parsedValue)) {
        return res
          .status(400)
          .json({ error: 'Invalid zset value', message: 'Value must be a JSON array' })
      }
      const invalidItem = parsedValue.find(
        (item) =>
          typeof item !== 'object' ||
          item === null ||
          typeof item.value === 'undefined' ||
          !Number.isFinite(Number(item.score))
      )
      if (invalidItem) {
        return res.status(400).json({
          error: 'Invalid zset item',
          message: 'Each item must contain value and numeric score'
        })
      }
    }

    const ttlSeconds = detail.ttlSeconds > 0 ? detail.ttlSeconds : 0
    await writeKeyValue(client, key, detail.type, parsedValue, ttlSeconds)
    const updatedDetail = await getKeyDetail(client, key)

    return res.json({
      success: true,
      message: 'Redis key updated successfully',
      data: updatedDetail
    })
  } catch (error) {
    logger.error('Failed to update Redis key:', error)
    return res.status(500).json({ error: 'Failed to update Redis key', message: error.message })
  }
})

module.exports = router
