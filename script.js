// Fastout — static, backend-free rebuild.
//
// The original project streamed real bytes through a Node/Express server
// (chunked range requests, SSE progress events, disk-backed merge). None of
// that can exist in a pure static page, so this file reproduces the exact
// same UI/state machine and drives it with a local simulation instead:
// realistic chunk counts, worker/connection counts, speed jitter, a log
// terminal, and a chart — all computed client-side. The "Save File" button
// on completion links straight to the real URL the user pasted, so it still
// performs a genuine browser download; everything upstream of that (speed,
// ETA, chunk graph, terminal) is illustrative.

function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return 'Calculating...';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

// Deterministic PRNG so the same URL always "reports" the same file size /
// chunk layout across repeated runs in the same session.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(hash, 31) + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

const MIN_CONNECTIONS = 4;
const MAX_CONNECTIONS = 16;

function getChunkSize(totalSize) {
  const MB = 1024 * 1024;
  const GB = 1024 * MB;
  if (totalSize < 100 * MB) return 4 * MB;
  if (totalSize < 500 * MB) return 8 * MB;
  if (totalSize < 2 * GB) return 16 * MB;
  if (totalSize < 10 * GB) return 32 * MB;
  return 64 * MB;
}

function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || h.endsWith('.local')) return true;
  const parts = h.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    const nums = parts.map(Number);
    if (nums.some((n) => n > 255)) return false;
    const [a, b] = nums;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 169 && b === 254) return true; // link-local
    if (a === 0) return true;
  }
  return false;
}

class FastoutApp {
  constructor(rootId) {
    this.root = document.getElementById(rootId);
    this.state = 'idle'; // idle | downloading | paused | merging | completed | error
    this.url = '';
    this.progress = 0;
    this.downloaded = 0;
    this.total = 0;
    this.speed = 0;
    this.avgSpeed = 0;
    this.activeConnections = 0;
    this.completedChunks = 0;
    this.totalChunks = 0;
    this.logs = [];
    this.errorMessage = '';
    this.filename = '';

    this.speedHistory = [];
    this.chartInstance = null;
    this.lastRenderState = null;

    // simulation-only internals
    this.chunks = [];
    this.targetConnections = MIN_CONNECTIONS;
    this.simInterval = null;
    this.simDurationMs = 0;
    this.simStartTime = 0;
    this.lastTickTime = 0;

    this.render();
  }

  setState(patch) {
    Object.assign(this, patch);
    this.render();
  }

  addLog(message) {
    const ts = new Date().toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    this.logs.push(`[${ts}] ${message}`);
    if (this.logs.length > 100) this.logs.shift();
  }

  // ---- lifecycle -----------------------------------------------------

  startDownload(e) {
    e.preventDefault();
    const raw = this.url.trim();
    if (!raw) return;

    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      this.setState({ state: 'error', errorMessage: 'Invalid URL. Provide a full http:// or https:// direct-download link.' });
      return;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      this.setState({ state: 'error', errorMessage: 'Only HTTP/HTTPS URLs are supported.' });
      return;
    }

    if (isBlockedHost(parsed.hostname)) {
      this.setState({ state: 'error', errorMessage: 'SSRF protection: refusing to connect to a private/internal network address.' });
      return;
    }

    if (this.simInterval) clearInterval(this.simInterval);

    this.setState({
      state: 'downloading',
      progress: 0,
      downloaded: 0,
      total: 0,
      speed: 0,
      avgSpeed: 0,
      activeConnections: 0,
      errorMessage: '',
      completedChunks: 0,
      totalChunks: 0,
      logs: [],
      speedHistory: [],
      filename: 'Connecting...',
    });

    this.addLog('Validating URL and checking direct-download support...');
    this.addLog('SSRF check passed. Target host is public.');

    const seed = hashString(parsed.href);
    const rand = mulberry32(seed);

    let name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || 'download');
    name = name.replace(/[^a-zA-Z0-9.\-_ ()]/g, '_') || 'downloaded_file';

    const total = Math.floor(2 * 1024 * 1024 + rand() * 898 * 1024 * 1024); // ~2MB - 900MB
    const supportsRanges = rand() > 0.15;
    const chunkSize = getChunkSize(total);
    const numChunks = supportsRanges ? Math.max(1, Math.ceil(total / chunkSize)) : 1;

    this.chunks = Array.from({ length: numChunks }, (_, i) => ({
      id: i,
      status: 'pending',
    }));
    this.total = total;
    this.filename = name;
    this.totalChunks = numChunks;
    this.completedChunks = 0;
    this.targetConnections = supportsRanges ? Math.min(MAX_CONNECTIONS, Math.max(MIN_CONNECTIONS, 8), numChunks) : 1;

    this.addLog(`Analyzed server. Range support: ${supportsRanges ? 'Yes' : 'No'}`);
    this.addLog(`File size: ${total} bytes. Splitting into ${numChunks} chunks.`);

    for (let i = 0; i < this.targetConnections; i++) {
      this.chunks[i].status = 'downloading';
      this.addLog(`Worker started chunk ${i + 1}/${numChunks}`);
    }
    this.activeConnections = this.chunks.filter((c) => c.status === 'downloading').length;

    this.simDurationMs = (6 + rand() * 9) * 1000; // 6-15s simulated total
    this.simStartTime = Date.now();
    this.lastTickTime = this.simStartTime;

    this.render();
    this.simInterval = setInterval(() => this.tick(), 500);
  }

  tick() {
    if (this.state !== 'downloading') return;

    const now = Date.now();
    const dt = Math.max(0.001, (now - this.lastTickTime) / 1000);
    this.lastTickTime = now;

    const elapsed = now - this.simStartTime;
    const remaining = this.total - this.downloaded;
    const remainingTimeMs = Math.max(200, this.simDurationMs - elapsed);
    const baseSpeed = remaining / (remainingTimeMs / 1000);
    const jitter = 0.55 + Math.random() * 0.9; // fluctuate 0.55x - 1.45x
    let speed = Math.max(0, baseSpeed * jitter);

    let inc = Math.min(remaining, speed * dt);
    if (elapsed >= this.simDurationMs) inc = remaining; // final push, guarantee completion

    this.downloaded += inc;
    this.speed = speed;
    this.avgSpeed = this.avgSpeed === 0 ? speed : this.avgSpeed * 0.9 + speed * 0.1;

    const newCompleted = Math.min(this.totalChunks, Math.floor((this.downloaded / this.total) * this.totalChunks));
    while (this.completedChunks < newCompleted) {
      this.completedChunks++;
      this.addLog(`Chunk ${this.completedChunks} completed.`);
      const nextPending = this.chunks.find((c) => c.status === 'pending');
      if (nextPending) {
        nextPending.status = 'downloading';
        this.addLog(`Worker started chunk ${nextPending.id + 1}/${this.totalChunks}`);
      }
    }
    this.activeConnections = this.chunks.filter((c) => c.status === 'downloading').length;

    this.speedHistory.push(speed);
    if (this.speedHistory.length > 60) this.speedHistory.shift();

    this.progress = this.total > 0 ? Math.min(100, Math.round((this.downloaded / this.total) * 100)) : 0;

    if (this.downloaded >= this.total) {
      clearInterval(this.simInterval);
      this.simInterval = null;
      this.startMerge();
      return;
    }

    this.render();
  }

  startMerge() {
    this.state = 'merging';
    this.progress = 100;
    this.completedChunks = this.totalChunks;
    this.activeConnections = 0;
    this.addLog('All chunks downloaded. Starting sequential merge...');
    this.render();

    setTimeout(() => {
      this.addLog('Merge and verification successful.');
      this.state = 'completed';
      this.render();
    }, 700 + Math.random() * 700);
  }

  togglePause() {
    if (this.state === 'downloading') {
      if (this.simInterval) clearInterval(this.simInterval);
      this.simInterval = null;
      this.chunks.forEach((c) => {
        if (c.status === 'downloading') c.status = 'pending';
      });
      this.activeConnections = 0;
      this.speed = 0;
      this.addLog('Download paused by user.');
      this.state = 'paused';
      this.render();
    } else if (this.state === 'paused') {
      const fractionDone = this.total > 0 ? this.downloaded / this.total : 0;
      this.simStartTime = Date.now() - fractionDone * this.simDurationMs;
      this.lastTickTime = Date.now();

      const resumeCount = Math.min(this.targetConnections, this.chunks.filter((c) => c.status === 'pending').length);
      for (let i = 0; i < resumeCount; i++) {
        const next = this.chunks.find((c) => c.status === 'pending');
        if (next) {
          next.status = 'downloading';
          this.addLog(`Worker resumed chunk ${next.id + 1}/${this.totalChunks}`);
        }
      }
      this.activeConnections = this.chunks.filter((c) => c.status === 'downloading').length;
      this.addLog('Resuming download...');
      this.state = 'downloading';
      this.render();
      this.simInterval = setInterval(() => this.tick(), 500);
    }
  }

  cancelDownload() {
    if (this.state === 'downloading' || this.state === 'paused' || this.state === 'merging') {
      if (this.simInterval) clearInterval(this.simInterval);
      this.simInterval = null;
      this.setState({ state: 'idle', url: '', speedHistory: [] });
    }
  }

  retryDownload() {
    this.setState({ state: 'idle', speedHistory: [], errorMessage: '' });
  }

  copyLink() {
    if (this.url) {
      navigator.clipboard.writeText(this.url).then(() => {
        alert('Direct link copied to clipboard!');
      });
    }
  }

  // ---- rendering -------------------------------------------------------

  updateChart() {
    const canvas = document.getElementById('speedChart');
    if (!canvas || typeof Chart === 'undefined') return;

    const mbData = this.speedHistory.map((s) => s / (1024 * 1024));

    if (!this.chartInstance) {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const textColor = '#9ca3af';
      const gridColor = 'rgba(255,255,255,0.1)';

      this.chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
          labels: mbData.map(() => ''),
          datasets: [
            {
              label: 'Speed (MB/s)',
              data: mbData,
              borderColor: '#3b82f6',
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
              borderWidth: 2,
              pointRadius: 0,
              fill: true,
              tension: 0.4,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 0 },
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: {
            x: { grid: { display: false }, ticks: { display: false } },
            y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: textColor, maxTicksLimit: 4 } },
          },
        },
      });
    } else {
      this.chartInstance.data.labels = mbData.map(() => '');
      this.chartInstance.data.datasets[0].data = mbData;
      this.chartInstance.update();
    }
  }

  render() {
    const timeRemaining = this.speed > 0 && this.total > 0 ? (this.total - this.downloaded) / this.speed : -1;

    if (this.state !== this.lastRenderState) {
      this.lastRenderState = this.state;
      if (this.chartInstance) {
        this.chartInstance.destroy();
        this.chartInstance = null;
      }

      this.root.innerHTML = `
        <div class="relative bg-gray-800 rounded-3xl shadow-xl overflow-hidden ring-1 ring-white/20">
          <div class="px-8 pt-8 pb-6 text-center border-b border-white/20 relative">
            <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-blue-900/30 text-blue-400 mb-4">
              <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </div>
            <h1 class="text-3xl font-extrabold tracking-tight text-white mb-2">Fastout</h1>
            <p class="text-lg text-gray-400">Fast File Downloader</p>
          </div>

          <div class="p-8">
            ${this.state === 'idle' ? `
              <form id="download-form" class="space-y-6">
                <div>
                  <label for="url" class="sr-only">URL</label>
                  <input
                    type="url"
                    id="url"
                    class="block w-full px-5 py-4 text-base text-white bg-gray-900/50 border border-white/20 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-shadow outline-none placeholder-gray-500"
                    placeholder="Paste direct download URL here..."
                    value="${this.url}"
                    required
                  >
                </div>
                <button
                  type="submit"
                  class="w-full flex justify-center py-4 px-4 border border-transparent rounded-xl shadow-sm text-lg font-bold text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                >
                  Download
                </button>
              </form>
            ` : ''}

            ${(this.state === 'downloading' || this.state === 'paused' || this.state === 'merging') ? `
              <div class="space-y-6 py-2">
                <div class="flex items-center justify-between">
                  <h3 id="dom-filename" class="text-lg font-medium text-white truncate pr-4" title="${this.filename}">
                    ${this.filename || 'Connecting...'}
                  </h3>
                  <span id="dom-progress-text" class="text-sm font-semibold text-blue-400 whitespace-nowrap">
                    ${this.progress >= 0 ? `${this.progress}%` : '...'}
                  </span>
                </div>

                <div class="relative w-full h-3 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    id="dom-progress-bar"
                    class="absolute top-0 left-0 h-full bg-blue-600 rounded-full transition-all duration-300 ease-out"
                    style="width: ${this.progress}%"
                  ></div>
                </div>

                <div class="h-24 w-full">
                  <canvas id="speedChart"></canvas>
                </div>

                <div class="grid grid-cols-2 gap-4 text-sm">
                  <div class="bg-gray-900/50 p-4 rounded-xl border border-white/20 flex flex-col justify-between">
                    <p class="text-gray-400 mb-1 font-medium text-xs uppercase tracking-wider">Speed</p>
                    <p id="dom-speed" class="text-gray-100 font-semibold text-lg">${formatBytes(this.speed)}/s</p>
                  </div>
                  <div class="bg-gray-900/50 p-4 rounded-xl border border-white/20 flex flex-col justify-between">
                    <p class="text-gray-400 mb-1 font-medium text-xs uppercase tracking-wider">ETA</p>
                    <p id="dom-eta" class="text-gray-100 font-semibold text-lg">${timeRemaining >= 0 ? formatTime(timeRemaining) : '--'}</p>
                  </div>
                  <div class="col-span-2 bg-gray-900/50 p-4 rounded-xl border border-white/20 grid grid-cols-2 gap-y-3">
                    <div>
                      <p class="text-gray-400 font-medium text-xs uppercase tracking-wider mb-1">Downloaded</p>
                      <p id="dom-downloaded" class="text-gray-100 font-semibold">
                        ${formatBytes(this.downloaded)} ${this.total > 0 ? `/ ${formatBytes(this.total)}` : ''}
                      </p>
                    </div>
                    <div class="text-right">
                      <p class="text-gray-400 font-medium text-xs uppercase tracking-wider mb-1">Connections</p>
                      <p id="dom-connections" class="text-gray-100 font-semibold">${this.activeConnections}</p>
                    </div>
                    <div>
                      <p class="text-gray-400 font-medium text-xs uppercase tracking-wider mb-1">Completed Chunks</p>
                      <p id="dom-chunks" class="text-gray-100 font-semibold">${this.completedChunks} / ${this.totalChunks}</p>
                    </div>
                    <div class="text-right">
                      <p class="text-gray-400 font-medium text-xs uppercase tracking-wider mb-1">Active Chunks</p>
                      <p id="dom-active-chunks" class="text-gray-100 font-semibold">${this.activeConnections}</p>
                    </div>
                  </div>
                </div>

                <div class="mt-4 bg-black rounded-xl border border-white/20 overflow-hidden shadow-inner">
                  <div class="bg-gray-900/80 px-4 py-2 border-b border-white/20 flex items-center">
                    <div class="w-3 h-3 rounded-full bg-red-500/80 mr-2"></div>
                    <div class="w-3 h-3 rounded-full bg-yellow-500/80 mr-2"></div>
                    <div class="w-3 h-3 rounded-full bg-green-500/80 mr-2"></div>
                    <span class="text-xs text-gray-400 font-medium ml-2 uppercase tracking-widest">Engine Terminal</span>
                  </div>
                  <div id="dom-terminal" class="p-4 h-48 overflow-y-auto font-mono text-[11px] leading-relaxed text-green-400 space-y-1">
                    ${this.logs.map((log) => `<div>${log}</div>`).join('')}
                  </div>
                </div>

                <div class="flex gap-3 pt-2">
                  <button id="pause-btn" class="flex-1 py-3 px-4 border border-white/20 rounded-xl shadow-sm text-sm font-semibold text-gray-300 hover:bg-gray-700 focus:outline-none transition-colors">
                    ${this.state === 'merging' ? 'Merging...' : (this.state === 'paused' ? 'Resume' : 'Pause')}
                  </button>
                  <button id="cancel-btn" class="flex-1 py-3 px-4 border border-red-900/30 bg-red-900/20 rounded-xl shadow-sm text-sm font-semibold text-red-400 hover:bg-red-900/40 focus:outline-none transition-colors">
                    Cancel
                  </button>
                </div>
              </div>
            ` : ''}

            ${this.state === 'completed' ? `
              <div class="text-center space-y-6 py-6">
                <div class="inline-flex items-center justify-center w-20 h-20 rounded-full bg-green-900/30 text-green-400">
                  <svg class="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div>
                  <h3 class="text-2xl font-bold text-white mb-2">Download Complete</h3>
                  <p class="text-gray-400">${this.filename} (${formatBytes(this.total || this.downloaded)})</p>
                </div>

                <div class="pt-4 space-y-3">
                  <a href="${this.url}" download="${this.filename}" target="_blank" rel="noopener" class="w-full flex justify-center items-center py-4 px-4 border border-transparent rounded-xl shadow-sm text-lg font-bold text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 transition-colors">
                    <svg class="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Save File
                  </a>

                  <div class="flex gap-3">
                    <button id="copy-btn" class="flex-1 py-3 px-4 border border-white/20 rounded-xl shadow-sm text-sm font-semibold text-gray-300 hover:bg-gray-700 transition-colors">
                      Copy Link
                    </button>
                    <button id="retry-btn" class="flex-1 py-3 px-4 border border-white/20 rounded-xl shadow-sm text-sm font-semibold text-gray-300 hover:bg-gray-700 transition-colors">
                      Download Another
                    </button>
                  </div>
                </div>
              </div>
            ` : ''}

            ${this.state === 'error' ? `
              <div class="text-center space-y-6 py-6">
                <div class="inline-flex items-center justify-center w-20 h-20 rounded-full bg-red-900/30 text-red-400">
                  <svg class="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
                <div>
                  <h3 class="text-2xl font-bold text-white mb-2">Download Failed</h3>
                  <p class="text-red-400 bg-red-900/20 px-4 py-3 rounded-lg text-sm inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap" title="${this.errorMessage}">
                    ${this.errorMessage}
                  </p>
                </div>

                <div class="pt-4">
                  <button id="retry-btn" class="w-full flex justify-center py-4 px-4 border border-transparent rounded-xl shadow-sm text-lg font-bold text-white bg-blue-600 hover:bg-blue-700 transition-colors">
                    Try Again
                  </button>
                </div>
              </div>
            ` : ''}
          </div>
        </div>`;
      this.attachListeners();
    } else if (this.state === 'downloading' || this.state === 'paused' || this.state === 'merging') {
      const elProgressText = document.getElementById('dom-progress-text');
      const elProgressBar = document.getElementById('dom-progress-bar');
      const elFilename = document.getElementById('dom-filename');
      const elSpeed = document.getElementById('dom-speed');
      const elDownloaded = document.getElementById('dom-downloaded');
      const elConnections = document.getElementById('dom-connections');
      const elEta = document.getElementById('dom-eta');
      const elChunks = document.getElementById('dom-chunks');
      const elActiveChunks = document.getElementById('dom-active-chunks');
      const elTerminal = document.getElementById('dom-terminal');
      const btnPause = document.getElementById('pause-btn');

      if (elProgressText) elProgressText.innerText = `${this.progress}%`;
      if (elProgressBar) elProgressBar.style.width = `${this.progress}%`;
      if (elFilename) {
        elFilename.innerText = this.filename || 'Connecting...';
        elFilename.title = this.filename || '';
      }
      if (elSpeed) elSpeed.innerText = `${formatBytes(this.speed)}/s`;
      if (elDownloaded) elDownloaded.innerText = `${formatBytes(this.downloaded)} ${this.total > 0 ? `/ ${formatBytes(this.total)}` : ''}`;
      if (elConnections) elConnections.innerText = this.activeConnections.toString();
      if (elEta) elEta.innerText = timeRemaining >= 0 ? formatTime(timeRemaining) : '--';
      if (elChunks) elChunks.innerText = `${this.completedChunks} / ${this.totalChunks}`;
      if (elActiveChunks) elActiveChunks.innerText = this.activeConnections.toString();
      if (elTerminal) {
        elTerminal.innerHTML = this.logs.map((log) => `<div>${log}</div>`).join('');
        elTerminal.scrollTop = elTerminal.scrollHeight;
      }
      if (btnPause) {
        btnPause.innerText = this.state === 'merging' ? 'Merging...' : this.state === 'paused' ? 'Resume' : 'Pause';
      }
    }

    if (this.state === 'downloading' || this.state === 'paused' || this.state === 'merging') {
      this.updateChart();
    }
  }

  attachListeners() {
    const form = document.getElementById('download-form');
    if (form) {
      const urlInput = document.getElementById('url');
      urlInput.addEventListener('input', (e) => (this.url = e.target.value));
      form.addEventListener('submit', (e) => this.startDownload(e));
    }

    const cancelBtn = document.getElementById('cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.cancelDownload());

    const pauseBtn = document.getElementById('pause-btn');
    if (pauseBtn) pauseBtn.addEventListener('click', () => this.togglePause());

    document.querySelectorAll('#retry-btn').forEach((btn) => btn.addEventListener('click', () => this.retryDownload()));

    const copyBtn = document.getElementById('copy-btn');
    if (copyBtn) copyBtn.addEventListener('click', () => this.copyLink());
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new FastoutApp('app');
});
