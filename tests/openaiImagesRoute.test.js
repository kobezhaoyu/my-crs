const mockRouter = {
  get: jest.fn(),
  post: jest.fn()
}

jest.mock(
  'express',
  () => ({
    Router: () => mockRouter
  }),
  { virtual: true }
)

jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: jest.fn((_req, _res, next) => next())
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  selectOpenAIResponsesAccountForApiKey: jest.fn(),
  selectAccountForApiKey: jest.fn(),
  markAccountRateLimited: jest.fn(),
  isAccountRateLimited: jest.fn().mockResolvedValue(false),
  removeAccountRateLimit: jest.fn(),
  markAccountUnauthorized: jest.fn()
}))

jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  decrypt: jest.fn(),
  isTokenExpired: jest.fn(() => false),
  refreshAccountToken: jest.fn(),
  updateCodexUsageSnapshot: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/relay/openaiResponsesRelayService', () => ({
  handleRequest: jest.fn(),
  handleImageGenerationRequest: jest.fn(),
  checkImageUpstreamHealth: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(() => true),
  recordUsage: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getUsageStats: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  api: jest.fn(),
  security: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn(() => 'none')
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))

jest.mock('../src/utils/sseParser', () => ({
  IncrementalSSEParser: jest.fn().mockImplementation(() => ({
    feed: jest.fn(() => []),
    getRemaining: jest.fn(() => '')
  }))
}))

jest.mock('../src/utils/errorSanitizer', () => ({
  getSafeMessage: jest.fn((error) => error?.message || String(error || 'error'))
}))

jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn(() => null),
  extractOpenAICacheReadTokens: jest.fn(() => 0)
}))

jest.mock(
  '../config/config',
  () => ({
    requestTimeout: 1000,
    imageRelay: {
      upstreamHealthCheckTimeoutMs: 5000,
      totalHealthCheckTimeoutMs: 30000
    }
  }),
  { virtual: true }
)

const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const apiKeyService = require('../src/services/apiKeyService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const openaiResponsesRelayService = require('../src/services/relay/openaiResponsesRelayService')
const openaiRoutes = require('../src/routes/openaiRoutes')

function createReq({ path = '/images/generations', body = {}, permissions = ['openai'] } = {}) {
  return {
    method: 'POST',
    path,
    originalUrl: `/openai${path}`,
    headers: {
      'user-agent': 'image-client/1.0'
    },
    body: JSON.parse(JSON.stringify(body)),
    apiKey: {
      id: 'key_1',
      name: 'Key 1',
      permissions
    }
  }
}

function createRes() {
  const res = {
    statusCode: 200,
    headersSent: false,
    headers: {},
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    }),
    json: jest.fn((payload) => {
      res.payload = payload
      return res
    }),
    setHeader: jest.fn((key, value) => {
      res.headers[key] = value
    })
  }
  return res
}

describe('openai images route', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    unifiedOpenAIScheduler.selectOpenAIResponsesAccountForApiKey.mockResolvedValue({
      accountId: 'resp-1',
      accountType: 'openai-responses'
    })

    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'resp-1',
      name: 'Images Account',
      apiKey: 'sk-images'
    })

    openaiResponsesRelayService.checkImageUpstreamHealth.mockResolvedValue({
      healthy: true,
      status: 200,
      latencyMs: 123
    })
    openaiResponsesRelayService.handleImageGenerationRequest.mockResolvedValue({ ok: true })
    apiKeyService.hasPermission.mockReturnValue(true)
  })

  test('routes image generation through OpenAI-Responses account and strips Codex-only fields', async () => {
    const req = createReq({
      body: {
        model: 'gpt-image-2',
        prompt: 'draw a robot',
        size: '1024x1024',
        service_tier: 'fast',
        reasoning: { effort: 'medium' },
        instructions: 'codex instructions',
        store: false
      }
    })

    await openaiRoutes.handleImageGeneration(req, createRes())

    expect(unifiedOpenAIScheduler.selectOpenAIResponsesAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      null,
      'gpt-image-2',
      []
    )
    expect(req.body).toEqual({
      model: 'gpt-image-2',
      prompt: 'draw a robot',
      size: '1024x1024'
    })
    expect(openaiResponsesRelayService.handleImageGenerationRequest).toHaveBeenCalledWith(
      req,
      expect.any(Object),
      expect.objectContaining({ id: 'resp-1' }),
      req.apiKey,
      { throwOnUpstreamError: true }
    )
    expect(openaiResponsesRelayService.checkImageUpstreamHealth).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'resp-1' }),
      expect.objectContaining({ timeoutMs: 5000 })
    )
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).not.toHaveBeenCalled()
  })

  test('defaults missing image model to gpt-image-2', async () => {
    const req = createReq({ body: { prompt: 'draw a cat' } })

    await openaiRoutes.handleImageGeneration(req, createRes())

    expect(req.body.model).toBe('gpt-image-2')
    expect(unifiedOpenAIScheduler.selectOpenAIResponsesAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      null,
      'gpt-image-2',
      []
    )
  })

  test('retries the next image account when the selected upstream returns 502', async () => {
    const req = createReq({
      body: {
        model: 'gpt-image-2',
        prompt: 'draw a spaceship'
      }
    })

    const excludeSnapshots = []
    unifiedOpenAIScheduler.selectOpenAIResponsesAccountForApiKey.mockImplementation(
      async (_apiKey, _sessionHash, _model, excludeAccountIds) => {
        excludeSnapshots.push([...(excludeAccountIds || [])])
        return excludeSnapshots.length === 1
          ? {
              accountId: 'resp-1',
              accountType: 'openai-responses'
            }
          : {
              accountId: 'resp-2',
              accountType: 'openai-responses'
            }
      }
    )

    openaiResponsesAccountService.getAccount.mockImplementation(async (accountId) => ({
      id: accountId,
      name: accountId === 'resp-1' ? 'Broken Images Account' : 'Healthy Images Account',
      apiKey: `sk-${accountId}`
    }))

    const upstreamError = new Error('origin bad gateway')
    upstreamError.statusCode = 502
    upstreamError.response = {
      status: 502,
      data: {
        error: {
          message: 'origin bad gateway'
        }
      }
    }
    openaiResponsesRelayService.handleImageGenerationRequest
      .mockRejectedValueOnce(upstreamError)
      .mockResolvedValueOnce({ ok: true })

    await openaiRoutes.handleImageGeneration(req, createRes())

    expect(unifiedOpenAIScheduler.selectOpenAIResponsesAccountForApiKey).toHaveBeenCalledTimes(2)
    expect(excludeSnapshots).toEqual([[], ['resp-1']])
    expect(openaiResponsesRelayService.handleImageGenerationRequest).toHaveBeenNthCalledWith(
      2,
      req,
      expect.any(Object),
      expect.objectContaining({ id: 'resp-2' }),
      req.apiKey,
      { throwOnUpstreamError: true }
    )
  })

  test('falls back to the next image account when the first health check fails', async () => {
    const req = createReq({
      body: {
        model: 'gpt-image-2',
        prompt: 'draw a lighthouse'
      }
    })

    const excludeSnapshots = []
    unifiedOpenAIScheduler.selectOpenAIResponsesAccountForApiKey.mockImplementation(
      async (_apiKey, _sessionHash, _model, excludeAccountIds) => {
        excludeSnapshots.push([...(excludeAccountIds || [])])
        return excludeSnapshots.length === 1
          ? {
              accountId: 'resp-1',
              accountType: 'openai-responses'
            }
          : {
              accountId: 'resp-2',
              accountType: 'openai-responses'
            }
      }
    )

    openaiResponsesAccountService.getAccount.mockImplementation(async (accountId) => ({
      id: accountId,
      name: accountId === 'resp-1' ? 'FY-img-01' : '大米ai-01',
      apiKey: `sk-${accountId}`
    }))

    openaiResponsesRelayService.checkImageUpstreamHealth
      .mockResolvedValueOnce({ healthy: false, status: 503, latencyMs: 5000 })
      .mockResolvedValueOnce({ healthy: true, status: 200, latencyMs: 400 })

    await openaiRoutes.handleImageGeneration(req, createRes())

    expect(unifiedOpenAIScheduler.selectOpenAIResponsesAccountForApiKey).toHaveBeenCalledTimes(2)
    expect(excludeSnapshots).toEqual([[], ['resp-1']])
    expect(openaiResponsesRelayService.handleImageGenerationRequest).toHaveBeenCalledTimes(1)
    expect(openaiResponsesRelayService.handleImageGenerationRequest).toHaveBeenCalledWith(
      req,
      expect.any(Object),
      expect.objectContaining({ id: 'resp-2' }),
      req.apiKey,
      { throwOnUpstreamError: true }
    )
  })

  test('does not retry another image account after client cancellation', async () => {
    const req = createReq({
      body: {
        model: 'gpt-image-2',
        prompt: 'draw a spaceship'
      }
    })
    const res = createRes()

    const canceledError = new Error('canceled')
    canceledError.code = 'ERR_CANCELED'
    canceledError.statusCode = 499
    canceledError.isClientAbort = true
    openaiResponsesRelayService.handleImageGenerationRequest.mockRejectedValueOnce(canceledError)

    await openaiRoutes.handleImageGeneration(req, res)

    expect(unifiedOpenAIScheduler.selectOpenAIResponsesAccountForApiKey).toHaveBeenCalledTimes(1)
    expect(openaiResponsesRelayService.handleImageGenerationRequest).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })

  test('returns 500 when the image health-check window is exhausted', async () => {
    const req = createReq({
      body: {
        model: 'gpt-image-2',
        prompt: 'draw a comet'
      }
    })
    const res = createRes()
    const nowSpy = jest.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(0)
    nowSpy.mockReturnValueOnce(1)
    nowSpy.mockReturnValueOnce(2)
    nowSpy.mockReturnValueOnce(30001)

    openaiResponsesRelayService.checkImageUpstreamHealth.mockResolvedValueOnce({
      healthy: false,
      status: 504,
      latencyMs: 5000
    })

    await openaiRoutes.handleImageGeneration(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.payload.error.message).toBe('生图服务异常')
    expect(res.payload.error.code).toBe('image_service_unavailable')
    nowSpy.mockRestore()
  })

  test('rejects API keys without OpenAI permission', async () => {
    apiKeyService.hasPermission.mockReturnValue(false)
    const res = createRes()

    await openaiRoutes.handleImageGeneration(createReq({ permissions: [] }), res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.payload.error.code).toBe('permission_denied')
    expect(openaiResponsesRelayService.handleImageGenerationRequest).not.toHaveBeenCalled()
  })
})
