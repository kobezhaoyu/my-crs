const {
  IMAGE_GENERATION_MODEL,
  detectOpenAIImageGeneration,
  getModelForUsageRecord
} = require('../src/utils/openaiImageGenerationDetector')

describe('openaiImageGenerationDetector', () => {
  test('detects image_generation_call output item', () => {
    const payload = {
      type: 'response.output_item.added',
      item: {
        type: 'image_generation_call',
        id: 'ig_123'
      }
    }

    expect(detectOpenAIImageGeneration(payload)).toBe(true)
    expect(getModelForUsageRecord('gpt-5.4-mini-2026-03-17', payload)).toBe(IMAGE_GENERATION_MODEL)
  })

  test('detects gpt-image-2 model nested in response output', () => {
    const payload = {
      type: 'response.completed',
      response: {
        model: 'gpt-5.4-mini-2026-03-17',
        output: [
          {
            type: 'tool_call',
            model: 'gpt-image-2',
            result: { b64_json: 'abc' }
          }
        ]
      }
    }

    expect(detectOpenAIImageGeneration(payload)).toBe(true)
  })

  test('detects generated image data inside response output only', () => {
    const payload = {
      type: 'response.completed',
      response: {
        model: 'gpt-5.5',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_image', image: { b64_json: 'abc' } }]
          }
        ]
      }
    }

    expect(detectOpenAIImageGeneration(payload)).toBe(true)
  })

  test('does not treat available image_generation tool as actual image output', () => {
    const payload = {
      type: 'response.completed',
      response: {
        model: 'gpt-5.5',
        tools: [{ type: 'image_generation' }],
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          total_tokens: 12
        }
      }
    }

    expect(detectOpenAIImageGeneration(payload)).toBe(false)
    expect(getModelForUsageRecord('gpt-5.5', payload)).toBe('gpt-5.5')
  })

  test('does not scan request tool declarations', () => {
    const payload = {
      model: 'gpt-5.5',
      tools: [{ type: 'image_generation' }],
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'write a short note' }]
        }
      ]
    }

    expect(detectOpenAIImageGeneration(payload)).toBe(false)
  })

  test('does not detect normal text responses', () => {
    const payload = {
      type: 'response.completed',
      response: {
        model: 'gpt-5.4-mini-2026-03-17',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }]
      }
    }

    expect(detectOpenAIImageGeneration(payload)).toBe(false)
    expect(getModelForUsageRecord('gpt-5.4-mini-2026-03-17', payload)).toBe(
      'gpt-5.4-mini-2026-03-17'
    )
  })
})
