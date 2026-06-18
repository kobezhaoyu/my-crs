const IMAGE_GENERATION_MODEL = 'gpt-image-2'

const IMAGE_SIGNAL_KEYS = new Set([
  'image_generation_call',
  'image_generation_result',
  'generated_image',
  'generated_images',
  'b64_json'
])

function isActualImageGenerationType(value) {
  if (typeof value !== 'string') {
    return false
  }

  const normalized = value.toLowerCase()
  return (
    normalized === 'image_generation_call' ||
    normalized === 'image_generation_result' ||
    normalized === 'generated_image' ||
    normalized === 'generated_images'
  )
}

function isGptImageModel(value) {
  return typeof value === 'string' && value.toLowerCase().startsWith('gpt-image-2')
}

function detectOpenAIImageGeneration(payload, options = {}) {
  const maxDepth = options.maxDepth || 10
  const seen = new WeakSet()

  function hasValue(value) {
    return value !== null && value !== undefined && value !== false && value !== ''
  }

  function visitOutput(value, depth = 0, keyName = '') {
    if (value === null || value === undefined || depth > maxDepth) {
      return false
    }

    if (typeof value === 'string') {
      if (keyName === 'model' && isGptImageModel(value)) {
        return true
      }
      if (IMAGE_SIGNAL_KEYS.has(keyName) && value.length > 0) {
        return true
      }
      return false
    }

    if (typeof value !== 'object') {
      return false
    }

    if (seen.has(value)) {
      return false
    }
    seen.add(value)

    if (Array.isArray(value)) {
      return value.some((item) => visitOutput(item, depth + 1, keyName))
    }

    if (isActualImageGenerationType(value.type) || isActualImageGenerationType(value.name)) {
      return true
    }

    if (isGptImageModel(value.model)) {
      return true
    }

    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase()
      if (IMAGE_SIGNAL_KEYS.has(normalizedKey) && hasValue(child)) {
        return true
      }
      if (visitOutput(child, depth + 1, normalizedKey)) {
        return true
      }
    }

    return false
  }

  function isOutputItemEvent(value) {
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') {
      return false
    }
    return value.type.toLowerCase().startsWith('response.output_item.')
  }

  function looksLikeOutputImageItem(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false
    }
    return (
      isActualImageGenerationType(value.type) ||
      isActualImageGenerationType(value.name) ||
      isGptImageModel(value.model) ||
      hasValue(value.b64_json)
    )
  }

  const roots = []
  if (Array.isArray(payload)) {
    roots.push(payload)
  } else if (payload && typeof payload === 'object') {
    if (isOutputItemEvent(payload) && payload.item) {
      roots.push(payload.item)
    }
    if (payload.output) {
      roots.push(payload.output)
    }
    if (payload.response?.output) {
      roots.push(payload.response.output)
    }
    if (payload.data && isGptImageModel(payload.model)) {
      roots.push(payload.data)
    }
    if (looksLikeOutputImageItem(payload)) {
      roots.push(payload)
    }
  }

  return roots.some((root) => visitOutput(root))
}

function getModelForUsageRecord(defaultModel, payload = null, options = {}) {
  if (detectOpenAIImageGeneration(payload, options)) {
    return IMAGE_GENERATION_MODEL
  }
  return defaultModel
}

module.exports = {
  IMAGE_GENERATION_MODEL,
  detectOpenAIImageGeneration,
  getModelForUsageRecord
}
