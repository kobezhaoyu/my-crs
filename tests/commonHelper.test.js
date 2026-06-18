const { normalizeModelName } = require('../src/utils/commonHelper')

describe('commonHelper normalizeModelName', () => {
  test('merges gpt-image-2 upstream variants into canonical model name', () => {
    expect(normalizeModelName('gpt-image-2')).toBe('gpt-image-2')
    expect(normalizeModelName('gpt-image-2-codex')).toBe('gpt-image-2')
    expect(normalizeModelName('gpt-image-2-2026-04-21')).toBe('gpt-image-2')
  })

  test('keeps existing bedrock normalization behavior', () => {
    expect(normalizeModelName('us-east-1.anthropic.claude-sonnet-4-20250514-v1:0')).toBe(
      'claude-sonnet-4-20250514'
    )
  })
})
