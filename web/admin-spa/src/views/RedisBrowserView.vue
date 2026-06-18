<template>
  <div class="space-y-4">
    <div class="card p-4 sm:p-6">
      <div class="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h3 class="text-lg font-bold text-gray-900 dark:text-gray-100 sm:text-xl">
            Redis 编辑器
          </h3>
          <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">
            浏览 Redis Key，并在页面中直接修改后保存
          </p>
        </div>
        <div class="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
          当前支持编辑 `string`、`hash`、`list`、`set`、`zset`
        </div>
      </div>

      <div class="grid gap-3 lg:grid-cols-[minmax(0,2fr)_120px_140px]">
        <div>
          <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            搜索模式
          </label>
          <input
            v-model="searchPattern"
            class="form-input w-full dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            placeholder="例如 apikey:* 或 *"
            type="text"
            @keyup.enter="searchKeys(true)"
          />
        </div>
        <div>
          <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">每页</label>
          <select
            v-model.number="searchLimit"
            class="form-input w-full dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
          >
            <option :value="20">20</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select>
        </div>
        <button class="btn btn-primary h-[42px]" :disabled="loadingKeys" @click="searchKeys(true)">
          <i :class="loadingKeys ? 'fas fa-spinner fa-spin mr-2' : 'fas fa-search mr-2'" />
          搜索
        </button>
      </div>
    </div>

    <div class="grid gap-4 xl:grid-cols-[minmax(360px,1fr)_minmax(0,1.3fr)]">
      <div class="card overflow-hidden">
        <div class="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <div class="flex items-center justify-between">
            <div>
              <h4 class="font-semibold text-gray-900 dark:text-gray-100">Key 列表</h4>
              <p class="text-xs text-gray-500 dark:text-gray-400">
                {{ keys.length }} 条结果
              </p>
            </div>
            <button
              v-if="hasMore"
              class="rounded-lg bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
              :disabled="loadingKeys"
              @click="searchKeys(false)"
            >
              更多
            </button>
          </div>
        </div>

        <div v-if="loadingKeys && keys.length === 0" class="p-8 text-center text-gray-500 dark:text-gray-400">
          <i class="fas fa-spinner fa-spin mr-2" />正在读取 Redis...
        </div>

        <div v-else-if="keys.length === 0" class="p-8 text-center text-gray-500 dark:text-gray-400">
          没有找到匹配的 Key
        </div>

        <div v-else class="max-h-[70vh] overflow-y-auto">
          <button
            v-for="item in keys"
            :key="item.key"
            :class="[
              'block w-full border-b border-gray-100 px-4 py-3 text-left transition-colors dark:border-gray-800',
              selectedKey === item.key
                ? 'bg-blue-50 dark:bg-blue-900/20'
                : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
            ]"
            @click="loadKeyDetail(item.key)"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="truncate font-mono text-sm text-gray-900 dark:text-gray-100">
                  {{ item.key }}
                </div>
                <div class="mt-1 flex flex-wrap gap-2 text-xs">
                  <span class="rounded bg-gray-100 px-2 py-0.5 text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                    {{ item.type }}
                  </span>
                  <span class="rounded bg-gray-100 px-2 py-0.5 text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                    size: {{ item.size }}
                  </span>
                  <span class="rounded bg-gray-100 px-2 py-0.5 text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                    ttl: {{ formatTTL(item.ttlSeconds) }}
                  </span>
                </div>
                <div class="mt-2 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">
                  {{ formatPreview(item.preview) }}
                </div>
              </div>
            </div>
          </button>
        </div>
      </div>

      <div class="card p-4 sm:p-6">
        <div v-if="loadingDetail" class="py-12 text-center text-gray-500 dark:text-gray-400">
          <i class="fas fa-spinner fa-spin mr-2" />正在读取详情...
        </div>

        <div v-else-if="!detail" class="py-12 text-center text-gray-500 dark:text-gray-400">
          从左侧选择一个 Key 查看并编辑
        </div>

        <div v-else class="space-y-4">
          <div class="flex flex-col gap-3 border-b border-gray-200 pb-4 dark:border-gray-700 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0">
              <div class="break-all font-mono text-sm text-gray-900 dark:text-gray-100">
                {{ detail.key }}
              </div>
              <div class="mt-2 flex flex-wrap gap-2 text-xs">
                <span class="rounded bg-blue-100 px-2 py-1 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200">
                  {{ detail.type }}
                </span>
                <span class="rounded bg-gray-100 px-2 py-1 text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                  size: {{ detail.size }}
                </span>
                <span class="rounded bg-gray-100 px-2 py-1 text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                  ttl: {{ formatTTL(detail.ttlSeconds) }}
                </span>
              </div>
            </div>
            <button class="btn btn-success" :disabled="saving || !detail.editable" @click="saveKey">
              <i :class="saving ? 'fas fa-spinner fa-spin mr-2' : 'fas fa-save mr-2'" />
              保存
            </button>
          </div>

          <div v-if="detail.truncated" class="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
            当前值条目较多，页面只展示前 500 项。保存时会覆盖整个 key，请谨慎操作。
          </div>

          <div>
            <label class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              编辑内容
            </label>
            <textarea
              v-model="editorValue"
              class="min-h-[420px] w-full rounded-xl border border-gray-300 bg-gray-950 p-4 font-mono text-sm text-green-100 focus:border-blue-500 focus:outline-none dark:border-gray-700"
              spellcheck="false"
            />
            <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
              `string` 按原始文本保存；其余类型按 JSON 保存。
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import {
  searchRedisKeysApi,
  getRedisKeyDetailApi,
  updateRedisKeyApi
} from '@/utils/http_apis'

const searchPattern = ref('*')
const searchLimit = ref(50)
const loadingKeys = ref(false)
const loadingDetail = ref(false)
const saving = ref(false)
const keys = ref([])
const cursor = ref('0')
const hasMore = ref(false)
const selectedKey = ref('')
const detail = ref(null)
const editorValue = ref('')

const formatTTL = (ttlSeconds) => {
  if (ttlSeconds === -1) return 'persistent'
  if (ttlSeconds === -2) return 'missing'
  return `${ttlSeconds}s`
}

const formatPreview = (preview) => {
  if (preview === null || typeof preview === 'undefined') return ''
  if (typeof preview === 'string') return preview
  try {
    return JSON.stringify(preview)
  } catch (error) {
    return String(preview)
  }
}

const normalizeEditorValue = (data) => {
  if (!data) return ''
  if (data.type === 'string') {
    return data.value || ''
  }
  return JSON.stringify(data.value, null, 2)
}

const searchKeys = async (reset = true) => {
  loadingKeys.value = true
  try {
    const result = await searchRedisKeysApi({
      pattern: searchPattern.value || '*',
      cursor: reset ? '0' : cursor.value,
      limit: searchLimit.value
    })

    if (!result.success) {
      ElMessage.error(result.message || '读取 Redis Key 失败')
      return
    }

    const rows = result.data || []
    keys.value = reset ? rows : [...keys.value, ...rows]
    cursor.value = result.cursor || '0'
    hasMore.value = !!result.hasMore

    if (reset && rows.length > 0) {
      await loadKeyDetail(rows[0].key)
    } else if (reset) {
      selectedKey.value = ''
      detail.value = null
      editorValue.value = ''
    }
  } finally {
    loadingKeys.value = false
  }
}

const loadKeyDetail = async (key) => {
  selectedKey.value = key
  loadingDetail.value = true
  try {
    const result = await getRedisKeyDetailApi(key)
    if (!result.success) {
      ElMessage.error(result.message || '读取 Key 详情失败')
      return
    }

    detail.value = {
      ...result.data,
      editable: ['string', 'hash', 'list', 'set', 'zset'].includes(result.data.type)
    }
    editorValue.value = normalizeEditorValue(result.data)
  } finally {
    loadingDetail.value = false
  }
}

const saveKey = async () => {
  if (!detail.value) return

  saving.value = true
  try {
    const result = await updateRedisKeyApi({
      key: detail.value.key,
      value: editorValue.value
    })

    if (!result.success) {
      ElMessage.error(result.message || '保存失败')
      return
    }

    detail.value = {
      ...result.data,
      editable: ['string', 'hash', 'list', 'set', 'zset'].includes(result.data.type)
    }
    editorValue.value = normalizeEditorValue(result.data)
    ElMessage.success('Redis Key 已保存')
    await searchKeys(true)
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  searchKeys(true)
})
</script>
