/**
 * Settings — transcription model manager.
 *
 * Lists every model the backend knows about with the three facts that actually
 * decide whether it suits a job: which runtime loads it (and therefore whether
 * it uses the GPU), whether it reports its own word timings, and what languages
 * it covers. Models are downloaded and removed from here, with live progress.
 */

class SettingsController {
  constructor(opts = {}) {
    this.toast = opts.toast || (() => {});
    this.onModelsChanged = opts.onModelsChanged || (() => {});
    this.probe = null;
    this.models = [];
    this.aligner = null;
    this.diarizer = null;
    this.runtimes = [];
    this.filter = 'all';
    this.pollTimers = new Map();
  }

  hasBackend() {
    return !!(window.pywebview && window.pywebview.api && window.pywebview.api.models_list);
  }

  bind() {
    const modal = document.getElementById('settingsModal');

    document.getElementById('btnSettings').addEventListener('click', () => this.open());
    document.getElementById('btnCloseSettings').addEventListener('click', () => this.close());
    document.getElementById('btnCloseSettingsFooter').addEventListener('click', () => this.close());
    modal.addEventListener('click', (e) => { if (e.target === modal) this.close(); });

    document.querySelectorAll('.model-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.model-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.filter = btn.dataset.tier;
        this.renderModels();
      });
    });

    document.getElementById('btnInstallRecommended')
      .addEventListener('click', () => this.installRuntime('__recommended__',
        document.getElementById('runtimeList')));
  }

  async open() {
    document.getElementById('settingsModal').classList.remove('hidden');
    await this.refresh();
  }

  close() {
    document.getElementById('settingsModal').classList.add('hidden');
  }

  isOpen() {
    return !document.getElementById('settingsModal').classList.contains('hidden');
  }

  async refresh() {
    const note = document.getElementById('settingsNote');

    if (!this.hasBackend()) {
      document.getElementById('settingsSystemInfo').textContent =
        'The desktop backend is not running, so models cannot be managed from here.';
      document.getElementById('modelList').innerHTML = '';
      document.getElementById('alignerRow').innerHTML = '';
      document.getElementById('diarizerRow').innerHTML = '';
      note.className = 'export-note warn';
      note.textContent =
        `Launch Taylor's Transcriber with run_subtitler.sh (or "python3 app.py") to install and run models.`;
      return;
    }

    note.className = 'export-note';
    note.textContent = '';

    try {
      this.probe = await window.pywebview.api.transcribe_probe();
      this.models = this.probe.models || [];
      this.aligner = this.probe.aligner || null;
      this.diarizer = this.probe.diarizer || null;
      this.runtimes = this.probe.runtimes || [];
      this.renderSystemInfo();
      this.renderRuntimes();
      this.renderAligner();
      this.renderDiarizer();
      this.renderModels();
      this.renderDisk();
    } catch (e) {
      note.className = 'export-note err';
      note.textContent = `Could not read model status: ${e}`;
    }
  }

  renderSystemInfo() {
    const p = this.probe;
    const el = document.getElementById('settingsSystemInfo');
    const lines = [];

    if (p.version) {
      lines.push(`Version ${p.version}${p.bundled ? '' : ' (running from source)'}`);
    }
    lines.push(`Device: ${p.device_name}`);

    const engines = p.engines || [];
    if (engines.length) {
      lines.push(`Runtimes installed: ${engines.join(', ')}`);
    } else {
      lines.push('Runtimes installed: none');
    }

    // On Apple Silicon, flag the case where only the CPU-bound runtime is present.
    if (p.apple_silicon) {
      const hasGpuRuntime = engines.some(e => e.indexOf('mlx') !== -1 || e.indexOf('parakeet') !== -1);
      if (!hasGpuRuntime) {
        lines.push('⚠ No GPU runtime installed. CTranslate2 (faster-whisper) has no Metal '
          + 'backend, so it runs on CPU cores only and leaves the GPU idle. '
          + 'Install mlx-whisper or parakeet-mlx to use the Apple GPU.');
      }
    }

    lines.push(`Models installed: ${p.installed_count} · Cache: ${p.cache_dir}`);
    if (p.in_venv) {
      lines.push(`Environment: ${p.venv_dir} (private to this app)`);
    } else if (p.can_install_runtimes === false) {
      lines.push('⚠ Not running in the app\'s own environment, so runtimes cannot be '
        + 'installed from here. Relaunch with run_subtitler.sh.');
    }
    el.textContent = lines.join('\n');
  }

  /**
   * Runtimes are pip packages rather than model weights, so they install into
   * the app's own venv. That is what removes the terminal from the setup: the
   * app owns its environment, so it can extend it on a button click.
   */
  renderRuntimes() {
    const list = document.getElementById('runtimeList');
    const recBtn = document.getElementById('btnInstallRecommended');
    const runtimes = this.runtimes || [];

    if (runtimes.length === 0) {
      list.innerHTML = '<div class="model-notes">No runtimes are available for this platform.</div>';
      recBtn.classList.add('hidden');
      return;
    }

    const canInstall = this.probe.can_install_runtimes !== false;
    const missingRecommended = runtimes.filter(r => r.recommended && !r.installed);
    recBtn.classList.toggle('hidden', !canInstall || missingRecommended.length === 0);
    recBtn.disabled = !canInstall;

    // Recommended first, then not-yet-installed, so the useful action is on top.
    const sorted = runtimes.slice().sort((a, b) =>
      (b.recommended - a.recommended) || (a.installed - b.installed));

    list.innerHTML = '';
    sorted.forEach(rt => {
      const badges = [];
      if (rt.recommended) badges.push({ cls: 'rec', text: 'recommended' });
      if (rt.id.indexOf('mlx') !== -1 || rt.id.indexOf('parakeet') !== -1) {
        badges.push({ cls: 'gpu', text: 'Apple GPU' });
      }
      if (rt.id === 'faster-whisper') badges.push({ cls: 'cpu', text: 'CPU only on Mac' });
      if (rt.id === 'aligner-torch') badges.push({ cls: 'timing', text: 'word timing' });

      const row = document.createElement('div');
      row.className = `model-row${rt.installed ? ' installed' : ''}`;
      row.innerHTML = this.runtimeRowHtml(rt, badges, canInstall);
      list.appendChild(row);

      const btn = row.querySelector('[data-action="install-runtime"]');
      if (btn) btn.addEventListener('click', () => this.installRuntime(rt.id, row));
    });
  }

  runtimeRowHtml(rt, badges, canInstall) {
    const badgeHtml = badges
      .map(b => `<span class="model-badge ${b.cls}">${this.esc(b.text)}</span>`).join('');
    const size = rt.size_mb >= 1000
      ? `${(rt.size_mb / 1000).toFixed(1)} GB download`
      : `${rt.size_mb} MB download`;

    let action;
    if (rt.installed) {
      action = '<span class="runtime-ok">Installed</span>';
    } else if (!canInstall) {
      action = '<button class="btn-model" disabled>Unavailable</button>';
    } else {
      action = '<button class="btn-model primary" data-action="install-runtime">Install</button>';
    }

    return `
      <div class="model-row-top">
        <span class="model-name">${this.esc(rt.label)}</span>
        <div class="model-badges">${badgeHtml}</div>
      </div>
      ${rt.notes ? `<div class="model-notes">${this.esc(rt.notes)}</div>` : ''}
      <div class="model-row-bottom">
        <span class="model-meta">${this.esc(size)} · ${this.esc(rt.packages.join(', '))}</span>
        <div class="model-actions">${action}</div>
      </div>
      <div class="model-progress hidden">
        <div class="progress-track"><div class="progress-fill indeterminate"></div></div>
        <div class="model-progress-text"></div>
      </div>
    `;
  }

  async installRuntime(runtimeId, row) {
    const btn = row.querySelector('[data-action="install-runtime"]')
      || document.getElementById('btnInstallRecommended');
    const progress = row.querySelector('.model-progress')
      || document.querySelector('#runtimeList .model-progress');
    const text = progress ? progress.querySelector('.model-progress-text') : null;

    if (btn) { btn.disabled = true; btn.textContent = 'Installing…'; }
    if (progress) progress.classList.remove('hidden');
    if (text) text.textContent = 'Starting install…';

    try {
      const started = await window.pywebview.api.runtime_install(runtimeId);
      if (!started || !started.ok) throw new Error((started && started.error) || 'Could not start install.');

      for (;;) {
        await new Promise(r => setTimeout(r, 700));
        const st = await window.pywebview.api.runtime_install_status(started.job_id);
        if (!st || !st.ok) throw new Error((st && st.error) || 'Lost track of the install.');
        if (text) text.textContent = st.message || 'Installing…';
        if (st.state === 'done') break;
        if (st.state === 'error') throw new Error(st.error || 'Install failed.');
      }

      this.toast('Runtime installed. Restart the app to start using it.', 'success', 9000);
      await this.refresh();
      this.onModelsChanged();
    } catch (e) {
      if (text) text.textContent = e.message;
      this.toast(`Runtime install failed: ${e.message}`, 'error', 10000);
      if (btn) { btn.disabled = false; btn.textContent = 'Install'; }
    }
  }

  renderAligner() {
    const row = document.getElementById('alignerRow');
    if (!this.aligner) { row.innerHTML = ''; return; }
    row.className = `model-row${this.aligner.installed ? ' installed' : ''}`;
    row.innerHTML = this.modelRowHtml({
      id: this.aligner.id,
      label: this.aligner.label,
      notes: this.aligner.notes,
      size_gb: this.aligner.size_gb,
      installed: this.aligner.installed,
      engine_available: this.aligner.available !== false,
      engine_package: 'torch torchaudio',
      badges: [{ cls: 'timing', text: 'word timing' }]
    });
    this.wireRow(row, this.aligner.id);
  }

  /**
   * The speaker model is small, but useless without SpeechBrain — so the row
   * says so rather than offering a download that cannot run.
   */
  renderDiarizer() {
    const row = document.getElementById('diarizerRow');
    if (!row) return;
    if (!this.diarizer) { row.innerHTML = ''; return; }
    row.className = `model-row${this.diarizer.installed ? ' installed' : ''}`
      + (this.diarizer.available ? '' : ' unavailable');
    row.innerHTML = this.modelRowHtml({
      id: this.diarizer.id,
      label: this.diarizer.label,
      notes: this.diarizer.notes,
      size_gb: this.diarizer.size_gb,
      installed: this.diarizer.installed,
      engine_available: this.diarizer.available !== false,
      engine_package: 'speechbrain',
      badges: [{ cls: 'timing', text: 'speaker labels' }]
    });
    this.wireRow(row, this.diarizer.id);
  }

  renderModels() {
    const list = document.getElementById('modelList');
    const shown = this.models.filter(m => this.filter === 'all' || m.tier === this.filter);

    if (shown.length === 0) {
      list.innerHTML = '<div class="model-notes">No models in this category.</div>';
      return;
    }

    // Installed first, then most accurate first.
    const tierRank = { accuracy: 0, balanced: 1, fast: 2 };
    shown.sort((a, b) => (b.installed - a.installed)
      || (tierRank[a.tier] - tierRank[b.tier])
      || ((a.wer || 99) - (b.wer || 99)));

    list.innerHTML = '';
    shown.forEach(m => {
      const badges = [];
      if (m.id === this.probe.recommended) badges.push({ cls: 'rec', text: 'recommended' });
      if (m.wer) badges.push({ cls: 'wer', text: `${m.wer}% WER` });
      badges.push(m.engine.indexOf('mlx') !== -1 || m.engine.indexOf('parakeet') !== -1
        ? { cls: 'gpu', text: 'Apple GPU' }
        : (m.engine === 'faster-whisper' ? { cls: 'cpu', text: 'CPU only on Mac' } : { cls: '', text: m.engine_label }));
      if (m.english_only) badges.push({ cls: 'english', text: 'English only' });
      badges.push(m.word_timings
        ? { cls: 'timing', text: 'own timings' }
        : { cls: 'timing', text: 'needs aligner' });

      const row = document.createElement('div');
      row.className = `model-row${m.installed ? ' installed' : ''}${m.engine_available ? '' : ' unavailable'}`;
      row.innerHTML = this.modelRowHtml({ ...m, badges });
      list.appendChild(row);
      this.wireRow(row, m.id);
    });
  }

  modelRowHtml(m) {
    const badges = (m.badges || [])
      .map(b => `<span class="model-badge ${b.cls}">${this.esc(b.text)}</span>`).join('');

    const size = m.size_gb ? `${m.size_gb} GB` : '';
    const disk = m.disk_bytes ? ` · ${(m.disk_bytes / 1e9).toFixed(2)} GB on disk` : '';

    let actions;
    if (!m.engine_available) {
      actions = `<button class="btn-model" disabled>Runtime missing</button>`;
    } else if (m.installed) {
      actions = `<button class="btn-model danger" data-action="remove">Remove</button>`;
    } else {
      actions = `<button class="btn-model primary" data-action="install">Install</button>`;
    }

    // Runtimes are installed from the section above, so point there rather
    // than handing the user a shell command.
    const runtimeHint = m.engine_available ? '' :
      `<div class="install-hint">Needs the ${this.esc(m.engine_label || m.engine_package || '')} `
      + `runtime — install it under Speech Runtimes above.</div>`;

    return `
      <div class="model-row-top">
        <span class="model-name">${this.esc(m.label)}</span>
        <div class="model-badges">${badges}</div>
      </div>
      ${m.notes ? `<div class="model-notes">${this.esc(m.notes)}</div>` : ''}
      <div class="model-row-bottom">
        <span class="model-meta">${this.esc(size)}${disk}</span>
        <div class="model-actions">${actions}</div>
      </div>
      ${runtimeHint}
      <div class="model-progress hidden">
        <div class="progress-track"><div class="progress-fill"></div></div>
        <div class="model-progress-text"></div>
      </div>
    `;
  }

  wireRow(row, modelId) {
    const installBtn = row.querySelector('[data-action="install"]');
    const removeBtn = row.querySelector('[data-action="remove"]');

    if (installBtn) installBtn.addEventListener('click', () => this.install(modelId, row));
    if (removeBtn) removeBtn.addEventListener('click', () => this.remove(modelId, row));
  }

  async install(modelId, row) {
    const btn = row.querySelector('[data-action="install"]');
    const progress = row.querySelector('.model-progress');
    const bar = row.querySelector('.progress-fill');
    const text = row.querySelector('.model-progress-text');

    if (btn) { btn.disabled = true; btn.textContent = 'Installing…'; }
    progress.classList.remove('hidden');
    bar.style.width = '0%';
    text.textContent = 'Starting download…';

    try {
      const started = await window.pywebview.api.model_install(modelId);
      if (!started || !started.ok) throw new Error((started && started.error) || 'Could not start download.');

      const jobId = started.job_id;
      for (;;) {
        await new Promise(r => setTimeout(r, 600));
        const st = await window.pywebview.api.model_install_status(jobId);
        if (!st || !st.ok) throw new Error((st && st.error) || 'Lost track of the download.');

        bar.style.width = `${Math.round((st.progress || 0) * 100)}%`;
        text.textContent = st.message || 'Downloading…';

        if (st.state === 'done') break;
        if (st.state === 'error') throw new Error(st.error || 'Download failed.');
        if (st.state === 'cancelled') throw new Error('Cancelled.');
      }

      this.toast(`Installed successfully.`, 'success');
      await this.refresh();
      this.onModelsChanged();
    } catch (e) {
      text.textContent = e.message;
      this.toast(`Install failed: ${e.message}`, 'error', 8000);
      if (btn) { btn.disabled = false; btn.textContent = 'Install'; }
    }
  }

  async remove(modelId, row) {
    if (!confirm('Remove this model from disk? It can be downloaded again later.')) return;
    const btn = row.querySelector('[data-action="remove"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Removing…'; }

    try {
      const res = await window.pywebview.api.model_remove(modelId);
      if (!res || !res.ok) throw new Error((res && res.error) || 'Could not remove the model.');
      const freed = res.freed ? ` (${(res.freed / 1e9).toFixed(2)} GB freed)` : '';
      this.toast(`Model removed${freed}.`, 'success');
      await this.refresh();
      this.onModelsChanged();
    } catch (e) {
      this.toast(`Remove failed: ${e.message}`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Remove'; }
    }
  }

  renderDisk() {
    const el = document.getElementById('settingsDiskInfo');
    const used = this.models.reduce((n, m) => n + (m.disk_bytes || 0), 0);
    const free = this.probe.free_disk || 0;
    el.textContent = `Models on disk: ${(used / 1e9).toFixed(2)} GB · Free space: ${(free / 1e9).toFixed(0)} GB`;
  }

  /** Models that are installed and whose runtime is present — usable right now. */
  usableModels() {
    return this.models.filter(m => m.installed && m.engine_available);
  }

  esc(str) {
    return String(str === undefined || str === null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

window.SettingsController = SettingsController;
