#!/usr/bin/env node

const axios = require('axios')
const redis = require('../src/models/redis')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')

async function main() {
  const accountIds = process.argv.slice(2)
  if (accountIds.length === 0) {
    throw new Error('Usage: node scripts/check-image-upstream.js <accountId> [accountId...]')
  }

  const prompt = 'a small glowing robot on a clean white desk'
  await redis.connect()

  for (const accountId of accountIds) {
    const account = await openaiResponsesAccountService.getAccount(accountId)
    if (!account) {
      console.log(JSON.stringify({ accountId, ok: false, error: 'account_not_found' }))
      continue
    }

    const baseApi = String(account.baseApi || '').replace(/\/+$/, '')
    const url = baseApi.endsWith('/v1')
      ? `${baseApi}/images/generations`
      : `${baseApi}/v1/images/generations`

    const startedAt = Date.now()
    try {
      const response = await axios({
        method: 'post',
        url,
        headers: {
          Authorization: `Bearer ${account.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'crs-upstream-check/1.0'
        },
        data: {
          model: 'gpt-image-2',
          prompt,
          size: '1024x1024',
          quality: 'low',
          n: 1
        },
        timeout: 150000,
        validateStatus: () => true
      })

      const elapsedMs = Date.now() - startedAt
      const body = response.data
      const summary = {
        accountId,
        name: account.name,
        url,
        status: response.status,
        elapsedMs,
        hasDataArray: Array.isArray(body?.data),
        dataLength: Array.isArray(body?.data) ? body.data.length : 0,
        hasUsage: !!body?.usage,
        model: body?.model || null,
        errorMessage: body?.error?.message || body?.message || body?.body?.slice?.(0, 180) || null
      }
      console.log(JSON.stringify(summary))
    } catch (error) {
      const elapsedMs = Date.now() - startedAt
      console.log(
        JSON.stringify({
          accountId,
          name: account.name,
          url,
          ok: false,
          elapsedMs,
          code: error.code || null,
          message: error.message
        })
      )
    }
  }

  await redis.disconnect()
}

main().catch((error) => {
  console.error(error.message || String(error))
  process.exit(1)
})
