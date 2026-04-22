const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const releaseDir = path.join(rootDir, 'release')
const contextPath = path.join(releaseDir, 'release-context.json')
const releaseBodyPath = path.join(releaseDir, 'release-body.md')

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHAT_IDS = String(process.env.TELEGRAM_CHAT_IDS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
const TELEGRAM_RELEASE_COVER_URL = process.env.TELEGRAM_RELEASE_COVER_URL || ''
const mode = process.env.TELEGRAM_NOTIFY_MODE || 'success'

class TelegramSendError extends Error {
  constructor(message, details) {
    super(message)
    this.name = 'TelegramSendError'
    this.details = details
  }
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function tryParseJson(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function guessFileNameFromUrl(url, contentType) {
  try {
    const pathname = new URL(url).pathname
    const baseName = path.basename(pathname) || 'release-cover'
    if (path.extname(baseName)) {
      return baseName
    }
    if (/png/i.test(contentType || '')) return `${baseName}.png`
    if (/webp/i.test(contentType || '')) return `${baseName}.webp`
    if (/gif/i.test(contentType || '')) return `${baseName}.gif`
    return `${baseName}.jpg`
  } catch {
    if (/png/i.test(contentType || '')) return 'release-cover.png'
    if (/webp/i.test(contentType || '')) return 'release-cover.webp'
    if (/gif/i.test(contentType || '')) return 'release-cover.gif'
    return 'release-cover.jpg'
  }
}

function markdownToPlainSummary(markdown) {
  return String(markdown || '')
    .replace(/^#+\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`>-]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function getContext() {
  if (!fs.existsSync(contextPath)) return null
  return JSON.parse(fs.readFileSync(contextPath, 'utf8'))
}

function getReleaseBody() {
  if (!fs.existsSync(releaseBodyPath)) return ''
  return fs.readFileSync(releaseBodyPath, 'utf8')
}

function buildButtons(version) {
  return {
    inline_keyboard: [
      [
        { text: '🌐 官网', url: 'https://miyu.aiqji.com' },
        { text: '💻 GitHub 仓库', url: 'https://github.com/ILoveBingLu/CipherTalk' }
      ]
    ]
  }
}

function buildSuccessMessage(context, releaseBody) {
  const version = context?.version || process.env.RELEASE_VERSION || 'unknown'
  const blockedVersions = context?.forceUpdate?.blockedVersions || []
  const minimumSupportedVersion = context?.forceUpdate?.minimumSupportedVersion || ''
  const hasForceUpdate = Boolean(minimumSupportedVersion || blockedVersions.length > 0)
  const summary = markdownToPlainSummary(releaseBody)
    .split('\n')
    .filter(Boolean)
    .slice(0, 8)
    .join('\n')

  const thanks = []
  const primaryLogins = new Set(['ILoveBingLu'])
  const primaryNames = new Set(['ILoveBingLu', 'BingLu', 'ILoveBinglu'])
  for (const pr of context?.pullRequests || []) {
    if (pr?.authorLogin && !primaryLogins.has(pr.authorLogin)) {
      thanks.push(`🙏 感谢 @${pr.authorLogin} 提交 PR #${pr.number}`)
    }
  }
  for (const commit of context?.commits || []) {
    const hasPrRef = /#(\d+)/.test(commit.subject || '')
    const authorName = String(commit.authorName || '').trim()
    if (!hasPrRef && authorName && !primaryNames.has(authorName)) {
      thanks.push(`🙏 感谢 ${authorName} 提交改动《${commit.subject}》`)
    }
  }

  const lines = [
    `🚀 <b>CipherTalk v${escapeHtml(version)} 已发布</b>`,
    '',
    '📝 <b>本次更新摘要</b>',
    escapeHtml(summary || '本次版本已完成发布，可点击下方按钮查看完整说明。'),
  ]

  if (hasForceUpdate) {
    lines.push('', '⚠️ <b>强制更新提醒</b>')
    if (minimumSupportedVersion) {
      lines.push(`- 最低安全版本：<code>${escapeHtml(minimumSupportedVersion)}</code>`)
    }
    if (blockedVersions.length) {
      lines.push(`- 封禁版本：<code>${escapeHtml(blockedVersions.join(', '))}</code>`)
    }
  }

  lines.push('', '🔗 <b>相关链接</b>', `- GitHub Release：<a href="https://github.com/ILoveBingLu/CipherTalk/releases/tag/v${encodeURIComponent(version)}">查看发布说明</a>`)

  if (thanks.length) {
    lines.push('', '🌟 <b>感谢贡献者</b>', ...thanks.map((line) => escapeHtml(line)))
  }

  return lines.join('\n')
}

function buildFailureMessage() {
  const workflowUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : ''
  const version = process.env.RELEASE_VERSION || process.env.GITHUB_REF_NAME || 'unknown'
  const lines = [
    `❌ <b>CipherTalk ${escapeHtml(version)} 发布失败</b>`,
    '',
    '请尽快检查 GitHub Actions 日志。'
  ]
  if (workflowUrl) {
    lines.push('', `🔗 <a href="${workflowUrl}">查看失败日志</a>`)
  }
  return lines.join('\n')
}

async function sendTelegramMessage(chatId, text, replyMarkup) {
  const messagePayload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    reply_markup: replyMarkup
  }

  const photoPayload = {
    chat_id: chatId,
    photo: TELEGRAM_RELEASE_COVER_URL,
    caption: text,
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }

  if (!TELEGRAM_RELEASE_COVER_URL) {
    await callTelegramApi('sendMessage', chatId, messagePayload)
    return
  }

  try {
    const formData = await buildPhotoFormData(photoPayload)
    await callTelegramApi('sendPhoto', chatId, formData, { bodyType: 'form' })
  } catch (error) {
    const description = String(error?.details?.description || error?.message || '')
    const shouldFallback =
      !(error instanceof TelegramSendError) ||
      error?.details?.endpoint === 'sendPhoto' ||
      error?.details?.stage === 'download_cover'

    if (!shouldFallback) {
      throw error
    }

    console.warn('⚠️ Telegram 封面图发送失败，改为纯文本发送', {
      chatId,
      coverUrl: TELEGRAM_RELEASE_COVER_URL,
      description
    })

    await callTelegramApi('sendMessage', chatId, messagePayload)
  }
}

async function buildPhotoFormData(photoPayload) {
  const downloadResponse = await fetch(TELEGRAM_RELEASE_COVER_URL, {
    redirect: 'follow'
  })

  const contentType = downloadResponse.headers.get('content-type') || ''

  if (!downloadResponse.ok) {
    const raw = await downloadResponse.text()
    const details = {
      stage: 'download_cover',
      coverUrl: TELEGRAM_RELEASE_COVER_URL,
      status: downloadResponse.status,
      statusText: downloadResponse.statusText,
      description: `封面图下载失败 (${downloadResponse.status})`,
      raw
    }
    console.error('❌ Telegram 封面图下载失败', details)
    throw new TelegramSendError(details.description, details)
  }

  if (!/^image\//i.test(contentType)) {
    const raw = await downloadResponse.text()
    const details = {
      stage: 'download_cover',
      coverUrl: TELEGRAM_RELEASE_COVER_URL,
      status: downloadResponse.status,
      statusText: downloadResponse.statusText,
      description: `封面图 content-type 不是图片: ${contentType || 'unknown'}`,
      raw
    }
    console.error('❌ Telegram 封面图内容类型错误', details)
    throw new TelegramSendError(details.description, details)
  }

  const arrayBuffer = await downloadResponse.arrayBuffer()
  const fileName = guessFileNameFromUrl(TELEGRAM_RELEASE_COVER_URL, contentType)
  const formData = new FormData()

  formData.append('chat_id', photoPayload.chat_id)
  formData.append('photo', new Blob([arrayBuffer], { type: contentType }), fileName)
  formData.append('caption', photoPayload.caption)
  formData.append('parse_mode', photoPayload.parse_mode)
  if (photoPayload.reply_markup) {
    formData.append('reply_markup', JSON.stringify(photoPayload.reply_markup))
  }

  return formData
}

async function callTelegramApi(endpoint, chatId, payload, options = {}) {
  const bodyType = options.bodyType || 'json'
  const requestOptions = {
    method: 'POST',
    body: bodyType === 'form' ? payload : JSON.stringify(payload)
  }

  if (bodyType === 'json') {
    requestOptions.headers = {
      'Content-Type': 'application/json'
    }
  }

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`, requestOptions)

  const raw = await response.text()
  const parsed = tryParseJson(raw)

  if (!response.ok || parsed?.ok === false) {
    const description = parsed?.description || raw
    const errorCode = parsed?.error_code
    const details = {
      endpoint,
      chatId,
      status: response.status,
      statusText: response.statusText,
      description,
      errorCode,
      raw
    }

    console.error('❌ Telegram API 返回错误', details)
    throw new TelegramSendError(
      `Telegram 发送失败 (${response.status}${errorCode ? `/${errorCode}` : ''}): ${description}`,
      details
    )
  }

  return parsed
}

async function main() {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0) {
    console.log('ℹ️ Telegram 未配置，跳过通知')
    return
  }

  const context = getContext()
  const releaseBody = getReleaseBody()
  const version = context?.version || process.env.RELEASE_VERSION || 'unknown'
  const text = mode === 'failure'
    ? buildFailureMessage()
    : buildSuccessMessage(context, releaseBody)
  const replyMarkup = mode === 'failure' ? undefined : buildButtons(version)

  for (const chatId of TELEGRAM_CHAT_IDS) {
    await sendTelegramMessage(chatId, text, replyMarkup)
  }

  console.log(`✅ 已发送 Telegram 通知到 ${TELEGRAM_CHAT_IDS.length} 个目标`)
}

main().catch((error) => {
  console.error('❌ Telegram 通知失败:', error?.message || error)
  if (error?.details) {
    console.error('❌ Telegram 错误详情:', error.details)
  }
  process.exit(1)
})
