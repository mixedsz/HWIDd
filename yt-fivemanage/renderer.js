'use strict'

// ── State ──────────────────────────────────────────────────────────────────────
let cfg        = {}
let outputDir  = ''
let ytdlpPath  = null
let mode       = 'download'   // 'download' | 'upload'
let pickedFile = null

// ── DOM refs ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)

const apiKeyEl       = $('api-key')
const cardApi        = $('card-api')
const toggleKeyBtn   = $('toggle-key')
const rememberKeyEl  = $('remember-key')
const ytUrlEl        = $('yt-url')
const qualityEl      = $('quality')
const dirLabelEl     = $('dir-label')
const uploadOnlyEl   = $('upload-only')
const uploadOnlyRow  = $('upload-only-row')
const pickedFileEl   = $('picked-file-label')
const goBtn          = $('go-btn')
const goBtnLabel     = $('go-btn-label')
const cancelBtn      = $('cancel-btn')
const dlFill         = $('dl-fill')
const dlPct          = $('dl-pct')
const upRow          = $('up-row')
const upFill         = $('up-fill')
const upPct          = $('up-pct')
const logBox         = $('log-box')
const toast          = $('toast')
const toastTitle     = $('toast-title')
const toastIcon      = $('toast-icon')
const toastUrl       = $('toast-url')
const toastCopy      = $('toast-copy')

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  cfg = await window.api.loadConfig()

  if (cfg.apiKey)      apiKeyEl.value       = cfg.apiKey
  if (cfg.rememberKey) rememberKeyEl.checked = true
  if (cfg.quality)     qualityEl.value       = cfg.quality
  if (cfg.mode)        setMode(cfg.mode)

  const homeDir    = await window.api.getHomeDir()
  const sep        = homeDir.includes('\\') ? '\\' : '/'
  const defaultDir = homeDir + sep + 'Downloads'

  outputDir = cfg.outputDir || defaultDir
  dirLabelEl.textContent = shortPath(outputDir)
  dirLabelEl.title       = outputDir

  log('Ready — paste a YouTube URL and click the button below.', 'accent')
}

init()

// ── IPC progress/log callbacks ─────────────────────────────────────────────────
window.api.onDlProgress(pct => setProgress(dlFill, dlPct, pct))
window.api.onUpProgress(pct => setProgress(upFill, upPct, pct))
window.api.onDlLog(line => {
  if (!line.trim()) return
  const t = /error|failed/i.test(line) ? 'error' : /warning/i.test(line) ? 'warning' : null
  log(line, t)
})

// ── Mode tabs ──────────────────────────────────────────────────────────────────
document.querySelectorAll('.mode-tab').forEach(btn => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode))
})

function setMode(m) {
  mode = m
  document.querySelectorAll('.mode-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === m)
  })

  const isUpload = m === 'upload'
  cardApi.style.display  = isUpload ? '' : 'none'
  upRow.style.display    = isUpload ? '' : 'none'
  goBtnLabel.textContent = isUpload ? 'Download & Upload to FiveManage' : 'Download MP4'

  // Reset upload-only when switching modes
  uploadOnlyEl.checked         = false
  uploadOnlyRow.style.display  = 'none'
  ytUrlEl.disabled             = false
  qualityEl.disabled           = false
  pickedFile                   = null
  pickedFileEl.textContent     = 'No file selected'
}

// ── Window controls ────────────────────────────────────────────────────────────
$('btn-min').addEventListener('click', () => window.api.minimize())
$('btn-max').addEventListener('click', () => window.api.maximize())
$('btn-cls').addEventListener('click', () => window.api.close())

// ── Misc controls ──────────────────────────────────────────────────────────────
toggleKeyBtn.addEventListener('click', () => {
  const hidden = apiKeyEl.type === 'password'
  apiKeyEl.type = hidden ? 'text' : 'password'
  toggleKeyBtn.querySelector('svg').style.opacity = hidden ? '1' : '.4'
})

$('link-fivemanage').addEventListener('click', e => {
  e.preventDefault()
  window.api.openUrl('https://fivemanage.com/dashboard')
})

$('clear-url').addEventListener('click', () => { ytUrlEl.value = ''; ytUrlEl.focus() })
$('clear-log').addEventListener('click', () => { logBox.innerHTML = '' })

$('browse-dir').addEventListener('click', async () => {
  const dir = await window.api.pickDir()
  if (dir) {
    outputDir = dir
    dirLabelEl.textContent = shortPath(dir)
    dirLabelEl.title       = dir
  }
})

uploadOnlyEl.addEventListener('change', () => {
  const on = uploadOnlyEl.checked
  uploadOnlyRow.style.display = on ? 'flex' : 'none'
  ytUrlEl.disabled   = on
  qualityEl.disabled = on
  if (!on) { pickedFile = null; pickedFileEl.textContent = 'No file selected' }
})

$('pick-file').addEventListener('click', async () => {
  const f = await window.api.pickFile()
  if (f) { pickedFile = f; pickedFileEl.textContent = baseName(f) }
})

// ── Toast ──────────────────────────────────────────────────────────────────────
$('toast-close').addEventListener('click', () => { toast.style.display = 'none' })
toastCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(toastUrl.href).then(() => {
    toastCopy.textContent = 'Copied!'
    setTimeout(() => { toastCopy.textContent = 'Copy URL' }, 2000)
  })
})

// ── Main action ────────────────────────────────────────────────────────────────
$('go-btn').addEventListener('click', run)
$('cancel-btn').addEventListener('click', () => {
  log('⚠  Cancel requested — stopping after current step…', 'warning')
  // Mark for cancel — the process will be killed in the next tick
  window._cancelRequested = true
})

async function run() {
  // Validate
  if (mode === 'upload') {
    const apiKey = apiKeyEl.value.trim()
    if (!apiKey) { alert('Please enter your FiveManage API key.'); return }
  }

  if (uploadOnlyEl.checked) {
    if (!pickedFile) { alert('Please pick a file to upload.'); return }
  } else {
    const url = ytUrlEl.value.trim()
    if (!url)         { alert('Please enter a YouTube URL.'); return }
    if (!isValidUrl(url)) { alert("That doesn't look like a valid URL."); return }
  }

  // Save prefs
  cfg.mode      = mode
  cfg.quality   = qualityEl.value
  cfg.outputDir = outputDir
  if (rememberKeyEl.checked) {
    cfg.apiKey = apiKeyEl.value.trim()
    cfg.rememberKey = true
  } else {
    delete cfg.apiKey
    delete cfg.rememberKey
  }
  await window.api.saveConfig(cfg)

  setBusy(true)
  window._cancelRequested = false
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
      filePath = await doDownload()
      if (!filePath) return
    }

    if (window._cancelRequested) { log('✕  Cancelled.', 'error'); return }

    if (mode === 'upload') {
      const url = await doUpload(filePath)
      if (url) showToast(url)
    } else {
      showToastDownloadDone(filePath)
    }

  } catch (err) {
    log(`❌  ${err.message || err}`, 'error')
  } finally {
    setBusy(false)
  }
}

// ── Download ───────────────────────────────────────────────────────────────────
async function doDownload() {
  const url = ytUrlEl.value.trim()
  log(`📥  Starting download: ${url}`, 'accent')
  log(`⚙   Quality: ${qualityEl.value}  →  ${outputDir}`)

  if (!ytdlpPath) {
    log('⚙  Fetching yt-dlp binary (first run only)…', 'warning')
    goBtn.querySelector('#go-btn-label').textContent = 'Preparing…'
    try {
      ytdlpPath = await window.api.ensureYtdlp()
      log('✅  yt-dlp ready.', 'success')
    } catch (e) {
      log(`❌  Could not download yt-dlp: ${e.message}`, 'error')
      return null
    }
    goBtnLabel.textContent = mode === 'upload'
      ? 'Download & Upload to FiveManage'
      : 'Download MP4'
  }

  if (window._cancelRequested) return null

  try {
    const filePath = await window.api.download({
      url,
      quality:   qualityEl.value,
      outputDir,
      ytdlpPath,
    })

    setProgress(dlFill, dlPct, 100)
    log(`✅  Download complete: ${baseName(filePath)}`, 'success')
    return filePath
  } catch (err) {
    log(`❌  Download failed: ${err.message}`, 'error')
    return null
  }
}

// ── Upload ─────────────────────────────────────────────────────────────────────
async function doUpload(filePath) {
  log(`📤  Uploading ${baseName(filePath)} to FiveManage…`, 'accent')
  try {
    const url = await window.api.upload({ filePath, apiKey: apiKeyEl.value.trim() })
    setProgress(upFill, upPct, 100)
    log(`🎉  Upload complete!`, 'success')
    log(`🔗  ${url}`, 'success')
    return url
  } catch (err) {
    const msg = err?.message || String(err)
    log(`❌  Upload failed: ${msg}`, 'error')
    if (msg.includes('401') || msg.includes('403')) {
      log('    → Check your FiveManage API key and its permissions.', 'warning')
    }
    return null
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function log(text, type) {
  const el = document.createElement('span')
  el.className = 'log-line' + (type ? ` ${type}` : '')
  el.textContent = text
  logBox.appendChild(el)
  logBox.scrollTop = logBox.scrollHeight
}

function setProgress(fill, label, pct) {
  fill.style.width    = `${Math.min(pct, 100)}%`
  label.textContent   = `${Math.round(pct)}%`
}

function setBusy(on) {
  goBtn.disabled     = on
  cancelBtn.disabled = !on
}

function showToast(url) {
  toastIcon.textContent        = '✅'
  toastTitle.textContent       = 'Uploaded to FiveManage!'
  toastUrl.href                = url
  toastUrl.textContent         = url
  toastCopy.style.display      = ''
  toast.style.display          = 'flex'
}

function showToastDownloadDone(filePath) {
  toastIcon.textContent        = '📁'
  toastTitle.textContent       = `Saved: ${baseName(filePath)}`
  toastUrl.href                = '#'
  toastUrl.textContent         = outputDir
  toastCopy.style.display      = 'none'
  toast.style.display          = 'flex'
}

function shortPath(p) {
  const sep  = p.includes('\\') ? '\\' : '/'
  const home = p.startsWith('/home/') || p.match(/^[A-Z]:\\Users\\/i)
  if (!home) return p
  const parts = p.split(/[/\\]/)
  return '~' + sep + parts.slice(3).join(sep)
}

function baseName(p) {
  return p.split(/[/\\]/).pop()
}

function isValidUrl(s) {
  try { new URL(s); return true } catch { return false }
}
