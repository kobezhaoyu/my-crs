#!/usr/bin/env node

const fs = require('fs')
const os = require('os')
const path = require('path')
const https = require('https')
const http = require('http')

function printHelp() {
  console.log(`Usage: crs-image <prompt> [options]

Generate an image through CRS OpenAI Images API.

Options:
  -o, --output <file>       Output image path (default: ./crs-image-<timestamp>.png)
  -m, --model <model>       Image model (default: gpt-image-2)
  -s, --size <size>         Image size (default: 1024x1024)
  -q, --quality <quality>   Image quality, e.g. low|medium|high (default: high)
  -n, --n <count>           Number of images (default: 1)
      --base-url <url>      CRS OpenAI base URL (default: config/custom provider or env)
      --auth-file <file>    Codex auth file (default: ~/.codex/auth.json)
      --timeout <seconds>   Request timeout seconds (default: 300)
  -h, --help                Show help

Examples:
  crs-image "a tiny red cube on a white desk" --quality high -o cube.png
  npm run image -- "a glass fox in snow" --size 1024x1024 --quality high -o fox.png
`)
}

function parseArgs(argv) {
  const options = {
    model: 'gpt-image-2',
    size: '1024x1024',
    quality: 'high',
    n: 1,
    timeout: 300,
    authFile: path.join(os.homedir(), '.codex', 'auth.json'),
    output: null,
    baseUrl: process.env.CRS_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || null
  }
  const promptParts = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const readValue = (name) => {
      const value = argv[i + 1]
      if (!value || value.startsWith('-')) {
        throw new Error(`${name} requires a value`)
      }
      i += 1
      return value
    }

    if (arg === '-h' || arg === '--help') {
      options.help = true
    } else if (arg === '-o' || arg === '--output') {
      options.output = readValue(arg)
    } else if (arg === '-m' || arg === '--model') {
      options.model = readValue(arg)
    } else if (arg === '-s' || arg === '--size') {
      options.size = readValue(arg)
    } else if (arg === '-q' || arg === '--quality') {
      options.quality = readValue(arg)
    } else if (arg === '-n' || arg === '--n') {
      const parsed = Number.parseInt(readValue(arg), 10)
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error('--n must be a positive integer')
      }
      options.n = parsed
    } else if (arg === '--base-url') {
      options.baseUrl = readValue(arg)
    } else if (arg === '--auth-file') {
      options.authFile = readValue(arg)
    } else if (arg === '--timeout') {
      const parsed = Number.parseInt(readValue(arg), 10)
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error('--timeout must be a positive integer')
      }
      options.timeout = parsed
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    } else {
      promptParts.push(arg)
    }
  }

  options.prompt = promptParts.join(' ').trim()
  return options
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    return null
  }
}

function readApiKey(authFile) {
  const envKey = process.env.CRS_API_KEY || process.env.OPENAI_API_KEY
  if (envKey) {
    return envKey
  }

  const auth = readJsonIfExists(path.resolve(authFile))
  if (!auth?.OPENAI_API_KEY) {
    throw new Error(`No API key found. Set CRS_API_KEY or OPENAI_API_KEY, or check ${authFile}`)
  }
  return auth.OPENAI_API_KEY
}

function readBaseUrl(explicitBaseUrl) {
  if (explicitBaseUrl) {
    return explicitBaseUrl
  }

  const configPath = path.join(os.homedir(), '.codex', 'config.toml')
  try {
    const content = fs.readFileSync(configPath, 'utf8')
    const customSection = content.match(/\[model_providers\.custom\]([\s\S]*?)(?:\n\[|$)/)
    const scope = customSection ? customSection[1] : content
    const match = scope.match(/^\s*base_url\s*=\s*"([^"]+)"/m)
    if (match?.[1]) {
      return match[1]
    }
  } catch (error) {
    // Fall back below.
  }

  return 'https://crs.thinkingflux.com/openai'
}

function buildEndpoint(baseUrl) {
  const normalized = baseUrl.replace(/\/+$/, '')
  if (normalized.endsWith('/images/generations') || normalized.endsWith('/v1/images/generations')) {
    return normalized
  }
  return `${normalized}/images/generations`
}

function requestJson(url, apiKey, payload, timeoutSeconds) {
  const parsed = new URL(url)
  const transport = parsed.protocol === 'http:' ? http : https
  const body = Buffer.from(JSON.stringify(payload), 'utf8')

  return new Promise((resolve, reject) => {
    const req = transport.request(
      parsed,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'User-Agent': 'crs-image-cli/1.0'
        },
        timeout: timeoutSeconds * 1000
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let data = null
          try {
            data = raw ? JSON.parse(raw) : null
          } catch (error) {
            reject(new Error(`Invalid JSON response (${res.statusCode}): ${raw.slice(0, 500)}`))
            return
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            const message = data?.error?.message || data?.message || raw || `HTTP ${res.statusCode}`
            reject(new Error(`Image generation failed (${res.statusCode}): ${message}`))
            return
          }

          resolve({ data, statusCode: res.statusCode })
        })
      }
    )

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${timeoutSeconds}s`))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function defaultOutputPath(index = 0, total = 1) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', 'Z')
  const suffix = total > 1 ? `-${index + 1}` : ''
  return path.resolve(`crs-image-${stamp}${suffix}.png`)
}

function outputPathFor(baseOutput, index, total) {
  if (!baseOutput) {
    return defaultOutputPath(index, total)
  }
  const resolved = path.resolve(baseOutput)
  if (total <= 1) {
    return resolved
  }
  const ext = path.extname(resolved) || '.png'
  const stem = resolved.slice(0, -ext.length)
  return `${stem}-${index + 1}${ext}`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  if (!options.prompt) {
    printHelp()
    throw new Error('Prompt is required')
  }

  const apiKey = readApiKey(options.authFile)
  const endpoint = buildEndpoint(readBaseUrl(options.baseUrl))
  const payload = {
    model: options.model,
    prompt: options.prompt,
    size: options.size,
    quality: options.quality,
    n: options.n
  }

  console.error(
    `Generating ${options.n} image(s) with ${options.model} (${options.quality}, ${options.size})...`
  )
  const startedAt = Date.now()
  const { data, statusCode } = await requestJson(endpoint, apiKey, payload, options.timeout)
  const elapsedMs = Date.now() - startedAt

  const items = Array.isArray(data?.data) ? data.data : []
  if (items.length === 0) {
    throw new Error('Image response did not include data[]')
  }

  const saved = []
  items.forEach((item, index) => {
    if (!item?.b64_json) {
      throw new Error(`Image ${index + 1} did not include b64_json`)
    }
    const filePath = outputPathFor(options.output, index, items.length)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, Buffer.from(item.b64_json, 'base64'))
    saved.push(filePath)
  })

  console.log(`status=${statusCode}`)
  console.log(`elapsed_ms=${elapsedMs}`)
  console.log(`model=${data.model || options.model}`)
  if (data.usage?.total_tokens !== undefined) {
    console.log(`total_tokens=${data.usage.total_tokens}`)
  }
  saved.forEach((filePath) => console.log(`saved=${filePath}`))
}

main().catch((error) => {
  console.error(`error: ${error.message}`)
  process.exitCode = 1
})
