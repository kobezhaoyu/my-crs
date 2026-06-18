const axios = require('axios')
const ProxyHelper = require('../../utils/proxyHelper')
const logger = require('../../utils/logger')
const { filterForOpenAI } = require('../../utils/headerFilter')
const openaiResponsesAccountService = require('../account/openaiResponsesAccountService')
const apiKeyService = require('../apiKeyService')
const unifiedOpenAIScheduler = require('../scheduler/unifiedOpenAIScheduler')
const config = require('../../../config/config')
const crypto = require('crypto')
const LRUCache = require('../../utils/lruCache')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const {
  createRequestDetailMeta,
  extractOpenAICacheReadTokens
} = require('../../utils/requestDetailHelper')
const {
  IMAGE_GENERATION_MODEL,
  detectOpenAIImageGeneration,
  getModelForUsageRecord
} = require('../../utils/openaiImageGenerationDetector')

const IMAGE_GENERATION_FLAT_PRICE_USD = 0.04

// lastUsedAt 更新节流（每账户 60 秒内最多更新一次，使用 LRU 防止内存泄漏）
const lastUsedAtThrottle = new LRUCache(1000) // 最多缓存 1000 个账户
const LAST_USED_AT_THROTTLE_MS = 60000

// 抽取缓存写入 token，兼容多种字段命名
function extractCacheCreationTokens(usageData) {
  if (!usageData || typeof usageData !== 'object') {
    return 0
  }

  const details = usageData.input_tokens_details || usageData.prompt_tokens_details || {}
  const candidates = [
    details.cache_creation_input_tokens,
    details.cache_creation_tokens,
    usageData.cache_creation_input_tokens,
    usageData.cache_creation_tokens
  ]

  for (const value of candidates) {
    if (value !== undefined && value !== null && value !== '') {
      const parsed = Number(value)
      if (!Number.isNaN(parsed)) {
        return parsed
      }
    }
  }

  return 0
}

function buildImageUsagePayload(usageData = {}) {
  if (!usageData || typeof usageData !== 'object') {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    }
  }

  const toNumber = (value) => {
    if (value === undefined || value === null || value === '') {
      return 0
    }
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      return 0
    }
    return Math.max(0, parsed)
  }

  const inputTokens = toNumber(
    usageData.input_tokens ??
      usageData.prompt_tokens ??
      usageData.inputTokens ??
      usageData.total_input_tokens
  )
  const totalTokens = toNumber(usageData.total_tokens ?? usageData.totalTokens)

  let outputTokens = toNumber(
    usageData.output_tokens ?? usageData.completion_tokens ?? usageData.outputTokens
  )
  if (outputTokens === 0 && totalTokens > 0 && inputTokens >= 0) {
    outputTokens = Math.max(0, totalTokens - inputTokens)
  }

  const cacheReadTokens = toNumber(
    usageData.cache_read_input_tokens ??
      usageData.cacheReadTokens ??
      usageData.input_tokens_details?.cached_tokens
  )

  const ephemeral5m = toNumber(
    usageData.cache_creation?.ephemeral_5m_input_tokens ?? usageData.ephemeral_5m_input_tokens
  )
  const ephemeral1h = toNumber(
    usageData.cache_creation?.ephemeral_1h_input_tokens ?? usageData.ephemeral_1h_input_tokens
  )

  let cacheCreateTokens = toNumber(
    usageData.cache_creation_input_tokens ?? usageData.cacheCreateTokens ?? usageData.cache_tokens
  )
  if (cacheCreateTokens === 0 && (ephemeral5m > 0 || ephemeral1h > 0)) {
    cacheCreateTokens = ephemeral5m + ephemeral1h
  }

  const normalized = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreateTokens,
    cache_read_input_tokens: cacheReadTokens
  }

  if (ephemeral5m > 0 || ephemeral1h > 0) {
    normalized.cache_creation = {
      ephemeral_5m_input_tokens: ephemeral5m,
      ephemeral_1h_input_tokens: ephemeral1h
    }
  }

  return normalized
}

function resolveGeneratedImageCount(req, responseData = null) {
  const responseCandidates = [
    Array.isArray(responseData?.data) ? responseData.data.length : null,
    Array.isArray(responseData?.images) ? responseData.images.length : null,
    Array.isArray(responseData?.output)
      ? responseData.output.filter((item) => item?.type === 'image_generation_call').length
      : null
  ]

  for (const candidate of responseCandidates) {
    const parsed = Number(candidate)
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.trunc(parsed)
    }
  }

  const requestCount = Number(req?.body?.n)
  if (Number.isFinite(requestCount) && requestCount > 0) {
    return Math.trunc(requestCount)
  }

  return 1
}

class OpenAIResponsesRelayService {
  constructor() {
    this.defaultTimeout = config.requestTimeout || 600000
  }

  // 节流更新 lastUsedAt
  async _throttledUpdateLastUsedAt(accountId) {
    const now = Date.now()
    const lastUpdate = lastUsedAtThrottle.get(accountId)

    if (lastUpdate && now - lastUpdate < LAST_USED_AT_THROTTLE_MS) {
      return // 跳过更新
    }

    lastUsedAtThrottle.set(accountId, now, LAST_USED_AT_THROTTLE_MS)
    await openaiResponsesAccountService.updateAccount(accountId, {
      lastUsedAt: new Date().toISOString()
    })
  }

  _getImageSessionHash(req) {
    const sessionId =
      req.headers['session_id'] ||
      req.headers['x-session-id'] ||
      req.body?.session_id ||
      req.body?.user ||
      null
    return sessionId ? crypto.createHash('sha256').update(sessionId).digest('hex') : null
  }

  _normalizeTargetPathForBaseApi(req, baseApi = '') {
    let targetPath = req.path
    if (baseApi.endsWith('/v1') && targetPath.startsWith('/v1/')) {
      targetPath = targetPath.slice(3)
    }
    return targetPath
  }

  _createImageUpstreamError(status, payload, message = 'Image generation upstream request failed') {
    const error = new Error(payload?.error?.message || payload?.message || message)
    error.statusCode = status
    error.response = { status, data: payload }
    error.isImageUpstreamError = true
    return error
  }

  _buildOpenAITargetUrl(baseApi = '', targetPath = '') {
    const normalizedBaseApi = String(baseApi || '').replace(/\/+$/, '')
    const normalizedTargetPath = targetPath.startsWith('/') ? targetPath : `/${targetPath}`

    if (!normalizedBaseApi) {
      return normalizedTargetPath
    }

    if (normalizedBaseApi.endsWith('/v1') && normalizedTargetPath.startsWith('/v1/')) {
      return `${normalizedBaseApi}${normalizedTargetPath.slice(3)}`
    }

    return `${normalizedBaseApi}${normalizedTargetPath}`
  }

  async checkImageUpstreamHealth(account, options = {}) {
    const timeoutMs = Math.max(1, parseInt(options.timeoutMs, 10) || 5000)
    const fullAccount =
      account?.apiKey && account?.baseApi
        ? account
        : await openaiResponsesAccountService.getAccount(account?.id)

    if (!fullAccount?.baseApi || !fullAccount?.apiKey) {
      return {
        healthy: false,
        status: null,
        latencyMs: 0,
        reason: 'missing_base_api_or_api_key'
      }
    }

    const healthUrl = this._buildOpenAITargetUrl(fullAccount.baseApi, '/v1/models')
    const requestOptions = {
      method: 'GET',
      url: healthUrl,
      headers: {
        Authorization: `Bearer ${fullAccount.apiKey}`,
        'User-Agent': fullAccount.userAgent || 'crs-image-healthcheck/1.0'
      },
      timeout: timeoutMs,
      validateStatus: () => true
    }

    if (fullAccount.proxy) {
      const proxyAgent = ProxyHelper.createProxyAgent(fullAccount.proxy)
      if (proxyAgent) {
        requestOptions.httpAgent = proxyAgent
        requestOptions.httpsAgent = proxyAgent
        requestOptions.proxy = false
      }
    }

    const startedAt = Date.now()

    try {
      const response = await axios(requestOptions)
      const latencyMs = Date.now() - startedAt
      const healthy = response.status >= 200 && response.status < 300

      if (healthy) {
        logger.info('[image] Upstream health check passed', {
          accountId: fullAccount.id,
          accountName: fullAccount.name,
          status: response.status,
          latencyMs
        })
      } else {
        logger.warn('[image] Upstream health check failed', {
          accountId: fullAccount.id,
          accountName: fullAccount.name,
          status: response.status,
          latencyMs
        })
      }

      return {
        healthy,
        status: response.status,
        latencyMs,
        account: fullAccount
      }
    } catch (error) {
      const latencyMs = Date.now() - startedAt
      logger.warn('[image] Upstream health check exception', {
        accountId: fullAccount.id,
        accountName: fullAccount.name,
        latencyMs,
        code: error.code,
        message: error.message
      })

      return {
        healthy: false,
        status: null,
        latencyMs,
        code: error.code || null,
        reason: error.message || 'health_check_failed',
        account: fullAccount
      }
    }
  }

  async handleImageGenerationRequest(req, res, account, apiKeyData, options = {}) {
    let abortController = null
    let handleClientDisconnect = null
    let clientDisconnected = false
    const sessionHash = this._getImageSessionHash(req)
    const throwOnUpstreamError = options.throwOnUpstreamError === true

    try {
      const fullAccount = await openaiResponsesAccountService.getAccount(account.id)
      if (!fullAccount) {
        throw new Error('Account not found')
      }

      abortController = new AbortController()
      handleClientDisconnect = () => {
        clientDisconnected = true
        logger.info('🔌 Client disconnected, aborting OpenAI image generation request')
        if (abortController && !abortController.signal.aborted) {
          abortController.abort()
        }
      }
      req.once('aborted', handleClientDisconnect)
      res.once('close', () => {
        if (!res.writableEnded) {
          handleClientDisconnect()
        }
      })

      const baseApi = fullAccount.baseApi || ''
      const targetPath = this._normalizeTargetPathForBaseApi(req, baseApi)
      const targetUrl = `${baseApi}${targetPath}`

      const headers = {
        ...filterForOpenAI(req.headers),
        Authorization: `Bearer ${fullAccount.apiKey}`,
        'Content-Type': 'application/json'
      }
      if (fullAccount.userAgent) {
        headers['User-Agent'] = fullAccount.userAgent
      } else if (req.headers['user-agent']) {
        headers['User-Agent'] = req.headers['user-agent']
      }

      const isStream = req.body?.stream === true
      const requestOptions = {
        method: req.method,
        url: targetUrl,
        headers,
        data: req.body,
        timeout: this.defaultTimeout,
        responseType: isStream ? 'stream' : 'json',
        validateStatus: () => true,
        signal: abortController.signal
      }

      if (fullAccount.proxy) {
        const proxyAgent = ProxyHelper.createProxyAgent(fullAccount.proxy)
        if (proxyAgent) {
          requestOptions.httpAgent = proxyAgent
          requestOptions.httpsAgent = proxyAgent
          requestOptions.proxy = false
          logger.info(
            `🌐 Using proxy for OpenAI image generation: ${ProxyHelper.getProxyDescription(fullAccount.proxy)}`
          )
        }
      }

      logger.info('[image] OpenAI image generation relay request', {
        accountId: account.id,
        accountName: account.name,
        targetUrl,
        model: req.body?.model || IMAGE_GENERATION_MODEL,
        stream: isStream
      })

      const response = await axios(requestOptions)

      if (response.status === 429) {
        const { resetsInSeconds, errorData } = await this._handle429Error(
          account,
          response,
          isStream,
          sessionHash
        )
        const oaiAutoProtectionDisabled =
          account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
        if (!oaiAutoProtectionDisabled) {
          await upstreamErrorHelper
            .markTempUnavailable(
              account.id,
              'openai-responses',
              429,
              resetsInSeconds || upstreamErrorHelper.parseRetryAfter(response.headers)
            )
            .catch(() => {})
        }
        if (throwOnUpstreamError) {
          throw this._createImageUpstreamError(
            429,
            errorData || {
              error: {
                message: 'Rate limit exceeded',
                type: 'rate_limit_error',
                code: 'rate_limit_exceeded'
              }
            }
          )
        }
        return res.status(429).json(
          errorData || {
            error: {
              message: 'Rate limit exceeded',
              type: 'rate_limit_error',
              code: 'rate_limit_exceeded'
            }
          }
        )
      }

      if (response.status >= 400) {
        const errorData = await this._readImageErrorData(response)
        await this._markImageAccountOnError(account, response.status, sessionHash)
        req.removeListener('aborted', handleClientDisconnect)
        if (throwOnUpstreamError) {
          throw this._createImageUpstreamError(response.status, errorData)
        }
        return res
          .status(response.status)
          .json(upstreamErrorHelper.sanitizeErrorForClient(errorData))
      }

      await this._throttledUpdateLastUsedAt(account.id)

      if (isStream && response.data && typeof response.data.pipe === 'function') {
        return this._handleImageStreamResponse(
          response,
          res,
          account,
          apiKeyData,
          req,
          handleClientDisconnect
        )
      }

      await this._recordImageRequest(apiKeyData, account, req, response.status, response.data)
      req.removeListener('aborted', handleClientDisconnect)
      return res.status(response.status).json(response.data)
    } catch (error) {
      const clientAborted =
        clientDisconnected || req.aborted || (error?.code === 'ERR_CANCELED' && clientDisconnected)

      if (abortController && !abortController.signal.aborted) {
        abortController.abort()
      }
      if (handleClientDisconnect) {
        req.removeListener('aborted', handleClientDisconnect)
      }
      if (clientAborted) {
        logger.info('OpenAI image generation relay aborted by client disconnect', {
          message: error.message,
          code: error.code
        })
      } else {
        logger.error('OpenAI image generation relay error:', {
          message: error.message,
          code: error.code,
          status: error.response?.status
        })
      }

      if (clientAborted) {
        error.statusCode = error.statusCode || 499
        error.isClientAbort = true
        if (throwOnUpstreamError) {
          throw error
        }
        return null
      }

      if (res.headersSent) {
        return res.end()
      }

      const status = error.response?.status || 500
      const errorData = error.response?.data || {
        error: {
          message: error.message || 'Image generation request failed',
          type: 'api_error',
          code: error.code || 'image_generation_failed'
        }
      }
      if (throwOnUpstreamError) {
        if (error.isImageUpstreamError) {
          throw error
        }
        throw this._createImageUpstreamError(status, errorData, error.message)
      }
      return res.status(status).json(upstreamErrorHelper.sanitizeErrorForClient(errorData))
    }
  }

  async _readImageErrorData(response) {
    let errorData = response.data
    if (response.data && typeof response.data.pipe === 'function') {
      const chunks = []
      await new Promise((resolve) => {
        response.data.on('data', (chunk) => chunks.push(chunk))
        response.data.on('end', resolve)
        response.data.on('error', resolve)
        setTimeout(resolve, 5000)
      })
      const fullResponse = Buffer.concat(chunks).toString()
      try {
        errorData = JSON.parse(fullResponse)
      } catch (error) {
        errorData = { error: { message: fullResponse || 'Unknown upstream error' } }
      }
    }
    return errorData
  }

  async _markImageAccountOnError(account, status, sessionHash = null) {
    if (!account?.id || (status !== 401 && status !== 403 && status < 500)) {
      return
    }

    try {
      const oaiAutoProtectionDisabled =
        account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
      if (!oaiAutoProtectionDisabled) {
        await upstreamErrorHelper.markTempUnavailable(account.id, 'openai-responses', status)
      }
      if (sessionHash && typeof unifiedOpenAIScheduler._deleteSessionMapping === 'function') {
        await unifiedOpenAIScheduler._deleteSessionMapping(sessionHash).catch(() => {})
      }
    } catch (markError) {
      logger.warn('Failed to mark OpenAI image account temporarily unavailable:', markError)
    }
  }

  async _handleImageStreamResponse(
    response,
    res,
    account,
    apiKeyData,
    req,
    handleClientDisconnect
  ) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')

    let streamEnded = false
    let buffer = ''
    let streamUsageData = null
    let actualModel = req.body?.model || IMAGE_GENERATION_MODEL

    const parseImageSSE = (rawEvent) => {
      if (!rawEvent || typeof rawEvent !== 'string') {
        return
      }

      const lines = rawEvent.split('\n')
      for (const line of lines) {
        if (!line.startsWith('data:')) {
          continue
        }

        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') {
          continue
        }

        try {
          const eventData = JSON.parse(payload)
          if (eventData?.response?.usage) {
            streamUsageData = eventData.response.usage
          } else if (eventData?.usage) {
            streamUsageData = eventData.usage
          }

          if (eventData?.response?.model) {
            actualModel = eventData.response.model
          } else if (eventData?.model) {
            actualModel = eventData.model
          }
        } catch (_) {
          // 忽略非 JSON data chunk
        }
      }
    }

    response.data.on('data', (chunk) => {
      if (!res.destroyed && !streamEnded) {
        res.write(chunk)
      }

      buffer += chunk.toString()
      if (buffer.includes('\n\n')) {
        const events = buffer.split('\n\n')
        buffer = events.pop() || ''
        events.forEach(parseImageSSE)
      }
    })

    response.data.on('end', async () => {
      streamEnded = true
      if (buffer.trim()) {
        parseImageSSE(buffer)
      }
      await this._recordImageRequest(
        apiKeyData,
        account,
        req,
        res.statusCode,
        streamUsageData ? { model: actualModel, usage: streamUsageData } : null
      )
      req.removeListener('close', handleClientDisconnect)
      res.removeListener('close', handleClientDisconnect)
      if (!res.destroyed) {
        res.end()
      }
    })

    response.data.on('error', (error) => {
      streamEnded = true
      logger.error('OpenAI image stream error:', error)
      req.removeListener('close', handleClientDisconnect)
      res.removeListener('close', handleClientDisconnect)
      if (!res.headersSent) {
        res.status(502).json({ error: { message: 'Upstream image stream error' } })
      } else if (!res.destroyed) {
        res.end()
      }
    })

    const cleanup = () => {
      streamEnded = true
      try {
        response.data?.unpipe?.(res)
        response.data?.destroy?.()
      } catch (_) {
        // ignore cleanup errors
      }
    }
    req.on('close', cleanup)
    req.on('aborted', cleanup)
  }

  async _recordImageRequest(apiKeyData, account, req, statusCode, responseData = null) {
    try {
      const usageData = responseData?.usage || null
      const model = IMAGE_GENERATION_MODEL
      const imageCount = resolveGeneratedImageCount(req, responseData)
      const fixedImageCostUsd = Number((imageCount * IMAGE_GENERATION_FLAT_PRICE_USD).toFixed(6))
      const usagePayload = buildImageUsagePayload(usageData || {})
      if (
        usagePayload.cache_creation_input_tokens <= 0 &&
        usageData &&
        typeof usageData === 'object'
      ) {
        usagePayload.cache_creation_input_tokens = extractCacheCreationTokens(usageData)
      }
      const totalTokens =
        usagePayload.input_tokens +
        usagePayload.output_tokens +
        usagePayload.cache_creation_input_tokens +
        usagePayload.cache_read_input_tokens

      const requestMeta = {
        ...createRequestDetailMeta(req, {
          requestBody: req.body,
          stream: req.body?.stream === true,
          statusCode,
          endpoint: req.originalUrl || req.path
        }),
        fixedCostUsd: fixedImageCostUsd,
        fixedPricingSource: 'image-flat-rate'
      }

      const usageCosts = await apiKeyService.recordUsageWithDetails(
        apiKeyData.id,
        usagePayload,
        model,
        account.id,
        'openai-responses',
        requestMeta
      )
      await openaiResponsesAccountService.updateAccountUsage(account.id, totalTokens)
      if (parseFloat(account?.dailyQuota) > 0 && usageCosts?.realCost > 0) {
        await openaiResponsesAccountService.updateUsageQuota(account.id, usageCosts.realCost)
      }

      logger.info('[image] Recorded OpenAI image generation request', {
        apiKeyId: apiKeyData.id,
        accountId: account.id,
        model,
        statusCode,
        hasUsage: !!usageData,
        imageCount,
        fixedImageCostUsd,
        totalTokens,
        inputTokens: usagePayload.input_tokens,
        outputTokens: usagePayload.output_tokens,
        outputImageTokens: usagePayload.output_image_tokens || 0
      })
    } catch (error) {
      logger.error('Failed to record OpenAI image generation request:', error)
    }
  }

  // 处理请求转发
  async handleRequest(req, res, account, apiKeyData) {
    let abortController = null
    // 获取会话哈希（如果有的话）
    const sessionId = req.headers['session_id'] || req.body?.session_id
    const sessionHash = sessionId
      ? crypto.createHash('sha256').update(sessionId).digest('hex')
      : null

    try {
      // 获取完整的账户信息（包含解密的 API Key）
      const fullAccount = await openaiResponsesAccountService.getAccount(account.id)
      if (!fullAccount) {
        throw new Error('Account not found')
      }

      // 创建 AbortController 用于取消请求
      abortController = new AbortController()

      // 设置客户端断开监听器
      const handleClientDisconnect = () => {
        logger.info('🔌 Client disconnected, aborting OpenAI-Responses request')
        if (abortController && !abortController.signal.aborted) {
          abortController.abort()
        }
      }

      // 监听客户端断开事件
      req.once('close', handleClientDisconnect)
      res.once('close', handleClientDisconnect)

      // 构建目标 URL（根据 providerEndpoint 配置决定端点路径）
      const providerEndpoint = fullAccount.providerEndpoint || 'responses'
      let targetPath = req.path

      // 根据 providerEndpoint 配置归一化路径
      // 注意：unified.js 已将 /v1/chat/completions 的请求体转换为 Responses 格式，
      // 因此这里只需归一化路径即可；反向 responses→completions 需要同时转换请求体，
      // 目前不支持，所以只保留 responses 和 auto 两种模式
      if (
        providerEndpoint === 'responses' &&
        (targetPath === '/v1/chat/completions' || targetPath === '/chat/completions')
      ) {
        const newPath = targetPath.startsWith('/v1') ? '/v1/responses' : '/responses'
        logger.info(`📝 Normalized path (${req.path}) → ${newPath} (providerEndpoint=responses)`)
        targetPath = newPath
      }
      // providerEndpoint === 'auto' 时保持原始路径不变

      // 防止 baseApi 已含 /v1 时路径重复（如 baseApi=http://host/v1 + targetPath=/v1/responses → /v1/v1/responses）
      const baseApi = fullAccount.baseApi || ''
      if (baseApi.endsWith('/v1') && targetPath.startsWith('/v1/')) {
        targetPath = targetPath.slice(3) // '/v1/responses' → '/responses'
      }
      const targetUrl = `${baseApi}${targetPath}`
      logger.info(`🎯 Forwarding to: ${targetUrl}`)

      // 构建请求头 - 使用统一的 headerFilter 移除 CDN headers
      const headers = {
        ...filterForOpenAI(req.headers),
        Authorization: `Bearer ${fullAccount.apiKey}`,
        'Content-Type': 'application/json'
      }

      // 处理 User-Agent
      if (fullAccount.userAgent) {
        // 使用自定义 User-Agent
        headers['User-Agent'] = fullAccount.userAgent
        logger.debug(`📱 Using custom User-Agent: ${fullAccount.userAgent}`)
      } else if (req.headers['user-agent']) {
        // 透传原始 User-Agent
        headers['User-Agent'] = req.headers['user-agent']
        logger.debug(`📱 Forwarding original User-Agent: ${req.headers['user-agent']}`)
      }

      // 配置请求选项
      const requestOptions = {
        method: req.method,
        url: targetUrl,
        headers,
        data: req.body,
        timeout: this.defaultTimeout,
        responseType: req.body?.stream ? 'stream' : 'json',
        validateStatus: () => true, // 允许处理所有状态码
        signal: abortController.signal
      }

      // 配置代理（如果有）
      if (fullAccount.proxy) {
        const proxyAgent = ProxyHelper.createProxyAgent(fullAccount.proxy)
        if (proxyAgent) {
          requestOptions.httpAgent = proxyAgent
          requestOptions.httpsAgent = proxyAgent
          requestOptions.proxy = false
          logger.info(
            `🌐 Using proxy for OpenAI-Responses: ${ProxyHelper.getProxyDescription(fullAccount.proxy)}`
          )
        }
      }

      // 记录请求信息
      logger.info('📤 OpenAI-Responses relay request', {
        accountId: account.id,
        accountName: account.name,
        targetUrl,
        method: req.method,
        stream: req.body?.stream || false,
        model: req.body?.model || 'unknown',
        userAgent: headers['User-Agent'] || 'not set'
      })

      // 发送请求
      const response = await axios(requestOptions)

      // 处理 429 限流错误
      if (response.status === 429) {
        const { resetsInSeconds, errorData } = await this._handle429Error(
          account,
          response,
          req.body?.stream,
          sessionHash
        )

        const oaiAutoProtectionDisabled =
          account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
        if (!oaiAutoProtectionDisabled) {
          await upstreamErrorHelper
            .markTempUnavailable(
              account.id,
              'openai-responses',
              429,
              resetsInSeconds || upstreamErrorHelper.parseRetryAfter(response.headers)
            )
            .catch(() => {})
        }

        // 返回错误响应（使用处理后的数据，避免循环引用）
        const errorResponse = errorData || {
          error: {
            message: 'Rate limit exceeded',
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
            resets_in_seconds: resetsInSeconds
          }
        }
        return res.status(429).json(errorResponse)
      }

      // 处理其他错误状态码
      if (response.status >= 400) {
        // 处理流式错误响应
        let errorData = response.data
        if (response.data && typeof response.data.pipe === 'function') {
          // 流式响应需要先读取内容
          const chunks = []
          await new Promise((resolve) => {
            response.data.on('data', (chunk) => chunks.push(chunk))
            response.data.on('end', resolve)
            response.data.on('error', resolve)
            setTimeout(resolve, 5000) // 超时保护
          })
          const fullResponse = Buffer.concat(chunks).toString()

          // 尝试解析错误响应
          try {
            if (fullResponse.includes('data: ')) {
              // SSE格式
              const lines = fullResponse.split('\n')
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const jsonStr = line.slice(6).trim()
                  if (jsonStr && jsonStr !== '[DONE]') {
                    errorData = JSON.parse(jsonStr)
                    break
                  }
                }
              }
            } else {
              // 普通JSON
              errorData = JSON.parse(fullResponse)
            }
          } catch (e) {
            logger.error('Failed to parse error response:', e)
            errorData = { error: { message: fullResponse || 'Unknown error' } }
          }
        }

        logger.error('OpenAI-Responses API error', {
          status: response.status,
          statusText: response.statusText,
          errorData
        })

        if (response.status === 401) {
          logger.warn(`🚫 OpenAI Responses账号认证失败（401错误）for account ${account?.id}`)

          try {
            // 仅临时暂停，不永久禁用
            const oaiAutoProtectionDisabled =
              account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
            if (!oaiAutoProtectionDisabled) {
              await upstreamErrorHelper
                .markTempUnavailable(account.id, 'openai-responses', 401)
                .catch(() => {})
            }
            if (sessionHash) {
              await unifiedOpenAIScheduler._deleteSessionMapping(sessionHash).catch(() => {})
            }
          } catch (markError) {
            logger.error(
              '❌ Failed to mark OpenAI-Responses account temporarily unavailable after 401:',
              markError
            )
          }

          let unauthorizedResponse = errorData
          if (
            !unauthorizedResponse ||
            typeof unauthorizedResponse !== 'object' ||
            unauthorizedResponse.pipe ||
            Buffer.isBuffer(unauthorizedResponse)
          ) {
            const fallbackMessage =
              typeof errorData === 'string' && errorData.trim() ? errorData.trim() : 'Unauthorized'
            unauthorizedResponse = {
              error: {
                message: fallbackMessage,
                type: 'unauthorized',
                code: 'unauthorized'
              }
            }
          }

          // 清理监听器
          req.removeListener('close', handleClientDisconnect)
          res.removeListener('close', handleClientDisconnect)

          return res.status(401).json(unauthorizedResponse)
        }

        // 处理 5xx 上游错误
        if (response.status >= 500 && account?.id) {
          try {
            const oaiAutoProtectionDisabled =
              account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
            if (!oaiAutoProtectionDisabled) {
              await upstreamErrorHelper.markTempUnavailable(
                account.id,
                'openai-responses',
                response.status
              )
            }
            if (sessionHash) {
              await unifiedOpenAIScheduler._deleteSessionMapping(sessionHash).catch(() => {})
            }
          } catch (markError) {
            logger.warn(
              'Failed to mark OpenAI-Responses account temporarily unavailable:',
              markError
            )
          }
        }

        // 清理监听器
        req.removeListener('close', handleClientDisconnect)
        res.removeListener('close', handleClientDisconnect)

        return res
          .status(response.status)
          .json(upstreamErrorHelper.sanitizeErrorForClient(errorData))
      }

      // 更新最后使用时间（节流）
      await this._throttledUpdateLastUsedAt(account.id)

      // 处理流式响应
      if (req.body?.stream && response.data && typeof response.data.pipe === 'function') {
        return this._handleStreamResponse(
          response,
          res,
          account,
          apiKeyData,
          req.body?.model,
          handleClientDisconnect,
          req
        )
      }

      // 处理非流式响应
      return this._handleNormalResponse(response, res, account, apiKeyData, req.body?.model, req)
    } catch (error) {
      // 清理 AbortController
      if (abortController && !abortController.signal.aborted) {
        abortController.abort()
      }

      // 安全地记录错误，避免循环引用
      const errorInfo = {
        message: error.message,
        code: error.code,
        status: error.response?.status,
        statusText: error.response?.statusText
      }
      logger.error('OpenAI-Responses relay error:', errorInfo)

      // 检查是否是网络错误
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        if (account?.id) {
          const oaiAutoProtectionDisabled =
            account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
          if (!oaiAutoProtectionDisabled) {
            await upstreamErrorHelper
              .markTempUnavailable(account.id, 'openai-responses', 503)
              .catch(() => {})
          }
        }
      }

      // 如果已经发送了响应头，直接结束
      if (res.headersSent) {
        return res.end()
      }

      // 检查是否是axios错误并包含响应
      if (error.response) {
        // 处理axios错误响应
        const status = error.response.status || 500
        let errorData = {
          error: {
            message: error.response.statusText || 'Request failed',
            type: 'api_error',
            code: error.code || 'unknown'
          }
        }

        // 如果响应包含数据，尝试使用它
        if (error.response.data) {
          // 检查是否是流
          if (typeof error.response.data === 'object' && !error.response.data.pipe) {
            errorData = error.response.data
          } else if (typeof error.response.data === 'string') {
            try {
              errorData = JSON.parse(error.response.data)
            } catch (e) {
              errorData.error.message = error.response.data
            }
          }
        }

        if (status === 401) {
          logger.warn(
            `🚫 OpenAI Responses账号认证失败（401错误）for account ${account?.id} (catch handler)`
          )

          try {
            // 仅临时暂停，不永久禁用
            const oaiAutoProtectionDisabled =
              account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
            if (!oaiAutoProtectionDisabled) {
              await upstreamErrorHelper
                .markTempUnavailable(account.id, 'openai-responses', 401)
                .catch(() => {})
            }
            if (sessionHash) {
              await unifiedOpenAIScheduler._deleteSessionMapping(sessionHash).catch(() => {})
            }
          } catch (markError) {
            logger.error(
              '❌ Failed to mark OpenAI-Responses account temporarily unavailable in catch handler:',
              markError
            )
          }

          let unauthorizedResponse = errorData
          if (
            !unauthorizedResponse ||
            typeof unauthorizedResponse !== 'object' ||
            unauthorizedResponse.pipe ||
            Buffer.isBuffer(unauthorizedResponse)
          ) {
            const fallbackMessage =
              typeof errorData === 'string' && errorData.trim() ? errorData.trim() : 'Unauthorized'
            unauthorizedResponse = {
              error: {
                message: fallbackMessage,
                type: 'unauthorized',
                code: 'unauthorized'
              }
            }
          }

          return res.status(401).json(unauthorizedResponse)
        }

        return res.status(status).json(upstreamErrorHelper.sanitizeErrorForClient(errorData))
      }

      // 其他错误
      return res.status(500).json({
        error: {
          message: 'Internal server error',
          type: 'internal_error',
          details: error.message
        }
      })
    }
  }

  // 处理流式响应
  async _handleStreamResponse(
    response,
    res,
    account,
    apiKeyData,
    requestedModel,
    handleClientDisconnect,
    req
  ) {
    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')

    let usageData = null
    let actualModel = null
    let buffer = ''
    let hasImageGeneration = false
    let rateLimitDetected = false
    let rateLimitResetsInSeconds = null
    let streamEnded = false

    // 解析 SSE 事件以捕获 usage 数据和 model
    const parseSSEForUsage = (data) => {
      const lines = data.split('\n')

      for (const line of lines) {
        if (line.startsWith('data:')) {
          try {
            const jsonStr = line.slice(5).trim()
            if (jsonStr === '[DONE]') {
              continue
            }

            const eventData = JSON.parse(jsonStr)
            if (detectOpenAIImageGeneration(eventData)) {
              hasImageGeneration = true
            }

            // 检查是否是 response.completed 事件（OpenAI-Responses 格式）
            if (eventData.type === 'response.completed' && eventData.response) {
              // 从响应中获取真实的 model
              if (eventData.response.model) {
                actualModel = eventData.response.model
                logger.debug(`📊 Captured actual model from response.completed: ${actualModel}`)
              }

              // 获取 usage 数据 - OpenAI-Responses 格式在 response.usage 下
              if (eventData.response.usage) {
                usageData = eventData.response.usage
                logger.info('📊 Successfully captured usage data from OpenAI-Responses:', {
                  input_tokens: usageData.input_tokens,
                  output_tokens: usageData.output_tokens,
                  total_tokens: usageData.total_tokens
                })
              }
            }

            // 检查是否有限流错误
            if (eventData.error) {
              // 检查多种可能的限流错误类型
              if (
                eventData.error.type === 'rate_limit_error' ||
                eventData.error.type === 'usage_limit_reached' ||
                eventData.error.type === 'rate_limit_exceeded'
              ) {
                rateLimitDetected = true
                if (eventData.error.resets_in_seconds) {
                  rateLimitResetsInSeconds = eventData.error.resets_in_seconds
                  logger.warn(
                    `🚫 Rate limit detected in stream, resets in ${rateLimitResetsInSeconds} seconds (${Math.ceil(rateLimitResetsInSeconds / 60)} minutes)`
                  )
                }
              }
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    }

    // 监听数据流
    response.data.on('data', (chunk) => {
      try {
        const chunkStr = chunk.toString()

        // 转发数据给客户端
        if (!res.destroyed && !streamEnded) {
          res.write(chunk)
        }

        // 同时解析数据以捕获 usage 信息
        buffer += chunkStr

        // 处理完整的 SSE 事件
        if (buffer.includes('\n\n')) {
          const events = buffer.split('\n\n')
          buffer = events.pop() || ''

          for (const event of events) {
            if (event.trim()) {
              parseSSEForUsage(event)
            }
          }
        }
      } catch (error) {
        logger.error('Error processing stream chunk:', error)
      }
    })

    response.data.on('end', async () => {
      streamEnded = true

      // 处理剩余的 buffer
      if (buffer.trim()) {
        parseSSEForUsage(buffer)
      }

      // 记录使用统计
      if (usageData) {
        try {
          // OpenAI-Responses 使用 input_tokens/output_tokens，标准 OpenAI 使用 prompt_tokens/completion_tokens
          const totalInputTokens = usageData.input_tokens || usageData.prompt_tokens || 0
          const outputTokens = usageData.output_tokens || usageData.completion_tokens || 0

          // 提取缓存相关的 tokens（如果存在）
          const cacheReadTokens = extractOpenAICacheReadTokens(usageData)
          const cacheCreateTokens = extractCacheCreationTokens(usageData)
          // 计算实际输入token（总输入减去缓存部分）
          const actualInputTokens = Math.max(0, totalInputTokens - cacheReadTokens)

          const totalTokens =
            usageData.total_tokens || totalInputTokens + outputTokens + cacheCreateTokens
          const baseModelToRecord = actualModel || requestedModel || 'gpt-4'
          const modelToRecord = hasImageGeneration ? IMAGE_GENERATION_MODEL : baseModelToRecord
          if (hasImageGeneration && modelToRecord !== baseModelToRecord) {
            logger.info('[image] Detected image generation in OpenAI-Responses stream output')
          }

          const serviceTier = req._serviceTier || null
          const requestMeta = createRequestDetailMeta(req, {
            requestBody: req.body,
            stream: true,
            statusCode: res.statusCode
          })
          if (modelToRecord === IMAGE_GENERATION_MODEL) {
            const usagePayload = buildImageUsagePayload(usageData)
            usagePayload.cache_creation_input_tokens = cacheCreateTokens
            await apiKeyService.recordUsageWithDetails(
              apiKeyData.id,
              usagePayload,
              modelToRecord,
              account.id,
              'openai-responses',
              requestMeta
            )
          } else {
            await apiKeyService.recordUsage(
              apiKeyData.id,
              actualInputTokens, // 传递实际输入（不含缓存）
              outputTokens,
              cacheCreateTokens,
              cacheReadTokens,
              modelToRecord,
              account.id,
              'openai-responses',
              serviceTier,
              requestMeta
            )
          }

          logger.info(
            `📊 Recorded usage - Input: ${totalInputTokens}(actual:${actualInputTokens}+cached:${cacheReadTokens}), CacheCreate: ${cacheCreateTokens}, Output: ${outputTokens}, Total: ${totalTokens}, Model: ${modelToRecord}`
          )

          // 更新账户的 token 使用统计
          await openaiResponsesAccountService.updateAccountUsage(account.id, totalTokens)

          // 更新账户使用额度（如果设置了额度限制）
          if (parseFloat(account.dailyQuota) > 0) {
            // 使用CostCalculator正确计算费用（考虑缓存token的不同价格）
            const CostCalculator = require('../../utils/costCalculator')
            const quotaUsage =
              modelToRecord === IMAGE_GENERATION_MODEL
                ? buildImageUsagePayload(usageData)
                : {
                    input_tokens: actualInputTokens, // 实际输入（不含缓存）
                    output_tokens: outputTokens,
                    cache_creation_input_tokens: cacheCreateTokens,
                    cache_read_input_tokens: cacheReadTokens
                  }
            if (modelToRecord === IMAGE_GENERATION_MODEL) {
              quotaUsage.cache_creation_input_tokens = cacheCreateTokens
            }
            const costInfo = CostCalculator.calculateCost(quotaUsage, modelToRecord, serviceTier)
            await openaiResponsesAccountService.updateUsageQuota(account.id, costInfo.costs.total)
          }
        } catch (error) {
          logger.error('Failed to record usage:', error)
        }
      }

      // 如果在流式响应中检测到限流
      if (rateLimitDetected) {
        // 使用统一调度器处理限流（与非流式响应保持一致）
        const sessionId = req.headers['session_id'] || req.body?.session_id
        const sessionHash = sessionId
          ? crypto.createHash('sha256').update(sessionId).digest('hex')
          : null

        await unifiedOpenAIScheduler.markAccountRateLimited(
          account.id,
          'openai-responses',
          sessionHash,
          rateLimitResetsInSeconds
        )

        logger.warn(
          `🚫 Processing rate limit for OpenAI-Responses account ${account.id} from stream`
        )
      }

      // 清理监听器
      req.removeListener('close', handleClientDisconnect)
      res.removeListener('close', handleClientDisconnect)

      if (!res.destroyed) {
        res.end()
      }

      logger.info('Stream response completed', {
        accountId: account.id,
        hasUsage: !!usageData,
        actualModel: actualModel || 'unknown'
      })
    })

    response.data.on('error', (error) => {
      streamEnded = true
      logger.error('Stream error:', error)

      // 清理监听器
      req.removeListener('close', handleClientDisconnect)
      res.removeListener('close', handleClientDisconnect)

      if (!res.headersSent) {
        res.status(502).json({ error: { message: 'Upstream stream error' } })
      } else if (!res.destroyed) {
        res.end()
      }
    })

    // 处理客户端断开连接
    const cleanup = () => {
      streamEnded = true
      try {
        response.data?.unpipe?.(res)
        response.data?.destroy?.()
      } catch (_) {
        // 忽略清理错误
      }
    }

    req.on('close', cleanup)
    req.on('aborted', cleanup)
  }

  // 处理非流式响应
  async _handleNormalResponse(response, res, account, apiKeyData, requestedModel, req) {
    const responseData = response.data

    // 提取 usage 数据和实际 model
    // 支持两种格式：直接的 usage 或嵌套在 response 中的 usage
    const usageData = responseData?.usage || responseData?.response?.usage
    const actualModel =
      responseData?.model || responseData?.response?.model || requestedModel || 'gpt-4'
    const modelToRecord = getModelForUsageRecord(actualModel, responseData)
    if (modelToRecord === IMAGE_GENERATION_MODEL && modelToRecord !== actualModel) {
      logger.info('[image] Detected image generation in OpenAI-Responses non-stream output')
    }

    // 记录使用统计
    if (usageData) {
      try {
        // OpenAI-Responses 使用 input_tokens/output_tokens，标准 OpenAI 使用 prompt_tokens/completion_tokens
        const totalInputTokens = usageData.input_tokens || usageData.prompt_tokens || 0
        const outputTokens = usageData.output_tokens || usageData.completion_tokens || 0

        // 提取缓存相关的 tokens（如果存在）
        const cacheReadTokens = extractOpenAICacheReadTokens(usageData)
        const cacheCreateTokens = extractCacheCreationTokens(usageData)
        // 计算实际输入token（总输入减去缓存部分）
        const actualInputTokens = Math.max(0, totalInputTokens - cacheReadTokens)

        const totalTokens =
          usageData.total_tokens || totalInputTokens + outputTokens + cacheCreateTokens

        const serviceTier = req._serviceTier || null
        const requestMeta = createRequestDetailMeta(req, {
          requestBody: req?.body,
          stream: false,
          statusCode: response.status
        })
        if (modelToRecord === IMAGE_GENERATION_MODEL) {
          const usagePayload = buildImageUsagePayload(usageData)
          usagePayload.cache_creation_input_tokens = cacheCreateTokens
          await apiKeyService.recordUsageWithDetails(
            apiKeyData.id,
            usagePayload,
            modelToRecord,
            account.id,
            'openai-responses',
            requestMeta
          )
        } else {
          await apiKeyService.recordUsage(
            apiKeyData.id,
            actualInputTokens, // 传递实际输入（不含缓存）
            outputTokens,
            cacheCreateTokens,
            cacheReadTokens,
            modelToRecord,
            account.id,
            'openai-responses',
            serviceTier,
            requestMeta
          )
        }

        logger.info(
          `📊 Recorded non-stream usage - Input: ${totalInputTokens}(actual:${actualInputTokens}+cached:${cacheReadTokens}), CacheCreate: ${cacheCreateTokens}, Output: ${outputTokens}, Total: ${totalTokens}, Model: ${modelToRecord}`
        )

        // 更新账户的 token 使用统计
        await openaiResponsesAccountService.updateAccountUsage(account.id, totalTokens)

        // 更新账户使用额度（如果设置了额度限制）
        if (parseFloat(account.dailyQuota) > 0) {
          // 使用CostCalculator正确计算费用（考虑缓存token的不同价格）
          const CostCalculator = require('../../utils/costCalculator')
          const quotaUsage =
            modelToRecord === IMAGE_GENERATION_MODEL
              ? buildImageUsagePayload(usageData)
              : {
                  input_tokens: actualInputTokens, // 实际输入（不含缓存）
                  output_tokens: outputTokens,
                  cache_creation_input_tokens: cacheCreateTokens,
                  cache_read_input_tokens: cacheReadTokens
                }
          if (modelToRecord === IMAGE_GENERATION_MODEL) {
            quotaUsage.cache_creation_input_tokens = cacheCreateTokens
          }
          const costInfo = CostCalculator.calculateCost(quotaUsage, modelToRecord, serviceTier)
          await openaiResponsesAccountService.updateUsageQuota(account.id, costInfo.costs.total)
        }
      } catch (error) {
        logger.error('Failed to record usage:', error)
      }
    }

    // 返回响应
    res.status(response.status).json(responseData)

    logger.info('Normal response completed', {
      accountId: account.id,
      status: response.status,
      hasUsage: !!usageData,
      model: modelToRecord
    })
  }

  // 处理 429 限流错误
  async _handle429Error(account, response, isStream = false, sessionHash = null) {
    let resetsInSeconds = null
    let errorData = null

    try {
      // 对于429错误，响应可能是JSON或SSE格式
      if (isStream && response.data && typeof response.data.pipe === 'function') {
        // 流式响应需要先收集数据
        const chunks = []
        await new Promise((resolve, reject) => {
          response.data.on('data', (chunk) => chunks.push(chunk))
          response.data.on('end', resolve)
          response.data.on('error', reject)
          // 设置超时防止无限等待
          setTimeout(resolve, 5000)
        })

        const fullResponse = Buffer.concat(chunks).toString()

        // 尝试解析SSE格式的错误响应
        if (fullResponse.includes('data: ')) {
          const lines = fullResponse.split('\n')
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const jsonStr = line.slice(6).trim()
                if (jsonStr && jsonStr !== '[DONE]') {
                  errorData = JSON.parse(jsonStr)
                  break
                }
              } catch (e) {
                // 继续尝试下一行
              }
            }
          }
        }

        // 如果SSE解析失败，尝试直接解析为JSON
        if (!errorData) {
          try {
            errorData = JSON.parse(fullResponse)
          } catch (e) {
            logger.error('Failed to parse 429 error response:', e)
            logger.debug('Raw response:', fullResponse)
          }
        }
      } else if (response.data && typeof response.data !== 'object') {
        // 如果response.data是字符串，尝试解析为JSON
        try {
          errorData = JSON.parse(response.data)
        } catch (e) {
          logger.error('Failed to parse 429 error response as JSON:', e)
          errorData = { error: { message: response.data } }
        }
      } else if (response.data && typeof response.data === 'object' && !response.data.pipe) {
        // 非流式响应，且是对象，直接使用
        errorData = response.data
      }

      // 从响应体中提取重置时间（OpenAI 标准格式）
      if (errorData && errorData.error) {
        if (errorData.error.resets_in_seconds) {
          resetsInSeconds = errorData.error.resets_in_seconds
          logger.info(
            `🕐 Rate limit will reset in ${resetsInSeconds} seconds (${Math.ceil(resetsInSeconds / 60)} minutes / ${Math.ceil(resetsInSeconds / 3600)} hours)`
          )
        } else if (errorData.error.resets_in) {
          // 某些 API 可能使用不同的字段名
          resetsInSeconds = parseInt(errorData.error.resets_in)
          logger.info(
            `🕐 Rate limit will reset in ${resetsInSeconds} seconds (${Math.ceil(resetsInSeconds / 60)} minutes / ${Math.ceil(resetsInSeconds / 3600)} hours)`
          )
        }
      }

      if (!resetsInSeconds) {
        logger.warn('⚠️ Could not extract reset time from 429 response, using default 60 minutes')
      }
    } catch (e) {
      logger.error('⚠️ Failed to parse rate limit error:', e)
    }

    // 使用统一调度器标记账户为限流状态（与普通OpenAI账号保持一致）
    await unifiedOpenAIScheduler.markAccountRateLimited(
      account.id,
      'openai-responses',
      sessionHash,
      resetsInSeconds
    )

    logger.warn('OpenAI-Responses account rate limited', {
      accountId: account.id,
      accountName: account.name,
      resetsInSeconds: resetsInSeconds || 'unknown',
      resetInMinutes: resetsInSeconds ? Math.ceil(resetsInSeconds / 60) : 60,
      resetInHours: resetsInSeconds ? Math.ceil(resetsInSeconds / 3600) : 1
    })

    // 返回处理后的数据，避免循环引用
    return { resetsInSeconds, errorData }
  }

  // 过滤请求头 - 已迁移到 headerFilter 工具类
  // 此方法保留用于向后兼容，实际使用 filterForOpenAI()
  _filterRequestHeaders(headers) {
    return filterForOpenAI(headers)
  }

  // 估算费用（简化版本，实际应该根据不同的定价模型）
  _estimateCost(model, inputTokens, outputTokens) {
    // 这是一个简化的费用估算，实际应该根据不同的 API 提供商和模型定价
    const rates = {
      'gpt-4': { input: 0.03, output: 0.06 }, // per 1K tokens
      'gpt-4-turbo': { input: 0.01, output: 0.03 },
      'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
      'claude-3-opus': { input: 0.015, output: 0.075 },
      'claude-3-sonnet': { input: 0.003, output: 0.015 },
      'claude-3-haiku': { input: 0.00025, output: 0.00125 }
    }

    // 查找匹配的模型定价
    let rate = rates['gpt-3.5-turbo'] // 默认使用 GPT-3.5 的价格
    for (const [modelKey, modelRate] of Object.entries(rates)) {
      if (model.toLowerCase().includes(modelKey.toLowerCase())) {
        rate = modelRate
        break
      }
    }

    const inputCost = (inputTokens / 1000) * rate.input
    const outputCost = (outputTokens / 1000) * rate.output
    return inputCost + outputCost
  }
}

module.exports = new OpenAIResponsesRelayService()
