'use strict'

// ── State ──────────────────────────────────────────────────────────────────────
let cfg          = {}
let outputDir    = ''
let ytdlpPath    = null
let isBusy       = false
let cancelFlag   = false
let pickedFile   = null

// ── DOM refs ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)

const apiKeyEl      = $('api-key')
const toggleKeyBtn  = $('toggle-key')
const rememberKeyEl = $('remember-key')
const ytUrlEl       = $('yt-url')
const clearUrlBtn   = $('clear-url')
const qualityEl     = $('quality')
const dirLabelEl    = $('dir-label')
const browseDirBtn  = $('browse-dir')
const uploadOnlyEl  = $('upload-only')
const uploadOnlyRow = $('upload-only-row')
const pickFileBtn   = $('pick-file')
const pickedFileEl  = $('picked-file-label')
const goBtn         = $('go-btn')
const cancelBtn     = $('cancel-btn')
const dlFill        = $('dl-fill')
const dlPct         = $('dl-pct')
const upFill        = $('up-fill')
const upPct         = $('up-pct')
const logBox        = $('log-box')
const clearLogBtn   = $('clear-log')
const toast         = $('toast')
const toastUrl      = $('toast-url')
const toastCopy     = $('toast-copy')
const toastClose    = $('toast-close')
const linkFivemanage = $('link-fivemanage')

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  cfg = await window.api.loadConfig()

  if (cfg.apiKey)    apiKeyEl.value = cfg.apiKey
  if (cfg.rememberKey) rememberKeyEl.checked = true
  if (cfg.quality)   qualityEl.value = cfg.quality
  if (cfg.outputDir) {
    outputDir = cfg.outputDir
    dirLabelEl.textContent = shortPath(outputDir)
    dirLabelEl.title = outputDir
  } else {
    outputDir = ''
  }

  log('Ready. Paste a YouTube URL and your FiveManage API key, then click Download & Upload.', 'accent')
}

init()

// ── IPC listeners ──────────────────────────────────────────────────────────────
window.api.onDlProgress(pct => setProgress(dlFill, dlPct, pct))
window.api.onUpProgress(pct => setProgress(upFill, upPct, pct))
window.api.onDlLog(line => {
  if (!line.trim()) return
  // Colour known prefixes
  const isErr = /error|failed|warning/i.test(line)
  log(line, isErr ? 'error' : undefined)
})

// ── Titlebar ───────────────────────────────────────────────────────────────────
$('btn-min').addEventListener('click', () => window.api.minimize())
$('btn-max').addEventListener('click', () => window.api.maximize())
$('btn-cls').addEventListener('click', () => window.api.close())

// ── Key visibility ─────────────────────────────────────────────────────────────
toggleKeyBtn.addEventListener('click', () => {
  const isHidden = apiKeyEl.type === 'password'
  apiKeyEl.type = isHidden ? 'text' : 'password'
  toggleKeyBtn.querySelector('svg').style.opacity = isHidden ? '1' : '.4'
})

// ── FiveManage link ────────────────────────────────────────────────────────────
linkFivemanage.addEventListener('click', e => {
  e.preventDefault()
  window.api.openUrl('https://fivemanage.com/dashboard')
})

// ── Clear URL ──────────────────────────────────────────────────────────────────
clearUrlBtn.addEventListener('click', () => { ytUrlEl.value = ''; ytUrlEl.focus() })

// ── Browse dir ─────────────────────────────────────────────────────────────────
browseDirBtn.addEventListener('click', async () => {
  const dir = await window.api.pickDir()
  if (dir) {
    outputDir = dir
    dirLabelEl.textContent = shortPath(dir)
    dirLabelEl.title = dir
  }
})

// ── Upload-only toggle ─────────────────────────────────────────────────────────
uploadOnlyEl.addEventListener('change', () => {
  const on = uploadOnlyEl.checked
  uploadOnlyRow.style.display = on ? 'flex' : 'none'
  ytUrlEl.disabled = on
  qualityEl.disabled = on
  if (!on) { pickedFile = null; pickedFileEl.textContent = 'No file selected' }
})

pickFileBtn.addEventListener('click', async () => {
  const f = await window.api.pickFile()
  if (f) {
    pickedFile = f
    pickedFileEl.textContent = baseName(f)
  }
})

// ── Clear log ──────────────────────────────────────────────────────────────────
clearLogBtn.addEventListener('click', () => { logBox.innerHTML = '' })

// ── Toast ──────────────────────────────────────────────────────────────────────
toastClose.addEventListener('click', () => { toast.style.display = 'none' })
toastCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(toastUrl.href).then(() => {
    toastCopy.textContent = 'Copied!'
    setTimeout(() => { toastCopy.textContent = 'Copy URL' }, 2000)
  })
})

// ── Go ─────────────────────────────────────────────────────────────────────────
goBtn.addEventListener('click', start)
cancelBtn.addEventListener('click', () => {
  cancelFlag = true
  log('⚠  Cancel requested — will stop after current operation…', 'warning')
})

async function start() {
  const apiKey = apiKeyEl.value.trim()
  if (!apiKey) { alert('Please enter your FiveManage API key.'); return }

  if (uploadOnlyEl.checked) {
    if (!pickedFile) { alert('Please pick a file to upload.'); return }
  } else {
    const url = ytUrlEl.value.trim()
    if (!url) { alert('Please enter a YouTube URL.'); return }
    if (!isValidUrl(url)) { alert('That doesn\'t look like a valid URL.'); return }
  }

  // Persist config
  cfg.quality    = qualityEl.value
  cfg.outputDir  = outputDir || undefined
  if (rememberKeyEl.checked) {
    cfg.apiKey        = apiKey
    cfg.rememberKey   = true
  } else {
    delete cfg.apiKey
    delete cfg.rememberKey
  }
  await window.api.saveConfig(cfg)

  setBusy(true)
  cancelFlag = false
  setProgress(dlFill, dlPct, 0)
  setProgress(upFill, upPct, 0)
  logBox.innerHTML = ''
  toast.style.display = 'none'

  try {
    let filePath

    if (uploadOnlyEl.checked) {
      filePath = pickedFile
      log(`📂  Using file: ${baseName(filePath)}`, 'accent')
      setProgress(dlFill, dlPct, 100)
    } else {
      filePath = await doDownload(apiKey)
      if (!filePath) return
    }

    if (cancelFlag) { log('✕  Cancelled.', 'error'); return }

    const resultUrl = await doUpload(filePath, apiKey)
    if (resultUrl) showSuccess(resultUrl)

  } catch (err) {
    log(`❌  Unexpected error: ${err.message || err}`, 'error')
  } finally {
    setBusy(false)
  }
}

// ── Download flow ──────────────────────────────────────────────────────────────
async function doDownload(apiKey) {
  const url = ytUrlEl.value.trim()

  log(`🔍  Fetching video info…`, 'accent')

  // Ensure yt-dlp binary exists
  if (!ytdlpPath) {
    log('⚙  Downloading yt-dlp binary (first run only)…', 'warning')
    goBtn.innerHTML = '<span class="spinner"></span>Preparing yt-dlp…'
    try {
      ytdlpPath = await window.api.ensureYtdlp()
      log(`✅  yt-dlp ready.`, 'success')
    } catch (e) {
      log(`❌  Failed to get yt-dlp: ${e.message}`, 'error')
      return null
    }
    goBtn.innerHTML = `<svg viewBox="0 0 24 24" class="go-icon"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>Download &amp; Upload to FiveManage`
  }

  if (cancelFlag) return null

  log(`📥  Downloading: ${url}`)
  log(`⚙   Quality: ${qualityEl.value}`)

  const dir = outputDir || (typeof require !== 'undefined'
    ? require('os').homedir() + '/Downloads'
    : '')

  try {
    const filePath = await window.api.download({
      url,
      quality:   qualityEl.value,
      outputDir: dir,
      ytdlpPath,
    })

    if (!filePath) {
      log('❌  Download failed — see log above.', 'error')
      return null
    }

    setProgress(dlFill, dlPct, 100)
    log(`✅  Download complete: ${baseName(filePath)}`, 'success')
    return filePath
  } catch (err) {
    log(`❌  Download error: ${err.message || err}`, 'error')
    return null
  }
}

// ── Upload flow ────────────────────────────────────────────────────────────────
async function doUpload(filePath, apiKey) {
  log(`📤  Uploading to FiveManage…`, 'accent')

  try {
    const resultUrl = await window.api.upload({ filePath, apiKey })
    setProgress(upFill, upPct, 100)
    log(`🎉  Upload complete!`, 'success')
    log(`🔗  ${resultUrl}`, 'success')
    return resultUrl
  } catch (err) {
    const msg = err?.response?.data
      ? JSON.stringify(err.response.data)
      : (err.message || String(err))
    log(`❌  Upload failed: ${msg}`, 'error')
    return null
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function log(text, type) {
  const line = document.createElement('span')
  line.className = 'log-line' + (type ? ` ${type}` : '')
  line.textContent = text
  logBox.appendChild(line)
  logBox.scrollTop = logBox.scrollHeight
}

function setProgress(fill, label, pct) {
  fill.style.width = `${Math.min(pct, 100)}%`
  label.textContent = `${Math.round(pct)}%`
}

function setBusy(on) {
  isBusy = on
  goBtn.disabled    = on
  cancelBtn.disabled = !on
  if (!on) {
    goBtn.innerHTML = `<svg viewBox="0 0 24 24" class="go-icon"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>Download &amp; Upload to FiveManage`
  }
}

function showSuccess(url) {
  toastUrl.href        = url
  toastUrl.textContent = url
  toast.style.display  = 'flex'
}

function shortPath(p) {
  const home = p.startsWith('/home/') || p.startsWith('C:\\Users\\')
  if (!home) return p
  const parts = p.split(/[/\\]/)
  return '~/' + parts.slice(3).join('/')
}

function baseName(p) {
  return p.split(/[/\\]/).pop()
}

function isValidUrl(s) {
  try { new URL(s); return true } catch { return false }
}
