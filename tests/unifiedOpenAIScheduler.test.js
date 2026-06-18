jest.mock('../src/services/account/openaiAccountService', () => ({
  getAllAccounts: jest.fn(() => []),
  recordUsage: jest.fn(),
  setAccountRateLimited: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAllAccounts: jest.fn(),
  getAccount: jest.fn(),
  markAccountRateLimited: jest.fn(),
  updateAccount: jest.fn(),
  isSubscriptionExpired: jest.fn(() => false),
  recordUsage: jest.fn()
}))

jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn()
}))
jest.mock('../src/utils/commonHelper', () => ({
  isSchedulable: jest.fn((value) => value !== false && value !== 'false'),
  sortAccountsByPriority: jest.fn((accounts) => accounts)
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  isTempUnavailable: jest.fn(() => false)
}))

const openaiAccountService = require('../src/services/account/openaiAccountService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const commonHelper = require('../src/utils/commonHelper')
const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')

describe('UnifiedOpenAIScheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    openaiAccountService.getAllAccounts.mockResolvedValue([])
    openaiResponsesAccountService.getAllAccounts.mockResolvedValue([])
    openaiResponsesAccountService.isSubscriptionExpired.mockReturnValue(false)
  })

  describe('markAccountRateLimited', () => {
    it('does not disable scheduling again when OpenAI-Responses auto protection is disabled', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'account-1',
        disableAutoProtection: 'true'
      })

      await unifiedOpenAIScheduler.markAccountRateLimited(
        'account-1',
        'openai-responses',
        null,
        120
      )

      expect(openaiResponsesAccountService.markAccountRateLimited).toHaveBeenCalledWith(
        'account-1',
        2
      )
      expect(openaiResponsesAccountService.updateAccount).not.toHaveBeenCalled()
    })

    it('keeps disabling scheduling for protected OpenAI-Responses accounts', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'account-1',
        disableAutoProtection: 'false'
      })

      await unifiedOpenAIScheduler.markAccountRateLimited(
        'account-1',
        'openai-responses',
        null,
        120
      )

      expect(openaiResponsesAccountService.updateAccount).toHaveBeenCalledWith(
        'account-1',
        expect.objectContaining({
          schedulable: 'false'
        })
      )
    })
  })

  describe('selectOpenAIResponsesAccountForApiKey', () => {
    it('skips Codex-only Responses accounts for image generation', async () => {
      openaiResponsesAccountService.getAllAccounts.mockResolvedValue([
        {
          id: 'codex-only',
          name: 'crs-codex',
          baseApi: 'https://nexus.example.com/api/codex/codex',
          isActive: true,
          status: 'active',
          accountType: 'shared',
          schedulable: true,
          priority: 10,
          lastUsedAt: '2026-06-06T00:00:00.000Z'
        },
        {
          id: 'images-ok',
          name: 'images-compatible',
          baseApi: 'https://aiplus.example.com',
          isActive: true,
          status: 'active',
          accountType: 'shared',
          schedulable: true,
          priority: 50,
          lastUsedAt: '2026-06-06T00:00:00.000Z'
        }
      ])

      const selected = await unifiedOpenAIScheduler.selectOpenAIResponsesAccountForApiKey(
        { id: 'key-1', name: 'Key 1' },
        null,
        'gpt-image-2'
      )

      expect(selected).toEqual({
        accountId: 'images-ok',
        accountType: 'openai-responses'
      })
      expect(openaiResponsesAccountService.recordUsage).toHaveBeenCalledWith('images-ok', 0)
    })

    it('allows FY-img but skips ordinary FY accounts for image generation', async () => {
      openaiResponsesAccountService.getAllAccounts.mockResolvedValue([
        {
          id: 'fy-chat',
          name: 'FY-03',
          baseApi: 'https://api.ferribuy.asia/v1',
          supportedModels: ['gpt-image-2'],
          isActive: true,
          status: 'active',
          accountType: 'shared',
          schedulable: true,
          priority: 10,
          lastUsedAt: '2026-06-06T00:00:00.000Z'
        },
        {
          id: 'fy-img',
          name: 'FY-img-01',
          baseApi: 'https://api.ferribuy.asia/v1',
          supportedModels: ['gpt-image-2'],
          isActive: true,
          status: 'active',
          accountType: 'shared',
          schedulable: true,
          priority: 50,
          lastUsedAt: '2026-06-06T00:00:00.000Z'
        }
      ])

      const selected = await unifiedOpenAIScheduler.selectOpenAIResponsesAccountForApiKey(
        { id: 'key-1', name: 'Key 1' },
        null,
        'gpt-image-2'
      )

      expect(selected).toEqual({
        accountId: 'fy-img',
        accountType: 'openai-responses'
      })
      expect(openaiResponsesAccountService.recordUsage).toHaveBeenCalledWith('fy-img', 0)
    })

    it('allows Dami accounts when they are the only available image upstream', async () => {
      openaiResponsesAccountService.getAllAccounts.mockResolvedValue([
        {
          id: 'dami-1',
          name: 'Dami AI 01',
          baseApi: 'https://aipluspro.xyxw.top/v1',
          supportedModels: ['gpt-image-2'],
          isActive: true,
          status: 'active',
          accountType: 'shared',
          schedulable: true,
          priority: 10,
          lastUsedAt: '2026-06-06T00:00:00.000Z'
        }
      ])

      const selected = await unifiedOpenAIScheduler.selectOpenAIResponsesAccountForApiKey(
        { id: 'key-1', name: 'Key 1' },
        null,
        'gpt-image-2'
      )

      expect(selected).toEqual({
        accountId: 'dami-1',
        accountType: 'openai-responses'
      })
      expect(openaiResponsesAccountService.recordUsage).toHaveBeenCalledWith('dami-1', 0)
    })

    it('uses scheduler priority order between FY-img and Dami image accounts', async () => {
      commonHelper.sortAccountsByPriority.mockImplementationOnce((accounts) =>
        [...accounts].sort((a, b) => (a.priority || 50) - (b.priority || 50))
      )
      openaiResponsesAccountService.getAllAccounts.mockResolvedValue([
        {
          id: 'dami-1',
          name: 'Dami AI 01',
          baseApi: 'https://aipluspro.xyxw.top/v1',
          supportedModels: ['gpt-image-2'],
          isActive: true,
          status: 'active',
          accountType: 'shared',
          schedulable: true,
          priority: 1,
          lastUsedAt: '2026-06-06T00:00:00.000Z'
        },
        {
          id: 'fy-img',
          name: 'FY-img-01',
          baseApi: 'https://api.ferribuy.asia/v1',
          supportedModels: ['gpt-image-2'],
          isActive: true,
          status: 'active',
          accountType: 'shared',
          schedulable: true,
          priority: 50,
          lastUsedAt: '2026-06-06T00:00:00.000Z'
        }
      ])

      const selected = await unifiedOpenAIScheduler.selectOpenAIResponsesAccountForApiKey(
        { id: 'key-1', name: 'Key 1' },
        null,
        'gpt-image-2'
      )

      expect(selected).toEqual({
        accountId: 'dami-1',
        accountType: 'openai-responses'
      })
    })

    it('still allows FY-img to win when it has the higher scheduler priority', async () => {
      commonHelper.sortAccountsByPriority.mockImplementationOnce((accounts) =>
        [...accounts].sort((a, b) => (a.priority || 50) - (b.priority || 50))
      )
      openaiResponsesAccountService.getAllAccounts.mockResolvedValue([
        {
          id: 'dami-1',
          name: 'Dami AI 01',
          baseApi: 'https://aipluspro.xyxw.top/v1',
          supportedModels: ['gpt-image-2'],
          isActive: true,
          status: 'active',
          accountType: 'shared',
          schedulable: true,
          priority: 50,
          lastUsedAt: '2026-06-06T00:00:00.000Z'
        },
        {
          id: 'fy-img',
          name: 'FY-img-01',
          baseApi: 'https://api.ferribuy.asia/v1',
          supportedModels: ['gpt-image-2'],
          isActive: true,
          status: 'active',
          accountType: 'shared',
          schedulable: true,
          priority: 1,
          lastUsedAt: '2026-06-06T00:00:00.000Z'
        }
      ])

      const selected = await unifiedOpenAIScheduler.selectOpenAIResponsesAccountForApiKey(
        { id: 'key-1', name: 'Key 1' },
        null,
        'gpt-image-2'
      )

      expect(selected).toEqual({
        accountId: 'fy-img',
        accountType: 'openai-responses'
      })
    })

    it('keeps Codex-only Responses accounts eligible for non-image models', async () => {
      openaiResponsesAccountService.getAllAccounts.mockResolvedValue([
        {
          id: 'codex-only',
          name: 'crs-codex',
          baseApi: 'https://nexus.example.com/api/codex/codex',
          isActive: true,
          status: 'active',
          accountType: 'shared',
          schedulable: true,
          priority: 10,
          lastUsedAt: '2026-06-06T00:00:00.000Z'
        },
        {
          id: 'images-ok',
          name: 'images-compatible',
          baseApi: 'https://aiplus.example.com',
          isActive: true,
          status: 'active',
          accountType: 'shared',
          schedulable: true,
          priority: 50,
          lastUsedAt: '2026-06-06T00:00:00.000Z'
        }
      ])

      const selected = await unifiedOpenAIScheduler.selectOpenAIResponsesAccountForApiKey(
        { id: 'key-1', name: 'Key 1' },
        null,
        'gpt-5.5'
      )

      expect(selected).toEqual({
        accountId: 'codex-only',
        accountType: 'openai-responses'
      })
    })
  })
})
