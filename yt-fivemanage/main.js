const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const https = require('https')
const http = require('http')
const { spawn } = require('child_process')
const FormData = require('form-data')
const axios = require('axios')
const YTDlpWrap = require('yt-dlp-wrap').default

const CONFIG_PATH = path.join(os.homedir(), '.ytfivemanage.json')

// ── Config helpers ─────────────────────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { return {} }
}
function saveConfig(data) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2)) } catch {}
}

// ── Window ─────────────────────────────────────────────────────────────────────
let win
function createWindow() {
  win = new BrowserWindow({
    width: 880,
    height: 800,
    minWidth: 700,
    minHeight: 650,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0f0f13',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.loadFile('index.html')
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// ── IPC: window controls ───────────────────────────────────────────────────────
ipcMain.on('win-minimize', () => win.minimize())
ipcMain.on('win-maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize())
ipcMain.on('win-close',    () => win.close())

// ── IPC: config ────────────────────────────────────────────────────────────────
ipcMain.handle('load-config', () => loadConfig())
ipcMain.handle('save-config', (_, data) => { saveConfig(data); return true })
ipcMain.handle('get-home-dir', () => os.homedir())

// ── IPC: open URL in browser ───────────────────────────────────────────────────
ipcMain.handle('open-url', (_, url) => { shell.openExternal(url); return true })

// ── IPC: pick directory ────────────────────────────────────────────────────────
ipcMain.handle('pick-dir', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})

// ── IPC: pick file ─────────────────────────────────────────────────────────────
ipcMain.handle('pick-file', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Video / Audio', extensions: ['mp4','mkv','webm','avi','mov','mp3','aac','m4a','ogg'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  return result.canceled ? null : result.filePaths[0]
})

// ── IPC: ensure yt-dlp binary ─────────────────────────────────────────────────
ipcMain.handle('ensure-ytdlp', async () => {
  const ytDlpWrap = new YTDlpWrap()
  const binDir  = path.join(app.getPath('userData'), 'bin')
  const binPath = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  if (!fs.existsSync(binPath)) {
    fs.mkdirSync(binDir, { recursive: true })
    await YTDlpWrap.downloadFromGithub(binPath)
  }
  return binPath
})

// ── IPC: download ──────────────────────────────────────────────────────────────
ipcMain.handle('download', async (event, { url, quality, outputDir, ytdlpPath }) => {
  const ytDlp = new YTDlpWrap(ytdlpPath)

  const qualityMap = {
    '4K (2160p)': 'bestvideo[height<=2160][ext=mp4]+bestaudio[ext=m4a]/best[height<=2160][ext=mp4]/best[height<=2160]',
    '1440p':      'bestvideo[height<=1440][ext=mp4]+bestaudio[ext=m4a]/best[height<=1440][ext=mp4]/best[height<=1440]',
    '1080p':      'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]',
    '720p':       'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]',
    '480p':       'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]',
    '360p':       'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][ext=mp4]/best[height<=360]',
    'Audio Only': 'bestaudio[ext=m4a]/bestaudio',
  }

  const fmt = qualityMap[quality] || qualityMap['1080p']

  // Always resolve to a real directory — never let an empty string reach yt-dlp
  const effectiveDir = (outputDir && outputDir.trim())
    ? outputDir
    : path.join(os.homedir(), 'Downloads')

  fs.mkdirSync(effectiveDir, { recursive: true })

  const outTemplate = path.join(effectiveDir, '%(title)s.%(ext)s')
  const videoExts   = new Set(['.mp4','.mkv','.webm','.avi','.mov','.m4a','.mp3','.aac','.ogg'])

  return new Promise((resolve, reject) => {
    let downloadedFile = null
    let lastPct = 0

    const args = [
      url,
      '--format', fmt,
      '--merge-output-format', 'mp4',
      '--output', outTemplate,
      '--newline',
      '--no-playlist',
    ]

    const proc = ytDlp.execStream(args)

    proc.on('ytDlpEvent', (eventType, eventData) => {
      if (eventType === 'download' && eventData.includes('%')) {
        const m = eventData.match(/(\d+(?:\.\d+)?)%/)
        if (m) {
          const pct = parseFloat(m[1])
          if (pct !== lastPct) {
            lastPct = pct
            event.sender.send('dl-progress', Math.min(pct, 100))
          }
        }
      }

      // Capture destination from multiple possible log line formats
      if (eventData.includes('Destination:')) {
        const dest = eventData.split('Destination:')[1]?.trim()
        if (dest) downloadedFile = dest
      }
      // Merger outputs the final merged file path
      if (eventType === 'Merger' && eventData.includes('into "')) {
        const m = eventData.match(/into "([^"]+)"/)
        if (m) downloadedFile = m[1]
      }

      if (eventData) event.sender.send('dl-log', eventData)
    })

    proc.on('error', reject)

    proc.on('close', () => {
      // Prefer the captured destination, trying the .mp4 version first (post-merge)
      if (downloadedFile) {
        const mp4 = downloadedFile.replace(/\.[^.]+$/, '.mp4')
        if (fs.existsSync(mp4)) { resolve(mp4); return }
        if (fs.existsSync(downloadedFile)) { resolve(downloadedFile); return }
      }

      // Fallback: newest media file in effectiveDir only (never picks ZIPs etc.)
      try {
        const files = fs.readdirSync(effectiveDir)
          .filter(f => videoExts.has(path.extname(f).toLowerCase()))
          .map(f => ({ f, t: fs.statSync(path.join(effectiveDir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t)
        if (files.length) { resolve(path.join(effectiveDir, files[0].f)); return }
      } catch {}

      reject(new Error('Could not locate downloaded file'))
    })
  })
})

// ── IPC: upload ────────────────────────────────────────────────────────────────
ipcMain.handle('upload', async (event, { filePath, apiKey }) => {
  const ext = path.extname(filePath).toLowerCase()
  const audioExts = ['.mp3', '.aac', '.ogg', '.flac', '.wav', '.m4a']
  const endpoint = audioExts.includes(ext)
    ? 'https://api.fivemanage.com/api/audio'
    : 'https://api.fivemanage.com/api/video'

  const stat    = fs.statSync(filePath)
  const total   = stat.size
  let uploaded  = 0

  const form = new FormData()
  const stream = fs.createReadStream(filePath)

  stream.on('data', chunk => {
    uploaded += chunk.length
    const pct = Math.min((uploaded / total) * 100, 99)
    event.sender.send('up-progress', pct)
  })

  // knownLength lets form-data set a correct Content-Length, which some APIs require
  form.append('file', stream, { filename: path.basename(filePath), knownLength: total })

  const response = await axios.post(endpoint, form, {
    headers: { ...form.getHeaders(), Authorization: apiKey },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 0,
    validateStatus: null, // let us handle status ourselves for better error messages
  })

  event.sender.send('up-progress', 100)

  if (response.status < 200 || response.status >= 300) {
    const body = typeof response.data === 'object'
      ? JSON.stringify(response.data)
      : String(response.data)
    throw new Error(`FiveManage returned ${response.status}: ${body}`)
  }

  const data = response.data
  return data?.url || data?.link || data?.data?.url || JSON.stringify(data)
})
