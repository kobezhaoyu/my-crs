jest.mock('axios', () => jest.fn())

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn(() => 'none')
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../src/utils/headerFilter', () => ({
  filterForOpenAI: jest.fn((headers) => headers)
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  updateAccount: jest.fn(),
  updateAccountUsage: jest.fn(),
  updateUsageQuota: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  recordUsageWithDetails: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({}))

jest.mock(
  '../config/config',
  () => ({
    requestTimeout: 1000
  }),
  { virtual: true }
)

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn(),
  parseRetryAfter: jest.fn(() => null),
  sanitizeErrorForClient: jest.fn((payload) => payload)
}))

jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn((_req, overrides = {}) => ({
    requestBody: overrides.requestBody,
    stream: overrides.stream === true,
    statusCode: overrides.statusCode ?? 200,
    endpoint: overrides.endpoint || null
  })),
  extractOpenAICacheReadTokens: jest.fn(() => 0),
  buildOpenAIUsageForCost: jest.fn((usage = {}) => ({
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    output_image_tokens: usage.output_image_tokens || 0
  }))
}))

const apiKeyService = require('../src/services/apiKeyService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const openaiResponsesRelayService = require('../src/services/relay/openaiResponsesRelayService')

describe('openaiResponsesRelayService image billing', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    apiKeyService.recordUsageWithDetails.mockResolvedValue({ realCost: 0.04, ratedCost: 0.04 })
    openaiResponsesAccountService.updateAccountUsage.mockResolvedValue()
    openaiResponsesAccountService.updateUsageQuota.mockResolvedValue()
  })

  test('records flat image billing from response image count for FY-like upstreams', async () => {
    apiKeyService.recordUsageWithDetails.mockResolvedValueOnce({
      realCost: 0.08,
      ratedCost: 0.08
    })

    await openaiResponsesRelayService._recordImageRequest(
      { id: 'key-1' },
      { id: 'acct-1', dailyQuota: '10' },
      {
        body: { model: 'gpt-image-2', n: 1, stream: false },
        originalUrl: '/openai/v1/images/generations',
        path: '/v1/images/generations'
      },
      200,
      {
        model: 'gpt-image-2-codex',
        usage: {
          input_tokens: 34,
          output_tokens: 196
        },
        data: [{ b64_json: 'img-1' }, { b64_json: 'img-2' }]
      }
    )

    expect(apiKeyService.recordUsageWithDetails).toHaveBeenCalledWith(
      'key-1',
      {
        input_tokens: 34,
        output_tokens: 196,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      },
      'gpt-image-2',
      'acct-1',
      'openai-responses',
      expect.objectContaining({
        endpoint: '/openai/v1/images/generations',
        statusCode: 200,
        fixedCostUsd: 0.08,
        fixedPricingSource: 'image-flat-rate'
      })
    )
    expect(openaiResponsesAccountService.updateAccountUsage).toHaveBeenCalledWith('acct-1', 230)
    expect(openaiResponsesAccountService.updateUsageQuota).toHaveBeenCalledWith('acct-1', 0.08)
  })

  test('falls back to request n for flat image billing when upstream omits usage and model', async () => {
    apiKeyService.recordUsageWithDetails.mockResolvedValueOnce({
      realCost: 0.12,
      ratedCost: 0.12
    })

    await openaiResponsesRelayService._recordImageRequest(
      { id: 'key-1' },
      { id: 'acct-2', dailyQuota: '10' },
      {
        body: { model: 'gpt-image-2', n: 3, stream: false },
        originalUrl: '/openai/v1/images/generations',
        path: '/v1/images/generations'
      },
      200,
      {}
    )

    expect(apiKeyService.recordUsageWithDetails).toHaveBeenCalledWith(
      'key-1',
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      },
      'gpt-image-2',
      'acct-2',
      'openai-responses',
      expect.objectContaining({
        fixedCostUsd: 0.12,
        fixedPricingSource: 'image-flat-rate'
      })
    )
    expect(openaiResponsesAccountService.updateAccountUsage).toHaveBeenCalledWith('acct-2', 0)
    expect(openaiResponsesAccountService.updateUsageQuota).toHaveBeenCalledWith('acct-2', 0.12)
  })
})
