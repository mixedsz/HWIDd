const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path       = require('path')
const fs         = require('fs')
const os         = require('os')
const { spawn }  = require('child_process')
const FormData   = require('form-data')
const axios      = require('axios')
const YTDlpWrap  = require('yt-dlp-wrap').default
const ffmpegPath = require('ffmpeg-static')

const CONFIG_PATH = path.join(os.homedir(), '.ytfivemanage.json')

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

// ── Window controls ────────────────────────────────────────────────────────────
ipcMain.on('win-minimize', () => win.minimize())
ipcMain.on('win-maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize())
ipcMain.on('win-close',    () => win.close())

// ── Config / util ──────────────────────────────────────────────────────────────
ipcMain.handle('load-config',  ()     => loadConfig())
ipcMain.handle('save-config',  (_, d) => { saveConfig(d); return true })
ipcMain.handle('get-home-dir', ()     => os.homedir())
ipcMain.handle('open-url',  (_, url)  => { shell.openExternal(url); return true })

ipcMain.handle('pick-dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('pick-file', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Video / Audio', extensions: ['mp4','mkv','webm','avi','mov','mp3','aac','m4a','ogg'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  })
  return r.canceled ? null : r.filePaths[0]
})

// ── Ensure yt-dlp binary ───────────────────────────────────────────────────────
ipcMain.handle('ensure-ytdlp', async () => {
  const binDir  = path.join(app.getPath('userData'), 'bin')
  const binPath = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  if (!fs.existsSync(binPath)) {
    fs.mkdirSync(binDir, { recursive: true })
    await YTDlpWrap.downloadFromGithub(binPath)
  }
  return binPath
})

// ── Download ───────────────────────────────────────────────────────────────────
// Uses spawn() directly so yt-dlp saves to disk instead of piping to stdout.
// --print after_move:filepath prints the final file path as a bare line (no [] prefix)
// once all merging/conversion is done — that's how we reliably find the file.
ipcMain.handle('download', (event, { url, quality, outputDir, ytdlpPath }) => {
  const qualityMap = {
    '4K (2160p)': 'bestvideo[height<=2160][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=2160]+bestaudio/best[height<=2160]',
    '1440p':      'bestvideo[height<=1440][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1440]+bestaudio/best[height<=1440]',
    '1080p':      'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]',
    '720p':       'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]',
    '480p':       'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]',
    '360p':       'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=360]+bestaudio/best[height<=360]',
    'Audio Only': 'bestaudio[ext=m4a]/bestaudio',
  }

  const effectiveDir = (outputDir && outputDir.trim()) ? outputDir : path.join(os.homedir(), 'Downloads')
  fs.mkdirSync(effectiveDir, { recursive: true })

  const fmt         = qualityMap[quality] || qualityMap['1080p']
  const outTemplate = path.join(effectiveDir, '%(title)s.%(ext)s')
  const videoExts   = new Set(['.mp4','.mkv','.webm','.avi','.mov','.m4a','.mp3','.aac','.ogg'])

  return new Promise((resolve, reject) => {
    const args = [
      '--format',              fmt,
      '--merge-output-format', 'mp4',
      '--ffmpeg-location',     ffmpegPath,   // bundled ffmpeg — merges video+audio into one MP4
      '--output',              outTemplate,
      '--no-playlist',
      '--print',               'after_move:filepath',
      '--newline',
      url,
    ]

    const proc = spawn(ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let finalPath = null
    let lastPct   = 0
    let stdoutBuf = ''
    let stderrBuf = ''

    proc.stdout.on('data', chunk => {
      stdoutBuf += chunk.toString()
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop()   // hold back incomplete last line

      for (const raw of lines) {
        const line = raw.trim()
        if (!line) continue

        // --print after_move:filepath emits the absolute path with no [] prefix
        if (path.isAbsolute(line) && fs.existsSync(line)) {
          finalPath = line
          event.sender.send('dl-progress', 100)
          event.sender.send('dl-log', `✅ Saved: ${path.basename(line)}`)
          continue
        }

        // Progress  e.g.  "[download]  67.2% of   30.32MiB at  142.52MiB/s ETA 00:00"
        const pctMatch = line.match(/(\d+(?:\.\d+)?)%/)
        if (pctMatch) {
          const pct = parseFloat(pctMatch[1])
          if (pct !== lastPct) {
            lastPct = pct
            event.sender.send('dl-progress', Math.min(pct, 99))
          }
        }

        event.sender.send('dl-log', line)
      }
    })

    proc.stderr.on('data', chunk => {
      stderrBuf += chunk.toString()
      const lines = stderrBuf.split('\n')
      stderrBuf = lines.pop()
      for (const raw of lines) {
        const line = raw.trim()
        if (line) event.sender.send('dl-log', line)
      }
    })

    proc.on('error', err => reject(new Error(`Failed to start yt-dlp: ${err.message}`)))

    proc.on('close', code => {
      if (finalPath) { resolve(finalPath); return }

      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code} — check the activity log`))
        return
      }

      // Fallback: newest media file in effectiveDir (never picks ZIPs or other junk)
      try {
        const files = fs.readdirSync(effectiveDir)
          .filter(f => videoExts.has(path.extname(f).toLowerCase()))
          .map(f => ({ f, t: fs.statSync(path.join(effectiveDir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t)
        if (files.length) { resolve(path.join(effectiveDir, files[0].f)); return }
      } catch {}

      reject(new Error('Download finished but could not locate the output file'))
    })
  })
})

// ── Trim (ffmpeg) ──────────────────────────────────────────────────────────────
// ffmpegPath is the bundled binary from ffmpeg-static — no user install needed.
// We write to a temp file first, then overwrite the original on success.
ipcMain.handle('trim', (event, { filePath, startTime, endTime }) => {
  return new Promise((resolve, reject) => {
    const dir     = path.dirname(filePath)
    const ext     = path.extname(filePath)
    const base    = path.basename(filePath, ext)
    const tmpPath = path.join(dir, `${base}_trimming${ext}`)

    // -ss before -i = fast seek (keyframe); -c copy = no re-encode = instant
    const args = ['-y', '-ss', startTime, '-i', filePath]
    if (endTime && endTime.trim()) args.push('-to', endTime)
    args.push('-c', 'copy', tmpPath)

    event.sender.send('dl-log', `✂  ffmpeg ${args.join(' ')}`)

    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    proc.stderr.on('data', chunk => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) event.sender.send('dl-log', line)
      }
    })

    proc.on('error', reject)
    proc.on('close', code => {
      if (code === 0) {
        try { fs.unlinkSync(filePath) }   catch {}
        fs.renameSync(tmpPath, filePath)
        resolve(filePath)
      } else {
        try { fs.unlinkSync(tmpPath) } catch {}
        reject(new Error(`ffmpeg exited with code ${code}`))
      }
    })
  })
})

// ── Upload ─────────────────────────────────────────────────────────────────────
ipcMain.handle('upload', async (event, { filePath, apiKey }) => {
  const ext       = path.extname(filePath).toLowerCase()
  const audioExts = new Set(['.mp3','.aac','.ogg','.flac','.wav','.m4a'])
  const endpoint  = audioExts.has(ext)
    ? 'https://api.fivemanage.com/api/audio'
    : 'https://api.fivemanage.com/api/video'

  const total     = fs.statSync(filePath).size
  let   uploaded  = 0

  const form   = new FormData()
  const stream = fs.createReadStream(filePath)

  stream.on('data', chunk => {
    uploaded += chunk.length
    event.sender.send('up-progress', Math.min((uploaded / total) * 100, 99))
  })

  form.append('file', stream, { filename: path.basename(filePath), knownLength: total })

  const response = await axios.post(endpoint, form, {
    headers:           { ...form.getHeaders(), Authorization: apiKey },
    maxContentLength:  Infinity,
    maxBodyLength:     Infinity,
    timeout:           0,
    validateStatus:    null,
  })

  event.sender.send('up-progress', 100)

  if (response.status < 200 || response.status >= 300) {
    const body = typeof response.data === 'object'
      ? JSON.stringify(response.data)
      : String(response.data)
    throw new Error(`FiveManage ${response.status}: ${body}`)
  }

  const d = response.data
  return d?.url || d?.link || d?.data?.url || JSON.stringify(d)
})
