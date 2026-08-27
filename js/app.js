/**
 * Taylor's Transcriber — Main Application
 * Premiere Pro Style Subtitling Tool Entry Point
 */

document.addEventListener('DOMContentLoaded', async () => {
  // The backend transport settles asynchronously: under the desktop shell it is
  // already injected, but in browser-fallback mode it is discovered over HTTP.
  // Wait for it so the first capability probe sees the real answer.
  if (window.bridgeReady) {
    try { await window.bridgeReady; } catch (e) { /* static mode */ }
  }

  const FPS = 25;

  // Matches LOW_CONFIDENCE in transcriber.py. Whisper-family probabilities
  // cluster high, so the bar sits well above a coin flip.
  const LOW_CONFIDENCE = 0.62;

  // Engine ids from model_registry.py. These are the ones that decide for
  // themselves whether a passage holds speech, and so the only ones with that
  // decision to hand back — see "Keep uncertain passages".
  const WHISPER_ENGINES = ['mlx-whisper', 'faster-whisper'];

  // Initialize Core Modules (25 FPS Default)
  const presetParser = new PresetParser();
  // Styles imported from Premiere or saved off the inspector, kept between
  // launches so a preset file only has to be found once.
  const presetLibrary = new PresetLibrary();
  const fontLoader = new FontLoader();
  const subManager = new SubtitleManager(FPS);

  // Turn the typography box into a dropdown of every installed font, so a face
  // can be picked by eye instead of typed from memory — and so a style can be
  // matched by hand when a file names a face under a slightly different name.
  const fontFamilyInput = document.getElementById('fontFamily');
  const fontPicker = new FontPicker(fontFamilyInput, {
    onSelect: async (name) => {
      // Usually a no-op: the platform draws an installed family by name, and
      // ensure() says so without fetching anything. Only when it does not —
      // another platform, or an exact face name — is the file registered here,
      // and only then is a redraw needed to pick the new face up.
      const result = await fontLoader.ensure(name);
      if (result.ok && result.source !== 'document' && result.source !== 'renderable') {
        fontFamilyInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });
  fontPicker.loadFamilies = () => fontLoader.listFamilies();
  fontLoader.listFamilies().then((families) => fontPicker.setFamilies(families));

  const videoEl = document.getElementById('videoPlayer');
  const canvasEl = document.getElementById('subtitleCanvas');
  const playerController = new VideoPlayerController(videoEl, canvasEl, subManager, presetParser, FPS);

  const rulerCanvas = document.getElementById('rulerCanvas');
  const waveformCanvas = document.getElementById('waveformCanvas');
  const subtitleTrackContent = document.getElementById('subtitleTrackContent');
  const playheadEl = document.getElementById('playheadScrubber');

  const timelineController = new TimelineController(
    rulerCanvas,
    waveformCanvas,
    subtitleTrackContent,
    playheadEl,
    subManager,
    playerController,
    FPS
  );

  const exporter = new AlphaExporter(playerController, subManager, FPS);
  const transcriber = new TranscriptionController();
  const settings = new SettingsController({
    toast: (m, k, d) => toast(m, k, d),
    onModelsChanged: () => populateModelSelect()
  });
  const segmenter = new CaptionSegmenter({ fps: FPS });

  // Holds the last transcription so segmentation settings can be re-applied
  // without paying for another model run.
  let lastTranscription = null;

  // One project == one job. Inside it sits a list of films: separate edits,
  // each with its own media, captions, caption style and aspect ratio. Only the
  // active film is live in the editor; the rest sit in the project record and
  // are swapped in when their tab is clicked.
  const project = new ProjectManager({
    fps: FPS,
    defaultPreset: { ...playerController.activePreset }
  });

  // Session-only state per film, keyed by film id: the File handle, its object
  // URL and its decoded waveform. None of it can live in a text project file,
  // which is why re-opening a project asks for the media to be relinked.
  const filmRuntimes = new Map();

  // Set while the editor is being repointed at another film, so the change
  // notifications that repointing causes are not mistaken for edits.
  let swappingFilm = false;

  // Where the project is parked between launches. Declared up here because
  // bootProject() runs long before the project section below is reached, and a
  // `let`/`const` is unusable until its own line executes.
  const AUTOSAVE_KEY = 'transcriber.project.autosave';
  const AUTOSAVE_PATH_KEY = 'transcriber.project.path';
  let autosaveTimer = null;

  // Waveform decoding draws straight into the one shared timeline, so decodes
  // are run one at a time and the visible waveform is put back afterwards.
  let waveformQueue = Promise.resolve();

  // Assigned when the transcribe dialog binds; keeps the model dropdown and the
  // language/alignment rules in one place while staying callable from outside.
  let applyModelRules = () => {};

  // Exposed for debugging and for the automated UI tests.
  window.__player = playerController;
  window.__subs = subManager;
  window.__timeline = timelineController;
  window.__exporter = exporter;
  window.__presets = presetParser;
  window.__presetLibrary = presetLibrary;
  window.__transcriber = transcriber;
  window.__settings = settings;
  window.__segmenter = segmenter;
  window.__project = project;
  window.__applyTranscription = applyTranscription;

  // --- Toast notifications (non-blocking replacement for alert()) ---
  const toastStack = document.createElement('div');
  toastStack.className = 'toast-stack';
  document.body.appendChild(toastStack);

  function toast(message, kind = 'info', durationMs = 4200) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    toastStack.appendChild(el);
    setTimeout(() => el.remove(), durationMs);
  }

  // --- UI Element Binding ---
  // Bind first: the panels subscribe to subManager.onChange here, so restoring
  // a project before this point would leave the list empty on boot.
  bindHeaderControls();
  bindAspectRatioControls();
  bindCaptionsListUI();
  bindStyleInspectorUI();
  bindPresetLibraryUI();
  // Before bootProject(): a reopened film names its style by id, and the saved
  // library is where those ids are defined.
  refreshPresetLibraryUI();
  bindTimelineToolbar();
  bindExportModal();
  bindTranscribeModal();
  // After bindAspectRatioControls, which publishes an initial aspect through
  // the same callbacks the project listens on — binding first would have the
  // app boot already claiming unsaved changes.
  bindProjectUI();
  settings.bind();
  bindKeyboardShortcuts();

  applyPresetToUI(playerController.activePreset);

  /**
   * Puts a project on screen at launch: the one autosaved from the last session
   * if there is one, otherwise an empty single-film project. A first run starts
   * with no captions — they arrive from a transcription or an import, and
   * seeding demo lines only leaves real work to be deleted first.
   *
   * Called from the very last line of this file rather than here. Restoring a
   * film drives the whole editor — transport, timeline, caption list — and those
   * handlers close over `let` bindings declared further down, which cannot be
   * touched until their own line has run.
   */
  function bootProject() {
    setupDemoPicture();

    const restored = restoreAutosave();

    applyActiveFilm();
    project.dirty = false;
    renderProjectUI();

    // Web fonts arrive after first paint; repaint so the preview shows the real
    // typeface rather than the fallback.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        playerController.fitProgramFrame();
        playerController.renderOverlay();
      });
    }

    if (restored) {
      const waiting = unlinkedCount();
      toast(`Reopened "${project.name}" — ${project.getFilms().length} film`
        + `${project.getFilms().length === 1 ? '' : 's'}.`
        + (waiting ? ` ${waiting} need media relinking.` : ''), 'info', 7000);
    }
  }

  // --- Header File Operations ---
  function bindHeaderControls() {
    // Media Upload Buttons
    const mediaInput = document.getElementById('mediaFileInput');
    document.getElementById('btnTriggerLoadMedia').addEventListener('click', () => {
      mediaInput.click();
    });

    mediaInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleMediaFile(file);
      e.target.value = ''; // allow re-selecting the same file
    });

    // Subtitle File Import (.srt / .vtt / .json)
    const subInput = document.getElementById('subFileInput');
    document.getElementById('btnTriggerImportSubs').addEventListener('click', () => {
      subInput.click();
    });

    subInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        const content = evt.target.result;
        try {
          let list;
          if (file.name.toLowerCase().endsWith('.json')) {
            const parsed = JSON.parse(content);
            list = Array.isArray(parsed) ? parsed : parsed.subtitles;
            if (!Array.isArray(list)) throw new Error('JSON must be an array of subtitles.');
          } else {
            list = subManager.parseSubtitleText(content); // handles both SRT and VTT
          }
          // An imported file is the words for this edit, not for one shape of
          // it, so it lands in every ratio.
          const count = setCaptionsEverywhere(list);
          if (count === 0) {
            toast(`No captions could be read from "${file.name}".`, 'warn');
          } else {
            toast(`Imported ${count} caption${count === 1 ? '' : 's'} from "${file.name}" `
              + 'into all four aspect ratios.', 'success', 6000);
          }
        } catch (err) {
          toast(`Could not read "${file.name}": ${err.message}`, 'error', 6000);
        }
        timelineController.resizeAndDraw();
      };
      reader.onerror = () => toast(`Could not read "${file.name}".`, 'error');
      reader.readAsText(file);
      e.target.value = '';
    });

    // Premiere Preset Import (.prfpset / .prtextstyle / .xml / .json). Both
    // triggers live in the Style panel — the header's Import menu is for the
    // material of the job, not for the look of its captions.
    const presetInput = document.getElementById('presetFileInput');
    document.getElementById('btnImportPreset').addEventListener('click', () => {
      presetInput.click();
    });
    document.getElementById('btnImportPresetFromLibrary').addEventListener('click', () => {
      presetInput.click();
    });

    presetInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      readPresetFile(file);
      e.target.value = '';
    });

    // Exports
    const withSpeakers = () =>
      ({ speakers: document.getElementById('exportSpeakerNames').checked });

    document.getElementById('btnExportSrt').addEventListener('click', () => {
      if (!requireCaptions()) return;
      saveTextFile(subManager.exportSRT(withSpeakers()), exportName('.srt'), 'text/plain');
    });

    document.getElementById('btnExportVtt').addEventListener('click', () => {
      if (!requireCaptions()) return;
      saveTextFile(subManager.exportVTT(withSpeakers()), exportName('.vtt'), 'text/vtt');
    });

    document.getElementById('btnExportXml').addEventListener('click', () => {
      if (!requireCaptions()) return;
      saveTextFile(subManager.exportPremiereXml(playerController.project),
        exportName('_sequence.xml'), 'application/xml');
    });

    document.getElementById('btnExportPreset').addEventListener('click', () => {
      const preset = playerController.activePreset;
      const xmlStr = presetParser.exportPresetToXml(preset);
      const safeName = (preset.name || 'style').replace(/[^\w\-. ]+/g, '_');
      saveTextFile(xmlStr, `${safeName}.prfpset`, 'application/xml');
    });

    // Shortcuts Modal Toggle
    const shortcutsModal = document.getElementById('shortcutsModal');
    document.getElementById('btnShortcuts').addEventListener('click', () => {
      shortcutsModal.classList.remove('hidden');
    });
    document.getElementById('btnCloseModal').addEventListener('click', () => {
      shortcutsModal.classList.add('hidden');
    });
    shortcutsModal.addEventListener('click', (e) => {
      if (e.target === shortcutsModal) shortcutsModal.classList.add('hidden');
    });

    // Transport Bar & Extended Navigation
    document.getElementById('btnPlayPause').addEventListener('click', () => {
      playerController.togglePlay();
      updatePlayIcons();
    });

    document.getElementById('btnStepBack').addEventListener('click', () => {
      playerController.stepFrame(-1);
      updatePlayIcons();
    });

    document.getElementById('btnStepForward').addEventListener('click', () => {
      playerController.stepFrame(1);
      updatePlayIcons();
    });

    document.getElementById('btnPrevSub').addEventListener('click', () => {
      playerController.jumpToPrevSubtitle();
    });

    document.getElementById('btnNextSub').addEventListener('click', () => {
      playerController.jumpToNextSubtitle();
    });

    const loopBtn = document.getElementById('btnLoopRegion');
    loopBtn.addEventListener('click', () => {
      const isLooping = playerController.toggleLoopRegion();
      loopBtn.classList.toggle('active', isLooping);
      if (isLooping && !subManager.selectedId) {
        toast('Loop is armed — select a caption to loop over its region.', 'warn');
      }
    });

    const safeBtn = document.getElementById('btnSafeGuides');
    safeBtn.addEventListener('click', () => toggleSafeGuides());

    document.getElementById('btnFullscreen').addEventListener('click', () => {
      playerController.toggleFullscreen();
    });

    document.getElementById('playbackSpeedSelect').addEventListener('change', (e) => {
      playerController.setSpeed(e.target.value);
    });

    // Viewport Drag & Drop Media Upload
    const viewport = document.getElementById('viewportContainer');
    const dropzone = document.getElementById('dropzoneOverlay');

    viewport.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.remove('hidden');
    });

    viewport.addEventListener('dragleave', (e) => {
      if (!viewport.contains(e.relatedTarget)) {
        dropzone.classList.add('hidden');
      }
    });

    viewport.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.add('hidden');
      const files = e.dataTransfer.files;
      if (!files || !files[0]) return;

      const file = files[0];
      const lower = file.name.toLowerCase();
      if (lower.endsWith(PROJECT_EXT)) {
        if (!confirmDiscard('Open the dropped project')) return;
        const reader = new FileReader();
        reader.onload = (evt) => adoptProjectText(evt.target.result, '');
        reader.onerror = () => toast(`Could not read "${file.name}".`, 'error');
        reader.readAsText(file);
      } else if (/\.(srt|vtt)$/.test(lower)) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          const count = setCaptionsEverywhere(subManager.parseSubtitleText(evt.target.result));
          toast(count
            ? `Imported ${count} captions from "${file.name}" into all four aspect ratios.`
            : `No captions could be read from "${file.name}".`, count ? 'success' : 'warn', 6000);
        };
        reader.readAsText(file);
      } else if (/\.(prfpset|prtextstyle|xml)$/.test(lower)) {
        readPresetFile(file);
      } else {
        handleMediaFile(file);
      }
    });

    // Sync Playhead Timecodes
    playerController.onTimeUpdate((curr, dur) => {
      const tc = subManager.secondsToTimecode(curr, FPS);
      const durTc = subManager.secondsToTimecode(dur || 0, FPS);

      document.getElementById('headerTimecode').textContent = tc;
      document.getElementById('currentTimecode').textContent = tc;
      document.getElementById('durationTimecode').textContent = durTc;
      updatePlayIcons();
      highlightActiveCaption(curr);
    });
  }

  function handleMediaFile(file) {
    attachMediaToFilm(project.activeId, file, { fresh: true });
    toast(`Loaded "${file.name}" into "${project.getActive().name}".`, 'success');
  }

  /**
   * Exports are named from the job and the edit. Three films in one project all
   * writing "subtitles.srt" into the same delivery folder is a real way to lose
   * a deliverable, and the operator has already named both things.
   */
  function exportName(suffix, ratioId) {
    const film = project.getActive();
    const job = ProjectManager.slug(project.name, 'project');
    const edit = ProjectManager.slug(film ? film.name : 'film', 'film');
    const ratio = ratioId || (film ? film.activeRatio : '');
    return `${job}_${edit}${ratio ? '_' + ratio : ''}${suffix}`;
  }

  function readPresetFile(file) {
    const reader = new FileReader();
    reader.onload = async (evt) => {
      const parsed = presetParser.parsePresetFile(evt.target.result, file.name);
      // Kept, not just applied: the file usually lives on the drive of whoever
      // built the Premiere sequence, and finding it a second time is the part
      // that wastes the operator's afternoon.
      const presetObj = presetLibrary.save(parsed, { source: 'premiere', fileName: file.name });
      refreshPresetLibraryUI(presetObj.id);
      applyPresetToUI(presetObj);
      playerController.applyPreset(presetObj);
      toast(presetLibrary.lastWriteOk
        ? `Imported "${presetObj.name}" — saved to your preset library.`
        : `Imported "${presetObj.name}" — this browser refused to store it, so it lasts this session only.`,
        presetLibrary.lastWriteOk ? 'success' : 'warn', presetLibrary.lastWriteOk ? 4200 : 7000);

      // The named face is usually a licensed brand font rather than a web font.
      // Loading it from the system is what makes the preview match Premiere, so
      // say plainly when it is missing instead of drawing the wrong typeface.
      const wanted = presetObj.fontPostScriptName || presetObj.fontFamily;
      if (!wanted) return;
      const result = await fontLoader.ensure(wanted);
      if (result.ok) {
        // setPreset re-renders, so the preview picks up the real face here. The
        // resolved face goes back into the library too, so the next launch
        // starts from the name that actually drew rather than the one the file
        // asked for.
        const resolved = { ...presetObj, fontPostScriptName: result.family };
        presetLibrary.save(resolved, { source: 'premiere', fileName: file.name });
        presetParser.addPreset(resolved);
        playerController.applyPreset(resolved);
      } else if (result.source === 'not-installed') {
        toast(`"${wanted}" is not installed on this machine — captions will not ` +
              `match Premiere until you install it.`, 'warn', 8000);
      }
    };
    reader.onerror = () => toast(`Could not read "${file.name}".`, 'error');
    reader.readAsText(file);
  }

  function requireCaptions() {
    if (subManager.getSubtitles().length === 0) {
      toast('There are no captions to export yet.', 'warn');
      return false;
    }
    return true;
  }

  function updatePlayIcons() {
    const playIcon = document.getElementById('playIcon');
    const pauseIcon = document.getElementById('pauseIcon');
    playIcon.classList.toggle('hidden', playerController.isPlaying);
    pauseIcon.classList.toggle('hidden', !playerController.isPlaying);
  }

  // --- Safe-area guides ---
  /**
   * Visibility and guide set are separate questions. `G` toggles whether the
   * guides are drawn at all; the dropdown beside it chooses which set, and that
   * choice belongs to the ratio — EBU on the 16:9 deliverable, TikTok on the
   * vertical one — so it is stored per ratio and comes back with it.
   */
  function toggleSafeGuides() {
    const guides = document.getElementById('safeGuides');
    const btn = document.getElementById('btnSafeGuides');
    const nowVisible = guides.classList.toggle('hidden') === false;
    btn.classList.toggle('active', nowVisible);
    if (nowVisible) renderGuides();
    return nowVisible;
  }

  function currentGuideSetId() {
    const select = document.getElementById('safeGuideSelect');
    return (select && select.value) || 'generic';
  }

  function populateGuideSelect(ratioId, wantedId) {
    const select = document.getElementById('safeGuideSelect');
    if (!select) return;

    const sets = safeAreaSetsFor(ratioId);
    select.innerHTML = '';
    sets.forEach(set => {
      const opt = document.createElement('option');
      opt.value = set.id;
      // The asterisk marks a set measured off a live interface rather than
      // published by the platform. The title carries the full provenance.
      opt.textContent = set.label + (set.source === 'practical' ? ' *' : '');
      opt.title = set.note;
      select.appendChild(opt);
    });

    // A set offered for 9:16 is not offered for 16:9, so a remembered choice
    // can be unavailable after a ratio switch. Fall back rather than blank.
    select.value = sets.some(set => set.id === wantedId) ? wantedId : 'generic';
    select.title = getSafeAreaSet(select.value).note;
  }

  function renderGuides() {
    const container = document.getElementById('safeGuides');
    if (!container || container.classList.contains('hidden')) return;
    renderSafeAreas(container, currentGuideSetId(), playerController.project.id);
  }

  // --- Aspect ratio switching ---
  /**
   * The ratio buttons no longer change a property of the film — they choose
   * which of the film's caption sets is being edited and previewed. A film is
   * an edit; it is delivered in every shape.
   */
  function bindAspectRatioControls() {
    const buttons = document.querySelectorAll('.aspect-btn');

    buttons.forEach(btn => {
      btn.addEventListener('click', () => switchRatio(btn.dataset.aspect));
    });

    document.getElementById('safeGuideSelect').addEventListener('change', () => {
      const ratio = project.getActiveRatio();
      if (ratio) ratio.guides = currentGuideSetId();
      document.getElementById('safeGuideSelect').title = getSafeAreaSet(currentGuideSetId()).note;
      // Choosing a set is a request to look at it.
      const container = document.getElementById('safeGuides');
      if (container.classList.contains('hidden')) toggleSafeGuides();
      else renderGuides();
      project.markDirty();
      scheduleAutosave();
    });

    playerController.onProjectChange((proj) => {
      document.getElementById('projectResLabel').textContent = `${proj.width}×${proj.height}`;
      buttons.forEach(b => b.classList.toggle('active', b.dataset.aspect === proj.id));
      renderGuides();
    });

    // Publish the initial state through the same path
    playerController.setAspectRatio('16x9');
  }

  /** Caption counts on the ratio buttons, plus the badge over the caption list. */
  function renderRatioUI() {
    const film = project.getActive();
    if (!film) return;
    const label = (id) => id.replace('x', ':');

    document.querySelectorAll('.aspect-btn').forEach(btn => {
      const rid = btn.dataset.aspect;
      const isActive = rid === film.activeRatio;
      const count = isActive
        ? subManager.getSubtitles().length
        : project.captionCount(film.id, rid);
      const counter = btn.querySelector('.aspect-count');
      if (counter) counter.textContent = count ? String(count) : '';
      btn.title = `${label(rid)} — ${count} caption${count === 1 ? '' : 's'}`
        + (count ? '' : ' (empty — nothing to export in this ratio yet)');
    });

    const badge = document.getElementById('captionsRatioBadge');
    if (badge) {
      badge.textContent = label(film.activeRatio);
      badge.title = `Editing the ${label(film.activeRatio)} captions of "${film.name}". `
        + 'Each ratio keeps its own line breaks.';
    }
  }

  // --- Left Captions Sidebar ---
  function bindCaptionsListUI() {
    const listContainer = document.getElementById('captionsList');
    const countBadge = document.getElementById('subCountBadge');
    const searchInput = document.getElementById('subSearchInput');

    subManager.onChange((subs, selectedId) => {
      renderCaptionsList(subs, selectedId);
    });

    document.getElementById('btnAddSubtitle').addEventListener('click', () => {
      const curr = playerController.getCurrentTime();
      const sub = subManager.addSubtitle(curr, curr + 3.0, 'New Caption Line');
      // Drop focus straight into the new line's text box
      requestAnimationFrame(() => {
        const ta = listContainer.querySelector(`.caption-item[data-id="${sub.id}"] .caption-textarea`);
        if (ta) { ta.focus(); ta.select(); }
      });
    });

    document.getElementById('btnSplitSubtitle').addEventListener('click', () => {
      if (!subManager.selectedId) {
        toast('Select a caption first, then park the playhead where it should split.', 'warn');
        return;
      }
      const ok = subManager.splitSubtitleAt(subManager.selectedId, playerController.getCurrentTime());
      if (!ok) toast('Move the playhead inside the selected caption to split it.', 'warn');
    });

    document.getElementById('btnMergeSubtitle').addEventListener('click', () => {
      if (!subManager.selectedId) {
        toast('Select a caption line to merge it with the next one.', 'warn');
        return;
      }
      const ok = subManager.mergeSubtitle(subManager.selectedId);
      if (!ok) toast('The last caption has nothing after it to merge with.', 'warn');
    });

    document.getElementById('btnRippleDelete').addEventListener('click', () => {
      if (!subManager.selectedId) {
        toast('Select a caption line to ripple delete it.', 'warn');
        return;
      }
      subManager.rippleDeleteSubtitle(subManager.selectedId);
    });

    document.getElementById('btnShiftTimecodes').addEventListener('click', () => {
      const val = prompt('Shift all subtitle timecodes by (seconds, e.g. +1.5 or -0.5):', '+1.0');
      if (val === null) return;
      const offsetSec = parseFloat(val);
      if (isNaN(offsetSec)) {
        toast(`"${val}" is not a number of seconds.`, 'error');
        return;
      }
      subManager.shiftAllTimecodes(offsetSec);
      toast(`Shifted all captions by ${offsetSec > 0 ? '+' : ''}${offsetSec}s.`, 'success');
    });

    document.getElementById('btnClearAll').addEventListener('click', () => {
      if (subManager.getSubtitles().length === 0) {
        toast('There are no captions to clear.', 'warn');
        return;
      }
      if (confirm('Are you sure you want to clear all captions?')) {
        subManager.clearAll();
        toast('All captions cleared.', 'success');
      }
    });

    searchInput.addEventListener('input', () => {
      renderCaptionsList(subManager.getSubtitles(), subManager.selectedId);
    });

    let isRestoringFocus = false;
    let reviewOnly = false;

    const reviewBtn = document.getElementById('btnReviewFilter');
    reviewBtn.addEventListener('click', () => {
      reviewOnly = !reviewOnly;
      reviewBtn.classList.toggle('active', reviewOnly);
      renderCaptionsList(subManager.getSubtitles(), subManager.selectedId);
    });

    /**
     * The review control only appears once a transcription has actually reported
     * confidence — hand-authored captions have none, and an engine that returns
     * a constant 1.0 must not produce a review list built on nothing.
     */
    function updateReviewButton(subs) {
      const count = subs.filter(s => s.uncertain && s.uncertain.length).length;
      document.getElementById('reviewCount').textContent = count;
      reviewBtn.classList.toggle('hidden', count === 0);
      if (count === 0 && reviewOnly) {
        reviewOnly = false;
        reviewBtn.classList.remove('active');
      }
    }

    function renderCaptionsList(subs, selectedId) {
      // Preserve focus/caret across re-renders so typing is not interrupted.
      const active = document.activeElement;
      const focusInfo = active && active.closest && active.closest('.caption-item') ? {
        id: active.closest('.caption-item').dataset.id,
        cls: active.className,
        selStart: active.selectionStart,
        selEnd: active.selectionEnd
      } : null;

      listContainer.innerHTML = '';

      // Resolve the review state before filtering on it. Done afterwards, a
      // render that discovers the last uncertain caption has gone still filters
      // the whole list away, leaving an empty panel and no visible control to
      // get back.
      updateReviewButton(subs);

      const filterTerm = searchInput.value.toLowerCase().trim();
      let filtered = subs.filter(s =>
        s.text.toLowerCase().includes(filterTerm) ||
        (s.speaker && s.speaker.toLowerCase().includes(filterTerm)));

      if (reviewOnly) filtered = filtered.filter(s => s.uncertain && s.uncertain.length);

      // The speaker field only earns its space once something has labelled the
      // captions — but the selected line always offers one, so a track can be
      // labelled by hand without transcribing it first.
      const anySpeakers = subs.some(s => s.speaker);

      countBadge.textContent = `${filtered.length} line${filtered.length === 1 ? '' : 's'}`;
      updateReviewButton(subs);

      filtered.forEach((sub) => {
        const trueIndex = subs.indexOf(sub);
        const uncertain = (sub.uncertain && sub.uncertain.length) ? sub.uncertain : null;
        const itemEl = document.createElement('div');
        itemEl.className = [
          'caption-item',
          sub.id === selectedId ? 'active' : '',
          uncertain ? 'uncertain' : ''
        ].filter(Boolean).join(' ');
        itemEl.dataset.id = sub.id;

        const startTc = subManager.secondsToTimecode(sub.start, FPS);
        const endTc = subManager.secondsToTimecode(sub.end, FPS);

        itemEl.innerHTML = `
          <div class="caption-meta">
            <span class="caption-index">#${trueIndex + 1}</span>
            <div class="caption-tc-inputs">
              <input type="text" class="tc-input start-tc" value="${startTc}" title="In Point (HH:MM:SS:FF)">
              <span>→</span>
              <input type="text" class="tc-input end-tc" value="${endTc}" title="Out Point (HH:MM:SS:FF)">
            </div>
            ${uncertain ? `<span class="caption-confidence" title="Unsure about: ${escapeHtml(uncertain.join(', '))}">?${uncertain.length}</span>` : ''}
            <button class="caption-delete-btn" title="Delete Line">✕</button>
          </div>
          ${(anySpeakers || sub.id === selectedId) ? `<input type="text" class="caption-speaker" value="${escapeHtml(sub.speaker || '')}"
             placeholder="Speaker" title="Who says this line. Renaming updates every line by this person.">` : ''}
          <textarea class="caption-textarea" placeholder="Caption text...">${escapeHtml(sub.text)}</textarea>
        `;

        // Click to select & jump video
        itemEl.addEventListener('click', (e) => {
          if (!['INPUT', 'TEXTAREA', 'BUTTON'].includes(e.target.tagName)) {
            subManager.selectSubtitle(sub.id);
            playerController.seek(sub.start);
          }
        });

        // Timecode Edits
        const startInput = itemEl.querySelector('.start-tc');
        const endInput = itemEl.querySelector('.end-tc');
        startInput.addEventListener('change', () => {
          const newStart = subManager.timecodeToSeconds(startInput.value, FPS);
          subManager.updateSubtitle(sub.id, { start: newStart });
        });
        endInput.addEventListener('change', () => {
          const newEnd = subManager.timecodeToSeconds(endInput.value, FPS);
          subManager.updateSubtitle(sub.id, { end: newEnd });
        });

        // Text Edit — update the model without re-rendering the whole list
        const textarea = itemEl.querySelector('.caption-textarea');
        textarea.addEventListener('input', () => {
          subManager.updateSubtitle(sub.id, { text: textarea.value }, { silent: true });
          playerController.renderOverlay();
          const clip = subtitleTrackContent.querySelector(`.subtitle-clip[data-id="${sub.id}"] .clip-text`);
          if (clip) clip.textContent = textarea.value || '(empty)';
        });
        textarea.addEventListener('focus', () => {
          if (isRestoringFocus) return; // programmatic re-focus, not a user action
          subManager.selectSubtitle(sub.id);
        });

        // Speaker — renaming one line renames the person everywhere, since
        // "Speaker 2" is a placeholder for someone with a real name, and fixing
        // it eighty times by hand is not an edit anyone would choose to make.
        const speakerInput = itemEl.querySelector('.caption-speaker');
        if (speakerInput) {
          speakerInput.addEventListener('change', () => {
            const name = speakerInput.value.trim();
            const previous = sub.speaker || '';
            if (name === previous) return;

            const affected = previous
              ? subManager.getSubtitles().filter(s => s.speaker === previous)
              : [sub];
            affected.forEach(s => subManager.updateSubtitle(s.id, { speaker: name }, { silent: true }));
            renderCaptionsList(subManager.getSubtitles(), subManager.selectedId);
            project.markDirty();
            scheduleAutosave();

            if (affected.length > 1) {
              toast(`Renamed ${affected.length} lines from "${previous}" to "${name || 'no speaker'}".`,
                'success');
            }
          });
        }

        // Delete
        itemEl.querySelector('.caption-delete-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          subManager.deleteSubtitle(sub.id);
        });

        listContainer.appendChild(itemEl);
      });

      // Nothing to show is two different situations, and the way out of each
      // is different: a project with no captions yet needs a transcription or
      // an import, a filtered list needs the filter cleared.
      if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'caption-empty';
        empty.innerHTML = subs.length
          ? `<p class="caption-empty-title">No matching lines</p>
             <p class="caption-empty-hint">${reviewOnly
               ? 'Nothing in this ratio is flagged for review.'
               : 'No caption in this ratio matches the search.'}</p>`
          : `<p class="caption-empty-title">No captions yet</p>
             <p class="caption-empty-hint">Transcribe the audio, import an .srt or .vtt,
                or add a line by hand to start captioning this film.</p>`;
        listContainer.appendChild(empty);
      }

      if (focusInfo) {
        const restored = listContainer.querySelector(
          `.caption-item[data-id="${focusInfo.id}"] .${focusInfo.cls.split(' ').join('.')}`);
        if (restored) {
          isRestoringFocus = true;
          restored.focus();
          try { restored.setSelectionRange(focusInfo.selStart, focusInfo.selEnd); } catch (e) { /* not a text field */ }
          isRestoringFocus = false;
        }
      }
    }
  }

  /** Highlights the caption currently on screen (Premiere-style follow). */
  let lastHighlightedId = null;
  function highlightActiveCaption(currentTime) {
    const active = subManager.getActiveSubtitleAt(currentTime);
    const id = active ? active.id : null;
    if (id === lastHighlightedId) return;
    lastHighlightedId = id;

    document.querySelectorAll('.caption-item').forEach(el => {
      el.classList.toggle('playing', el.dataset.id === id);
    });
  }

  // --- Right Style & Preset Inspector ---
  function bindStyleInspectorUI() {
    const presetSelect = document.getElementById('presetSelect');

    presetSelect.addEventListener('change', (e) => {
      const presetObj = presetParser.getPreset(e.target.value);
      applyPresetToUI(presetObj);
      playerController.applyPreset(presetObj);
    });

    document.getElementById('btnResetStyle').addEventListener('click', () => {
      const presetObj = presetParser.getPreset(presetSelect.value);
      applyPresetToUI(presetObj);
      playerController.applyPreset(presetObj);
      toast(`Reset to "${presetObj.name}".`, 'success');
    });

    document.getElementById('btnSaveCustomPreset').addEventListener('click', () => {
      const suggested = playerController.activePreset.name || 'My Premiere Style';
      const name = prompt('Enter a name for this preset:', suggested);
      if (!name) return;
      // Saving over a name already in the library replaces that entry, so
      // iterating on a style does not leave six near-identical presets behind.
      const entry = presetLibrary.save({ ...playerController.activePreset, name }, { source: 'custom' });
      refreshPresetLibraryUI(entry.id);
      playerController.applyPreset(entry);
      toast(presetLibrary.lastWriteOk
        ? `Saved "${entry.name}" to your preset library.`
        : `Saved "${entry.name}" for this session — this browser refused to store the library.`,
        presetLibrary.lastWriteOk ? 'success' : 'warn');
    });

    const inputs = {
      fontFamily: document.getElementById('fontFamily'),
      fontSize: document.getElementById('fontSize'),
      letterSpacing: document.getElementById('letterSpacing'),
      lineHeight: document.getElementById('lineHeight'),
      fontWeightBold: document.getElementById('fontWeightBold'),
      fontStyleItalic: document.getElementById('fontStyleItalic'),
      textUppercase: document.getElementById('textUppercase'),
      fillColor: document.getElementById('fillColor'),
      enableStroke: document.getElementById('enableStroke'),
      strokeColor: document.getElementById('strokeColor'),
      strokeWidth: document.getElementById('strokeWidth'),
      enableBgBox: document.getElementById('enableBgBox'),
      bgBoxColor: document.getElementById('bgBoxColor'),
      bgBoxOpacity: document.getElementById('bgBoxOpacity'),
      bgBoxPadding: document.getElementById('bgBoxPadding'),
      enableShadow: document.getElementById('enableShadow'),
      shadowColor: document.getElementById('shadowColor'),
      shadowBlur: document.getElementById('shadowBlur'),
      shadowOffsetY: document.getElementById('shadowOffsetY'),
      bottomMargin: document.getElementById('bottomMargin'),
      offsetX: document.getElementById('offsetX'),
      offsetY: document.getElementById('offsetY'),
      animationPreset: document.getElementById('animationPreset')
    };

    // Premiere's Position pair is a scrubber, so this one is too.
    Scrubbable.attach(inputs.offsetX);
    Scrubbable.attach(inputs.offsetY);

    // Range display text sync
    inputs.strokeWidth.addEventListener('input', (e) => document.getElementById('strokeWidthVal').textContent = `${e.target.value}px`);
    inputs.letterSpacing.addEventListener('input', (e) => document.getElementById('letterSpacingVal').textContent = `${e.target.value}`);
    inputs.lineHeight.addEventListener('input', (e) => document.getElementById('lineHeightVal').textContent = `${e.target.value}`);
    inputs.bgBoxOpacity.addEventListener('input', (e) => document.getElementById('bgBoxOpacityVal').textContent = `${e.target.value}%`);
    inputs.bgBoxPadding.addEventListener('input', (e) => document.getElementById('bgBoxPaddingVal').textContent = `${e.target.value}px`);
    inputs.bottomMargin.addEventListener('input', (e) => document.getElementById('bottomMarginVal').textContent = `${e.target.value}px`);

    // Alignment buttons
    const alignBtns = document.querySelectorAll('.align-btn');
    alignBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        alignBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        readAndApplyInspectorChanges();
      });
    });

    Object.values(inputs).forEach(inputEl => {
      if (!inputEl) return;
      inputEl.addEventListener('input', readAndApplyInspectorChanges);
      inputEl.addEventListener('change', readAndApplyInspectorChanges);
    });

    function readAndApplyInspectorChanges() {
      const activeAlignBtn = document.querySelector('.align-btn.active');
      playerController.setPreset({
        name: playerController.activePreset.name || 'Custom Style',
        fontFamily: inputs.fontFamily.value,
        // Only meaningful while the family is untouched; editing the family box
        // means the operator has chosen a different face than the file named.
        fontPostScriptName: inputs.fontFamily.value === playerController.activePreset.fontFamily
          ? (playerController.activePreset.fontPostScriptName || '') : '',
        fontSize: parseInt(inputs.fontSize.value, 10) || 42,
        letterSpacing: parseFloat(inputs.letterSpacing.value) || 0,
        lineHeight: parseFloat(inputs.lineHeight.value) || 1.25,
        fontWeightBold: inputs.fontWeightBold.checked,
        fontStyleItalic: inputs.fontStyleItalic.checked,
        textUppercase: inputs.textUppercase.checked,
        fillColor: inputs.fillColor.value,
        enableStroke: inputs.enableStroke.checked,
        strokeColor: inputs.strokeColor.value,
        strokeWidth: parseInt(inputs.strokeWidth.value, 10) || 0,
        enableBgBox: inputs.enableBgBox.checked,
        bgBoxColor: inputs.bgBoxColor.value,
        bgBoxOpacity: parseInt(inputs.bgBoxOpacity.value, 10) || 0,
        bgBoxPadding: parseInt(inputs.bgBoxPadding.value, 10) || 0,
        enableShadow: inputs.enableShadow.checked,
        shadowColor: inputs.shadowColor.value,
        shadowBlur: parseInt(inputs.shadowBlur.value, 10) || 0,
        shadowOffsetY: parseInt(inputs.shadowOffsetY.value, 10) || 0,
        align: activeAlignBtn ? activeAlignBtn.dataset.align : 'bottom-center',
        bottomMargin: parseInt(inputs.bottomMargin.value, 10) || 0,
        offsetX: parseInt(inputs.offsetX.value, 10) || 0,
        offsetY: parseInt(inputs.offsetY.value, 10) || 0,
        animationPreset: inputs.animationPreset.value
      });
    }
  }

  /**
   * Mirrors the saved library into the "Your library" group of the preset
   * dropdown, and registers every entry with the parser so a film that
   * references a saved style by id still resolves after a restart.
   *
   * Deleting an entry does not un-register it for this session: a film already
   * wearing that style keeps drawing it until the app is reopened.
   *
   * @param {string} [selectId] id to leave selected once the group is rebuilt.
   */
  function refreshPresetLibraryUI(selectId) {
    const select = document.getElementById('presetSelect');
    const group = document.getElementById('presetGroupLibrary');
    if (!select || !group) return;

    const entries = presetLibrary.list();
    group.innerHTML = '';
    entries.forEach(entry => {
      presetParser.addPreset(entry);
      const opt = document.createElement('option');
      opt.value = entry.id;
      opt.textContent = `${entry.name} (${entry.source === 'premiere' ? 'Premiere' : 'Custom'})`;
      group.appendChild(opt);
    });
    group.hidden = entries.length === 0;

    if (selectId && select.querySelector(`option[value="${selectId}"]`)) select.value = selectId;
  }

  // --- Preset library dialog ---
  function bindPresetLibraryUI() {
    const modal = document.getElementById('presetLibraryModal');
    const close = () => modal.classList.add('hidden');

    document.getElementById('btnPresetLibrary').addEventListener('click', () => {
      renderPresetLibrary();
      modal.classList.remove('hidden');
    });
    document.getElementById('btnClosePresetLibrary').addEventListener('click', close);
    document.getElementById('btnClosePresetLibraryFooter').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  }

  /** One row per saved style: how it looks, where it came from, what to do with it. */
  function renderPresetLibrary() {
    const list = document.getElementById('presetLibraryList');
    if (!list) return;

    const entries = presetLibrary.list();
    list.innerHTML = '';

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'preset-library-empty';
      empty.textContent = 'Nothing saved yet. Import a Premiere preset, or style the '
        + 'captions and press “+ Save” to keep that look for the next job.';
      list.appendChild(empty);
      return;
    }

    const activeId = playerController.activePreset && playerController.activePreset.id;

    entries.forEach(entry => {
      const row = document.createElement('div');
      row.className = 'preset-library-row' + (entry.id === activeId ? ' active' : '');
      row.appendChild(presetSwatch(entry));

      const meta = document.createElement('div');
      meta.className = 'preset-library-meta';

      const name = document.createElement('div');
      name.className = 'preset-library-name';
      name.textContent = entry.name;
      meta.appendChild(name);

      const sub = document.createElement('div');
      sub.className = 'preset-library-sub';
      const tag = document.createElement('span');
      tag.className = 'preset-library-tag' + (entry.source === 'premiere' ? ' premiere' : '');
      tag.textContent = entry.source === 'premiere' ? 'Premiere' : 'Custom';
      sub.appendChild(tag);
      sub.appendChild(document.createTextNode(describePresetEntry(entry)));
      sub.title = entry.fileName || '';
      meta.appendChild(sub);
      row.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'preset-library-actions';

      const applyBtn = document.createElement('button');
      applyBtn.className = 'btn-xs btn-primary';
      applyBtn.textContent = 'Apply';
      applyBtn.title = 'Use this style on the current film';
      applyBtn.addEventListener('click', () => {
        applyPresetToUI(entry);
        playerController.applyPreset(entry);
        refreshPresetLibraryUI(entry.id);
        renderPresetLibrary();
        toast(`Applied "${entry.name}".`, 'success');
      });
      actions.appendChild(applyBtn);

      const renameBtn = document.createElement('button');
      renameBtn.className = 'btn-xs btn-outline';
      renameBtn.textContent = 'Rename';
      renameBtn.addEventListener('click', () => {
        const next = prompt('Rename this preset:', entry.name);
        if (!next || next.trim() === entry.name) return;
        presetLibrary.rename(entry.id, next);
        refreshPresetLibraryUI();
        renderPresetLibrary();
      });
      actions.appendChild(renameBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn-icon btn-icon-danger';
      delBtn.title = 'Remove from library';
      delBtn.innerHTML = '<svg class="icon"><use href="#i-trash"/></svg>';
      delBtn.addEventListener('click', () => {
        if (!confirm(`Remove "${entry.name}" from your preset library?`)) return;
        const wasActive = entry.id === (playerController.activePreset || {}).id;
        presetLibrary.remove(entry.id);
        refreshPresetLibraryUI();
        renderPresetLibrary();
        // Removing it from the library does not strip it off the film, and the
        // dropdown can no longer show it — say so rather than let the panel and
        // the picture disagree in silence.
        toast(wasActive
          ? `Removed "${entry.name}". This film keeps that look until you choose another preset.`
          : `Removed "${entry.name}".`, 'info', wasActive ? 6000 : 4200);
      });
      actions.appendChild(delBtn);

      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  /** Draws the style back at the operator: fill, stroke, box, weight and case. */
  function presetSwatch(entry) {
    const swatch = document.createElement('div');
    swatch.className = 'preset-swatch';

    const sample = document.createElement('span');
    sample.textContent = entry.textUppercase ? 'AA' : 'Aa';
    sample.style.color = entry.fillColor || '#ffffff';
    sample.style.fontFamily = `"${(entry.fontFamily || 'Inter').replace(/"/g, '')}", sans-serif`;
    sample.style.fontWeight = entry.fontWeightBold ? '700' : '400';
    sample.style.fontStyle = entry.fontStyleItalic ? 'italic' : 'normal';
    if (entry.enableStroke) {
      sample.style.webkitTextStroke = `1px ${entry.strokeColor || '#000000'}`;
      // Painting the stroke over the glyph thins it; this keeps the fill on top.
      sample.style.paintOrder = 'stroke fill';
    }
    if (entry.enableBgBox) {
      const opacity = entry.bgBoxOpacity !== undefined ? entry.bgBoxOpacity : 75;
      sample.style.background = playerController.hexToRgba(entry.bgBoxColor || '#000000', opacity / 100);
    }
    swatch.appendChild(sample);
    return swatch;
  }

  function describePresetEntry(entry) {
    const bits = [`${entry.fontFamily || 'Inter'} ${entry.fontSize || 42}px`];
    if (entry.fileName) bits.push(entry.fileName);
    if (entry.savedAt) {
      const when = new Date(entry.savedAt);
      if (!isNaN(when)) {
        bits.push(when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }));
      }
    }
    return bits.join('  •  ');
  }

  function applyPresetToUI(preset) {
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
    const check = (id, value) => { const el = document.getElementById(id); if (el) el.checked = !!value; };

    // A preset arriving from an import or the library can be missing any field,
    // so every read falls back to the house default rather than to a second set
    // of numbers. Normalised first, so fields the built-in does not spell out
    // (tracking, leading, the Premiere offsets) still resolve to their default
    // rather than to undefined.
    const HOUSE = presetParser.normalizePreset(presetParser.getPreset('netflix_clean'));
    const num = (key) => (preset[key] !== undefined ? preset[key] : HOUSE[key]);

    set('fontFamily', preset.fontFamily || HOUSE.fontFamily);
    set('fontSize', num('fontSize'));
    set('letterSpacing', num('letterSpacing'));
    set('lineHeight', num('lineHeight'));
    check('fontWeightBold', preset.fontWeightBold);
    check('fontStyleItalic', preset.fontStyleItalic);
    check('textUppercase', preset.textUppercase);
    set('fillColor', preset.fillColor || HOUSE.fillColor);
    check('enableStroke', preset.enableStroke);
    set('strokeColor', preset.strokeColor || HOUSE.strokeColor);
    set('strokeWidth', num('strokeWidth'));
    check('enableBgBox', preset.enableBgBox);
    set('bgBoxColor', preset.bgBoxColor || HOUSE.bgBoxColor);
    set('bgBoxOpacity', num('bgBoxOpacity'));
    set('bgBoxPadding', num('bgBoxPadding'));
    check('enableShadow', preset.enableShadow);
    // <input type="color"> cannot hold rgba(), so normalise first.
    set('shadowColor', /^#[0-9a-f]{6}$/i.test(preset.shadowColor || '') ? preset.shadowColor : '#000000');
    set('shadowBlur', num('shadowBlur'));
    set('shadowOffsetY', num('shadowOffsetY'));
    set('bottomMargin', num('bottomMargin'));
    set('offsetX', num('offsetX'));
    set('offsetY', num('offsetY'));
    set('animationPreset', preset.animationPreset || 'none');

    document.getElementById('letterSpacingVal').textContent = `${num('letterSpacing')}`;
    document.getElementById('lineHeightVal').textContent = `${num('lineHeight')}`;
    document.getElementById('strokeWidthVal').textContent = `${num('strokeWidth')}px`;
    document.getElementById('bgBoxOpacityVal').textContent = `${num('bgBoxOpacity')}%`;
    document.getElementById('bgBoxPaddingVal').textContent = `${num('bgBoxPadding')}px`;
    document.getElementById('bottomMarginVal').textContent = `${num('bottomMargin')}px`;

    document.querySelectorAll('.align-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.align === (preset.align || 'bottom-center'));
    });
  }

  // --- Timeline Controls ---
  function bindTimelineToolbar() {
    const zoomSlider = document.getElementById('timelineZoom');
    zoomSlider.addEventListener('input', (e) => {
      timelineController.setZoom(parseFloat(e.target.value));
    });

    document.getElementById('btnZoomOut').addEventListener('click', () => zoomBy(-15));
    document.getElementById('btnZoomIn').addEventListener('click', () => zoomBy(15));

    // Track Toggles
    const muteBtn = document.getElementById('btnAudioMute');
    muteBtn.addEventListener('click', () => {
      const isMuted = playerController.toggleMute();
      muteBtn.classList.toggle('active', isMuted);
    });

    const soloBtn = document.getElementById('btnAudioSolo');
    soloBtn.addEventListener('click', () => {
      const isSolo = playerController.toggleSolo();
      soloBtn.classList.toggle('active', isSolo);
      if (isSolo && playerController.video.muted) {
        // Soloing audio while muted makes no sense — unmute for the user.
        playerController.toggleMute();
        muteBtn.classList.remove('active');
      }
    });

    const hideBtn = document.getElementById('btnSubHide');
    hideBtn.addEventListener('click', () => {
      const isHidden = playerController.toggleOverlayHide();
      hideBtn.classList.toggle('active', isHidden);
    });

    const lockBtn = document.getElementById('btnSubLock');
    lockBtn.addEventListener('click', () => {
      const locked = lockBtn.classList.toggle('active');
      subtitleTrackContent.style.pointerEvents = locked ? 'none' : 'auto';
      subtitleTrackContent.style.opacity = locked ? '0.6' : '1.0';
    });

    document.getElementById('snapToGrid').addEventListener('change', (e) => {
      toast(e.target.checked ? 'Snapping on.' : 'Snapping off.', 'info', 1600);
    });
  }

  function zoomBy(delta) {
    const zoomSlider = document.getElementById('timelineZoom');
    const next = Math.max(10, Math.min(200, parseFloat(zoomSlider.value) + delta));
    zoomSlider.value = next;
    timelineController.setZoom(next);
  }

  // --- ProRes / Alpha Export ---
  function bindExportModal() {
    const modal = document.getElementById('exportModal');
    const rangeSelect = document.getElementById('exportRangeSelect');
    const profileSelect = document.getElementById('exportProfileSelect');
    const startBtn = document.getElementById('btnStartExport');
    const cancelBtn = document.getElementById('btnCancelExport');
    const progressWrap = document.getElementById('exportProgressWrap');
    const progressBar = document.getElementById('exportProgressBar');
    const progressText = document.getElementById('exportProgressText');
    const note = document.getElementById('exportBackendNote');
    let running = false;

    const ratioPicker = document.getElementById('exportRatioPicker');
    const ratioBoxes = () => Array.from(ratioPicker.querySelectorAll('input[type=checkbox]'));
    const chosenRatios = () => ratioBoxes().filter(b => b.checked).map(b => b.value);

    /**
     * The ratios are caption variants of one edit, so a render run is "these
     * shapes of this film" — each gets its own pass and its own file.
     */
    function updateRatioPicker() {
      const film = project.getActive();
      if (!film) return;
      ratioBoxes().forEach(box => {
        const count = box.value === film.activeRatio
          ? subManager.getSubtitles().length
          : project.captionCount(film.id, box.value);
        const counter = box.parentElement.querySelector('.ratio-check-count');
        if (counter) counter.textContent = count ? String(count) : '—';
        // An empty ratio would render a file of nothing but transparency.
        box.disabled = count === 0;
        if (count === 0) box.checked = false;
        box.parentElement.title = count
          ? `${count} caption${count === 1 ? '' : 's'} in this ratio`
          : 'No captions in this ratio yet';
      });
    }

    function ratioSpan(film, ratioId) {
      const subs = ratioId === film.activeRatio
        ? subManager.getSubtitles()
        : film.ratios[ratioId].subtitles;
      if (rangeSelect.value !== 'captions') return playerController.getDuration();
      if (subs.length === 0) return 0;
      return Math.max(0, Math.max(...subs.map(x => x.end)) - Math.min(...subs.map(x => x.start)));
    }

    function updateEstimate() {
      const estimate = document.getElementById('exportFrameEstimate');
      const info = document.getElementById('exportResInfo');
      const film = project.getActive();
      const ratios = chosenRatios();
      const presets = playerController.getAspectPresets();

      if (info) {
        info.textContent = ratios.length
          ? ratios.map(r => `${presets[r].width}×${presets[r].height}`).join(', ')
          : 'Nothing selected';
      }

      const frames = film
        ? ratios.reduce((sum, r) => sum + Math.ceil(ratioSpan(film, r) * FPS), 0)
        : 0;
      estimate.textContent = frames > 0
        ? `${frames} frames across ${ratios.length} render${ratios.length === 1 ? '' : 's'}`
        : 'No captions to render';
      startBtn.disabled = frames <= 0;
      startBtn.textContent = ratios.length > 1
        ? `Render ${ratios.length} Exports`
        : 'Render Export';
    }

    function updateBackendNote() {
      if (exporter.hasNativeBackend()) {
        note.className = 'export-note';
        note.textContent = 'Native backend detected — ffmpeg will write a ProRes 4444 .mov with a real alpha channel.';
      } else {
        note.className = 'export-note warn';
        note.textContent =
          'Running without the desktop backend, so a ProRes .mov cannot be written directly. '
          + 'A ZIP of the transparent PNG sequence will be downloaded instead, together with the exact '
          + 'ffmpeg command to turn it into ProRes 4444. Launch via run_subtitler.sh for the one-click .mov export.';
      }
    }

    function openModal() {
      updateRatioPicker();
      // Default to the ratio on screen, if it has anything in it.
      const film = project.getActive();
      ratioBoxes().forEach(box => {
        box.checked = !box.disabled && film && box.value === film.activeRatio;
      });
      if (chosenRatios().length === 0) {
        ratioBoxes().forEach(box => { box.checked = !box.disabled; });
      }
      updateEstimate();
      updateBackendNote();
      progressWrap.classList.add('hidden');
      progressBar.style.width = '0%';
      modal.classList.remove('hidden');
    }

    function closeModal() {
      if (running) {
        exporter.cancel();
        running = false;
      }
      modal.classList.add('hidden');
    }

    document.getElementById('btnExportAlpha').addEventListener('click', openModal);
    document.getElementById('btnCloseExportModal').addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    rangeSelect.addEventListener('change', updateEstimate);
    ratioPicker.addEventListener('change', updateEstimate);
    document.getElementById('btnExportAllRatios').addEventListener('click', () => {
      ratioBoxes().forEach(box => { box.checked = !box.disabled; });
      updateEstimate();
    });
    playerController.onProjectChange(() => {
      if (!modal.classList.contains('hidden')) updateEstimate();
    });
    subManager.onChange(() => {
      if (modal.classList.contains('hidden')) return;
      updateRatioPicker();
      updateEstimate();
    });

    startBtn.addEventListener('click', async () => {
      if (running) return;
      const ratios = chosenRatios();
      if (ratios.length === 0) return;

      running = true;
      playerController.pause();
      startBtn.disabled = true;
      progressWrap.classList.remove('hidden');
      progressBar.style.width = '0%';
      progressText.textContent = 'Preparing…';

      const film = project.getActive();
      const startedOn = film.activeRatio;
      const done = [];
      let warnedFonts = false;

      try {
        // Each ratio is rendered by actually switching the editor to it. The
        // exporter draws with the same code as the Program Monitor, so routing
        // the batch through the real switch is what keeps every file in the set
        // a true match for what the operator approved on screen.
        for (let i = 0; i < ratios.length; i++) {
          if (film.activeRatio !== ratios[i]) switchRatio(ratios[i]);
          await new Promise(r => requestAnimationFrame(r));

          const label = ratios[i].replace('x', ':');
          const result = await exporter.export({
            rangeMode: rangeSelect.value,
            profile: parseInt(profileSelect.value, 10),
            padStart: 0.5,
            filename: exportName('_alpha.mov', ratios[i]),
            onFontWarning: (missing) => {
              if (warnedFonts) return;
              warnedFonts = true;
              toast(`"${missing.join(', ')}" is not available — the export will use the fallback typeface.`, 'warn', 7000);
            },
            onProgress: (frameDone, total, phase) => {
              const pct = total ? Math.round((frameDone / total) * 100) : 0;
              progressBar.style.width = `${pct}%`;
              progressText.textContent = ratios.length > 1
                ? `${label} (${i + 1}/${ratios.length}) — ${phase} ${frameDone}/${total} (${pct}%)`
                : `${phase} — ${frameDone}/${total} (${pct}%)`;
            }
          });
          done.push({ ratio: label, result });
        }

        const paths = done.filter(d => d.result.mode === 'prores').map(d => `${d.ratio}: ${d.result.path}`);
        toast(paths.length
          ? `ProRes 4444 with alpha written:\n${paths.join('\n')}`
          : `Exported ${done.length} transparent PNG sequence${done.length === 1 ? '' : 's'} as ZIP`
            + `${done.length === 1 ? '' : 's'}.\nSee ENCODE_TO_PRORES.txt inside for the ffmpeg command.`,
          'success', 9000);
        modal.classList.add('hidden');
      } catch (err) {
        progressText.textContent = err.message;
        note.className = 'export-note err';
        note.textContent = done.length
          ? `${err.message} (${done.length} of ${ratios.length} ratios were written before this.)`
          : err.message;
        toast(`Export failed: ${err.message}`, 'error', 8000);
      } finally {
        // Put the operator back on the ratio they were editing, whatever
        // happened — a failed batch must not leave them in a different frame.
        if (film.activeRatio !== startedOn) switchRatio(startedOn);
        running = false;
        startBtn.disabled = false;
        playerController.renderOverlay();
      }
    });
  }

  // --- AI Transcription ---
  /**
   * Fills the model dropdown from the backend registry. Only models that are
   * installed AND whose runtime is present can actually run, so anything else
   * is shown disabled with a pointer to Settings rather than silently failing
   * at transcribe time.
   */
  async function populateModelSelect() {
    const select = document.getElementById('transcribeModelSelect');
    if (!select) return;

    // Gate on the API this dropdown actually feeds, not on the settings panel's.
    if (!transcriber.hasBackend()) {
      select.innerHTML = '<option value="">Desktop backend required</option>';
      return;
    }

    try {
      if (!settings.models || settings.models.length === 0) {
        const probe = await transcriber.probe();
        settings.probe = probe;
        settings.models = probe.models || [];
        settings.aligner = probe.aligner || null;
      }
    } catch (e) {
      select.innerHTML = '<option value="">Could not read model list</option>';
      return;
    }

    const previous = select.value;
    const models = settings.models || [];
    const usable = models.filter(m => m.installed && m.engine_available);
    const rest = models.filter(m => !(m.installed && m.engine_available));

    select.innerHTML = '';

    if (usable.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No models installed — open Settings to install one';
      select.appendChild(opt);
    }

    const addGroup = (label, list, disabled) => {
      if (list.length === 0) return;
      const group = document.createElement('optgroup');
      group.label = label;
      list.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        const wer = m.wer ? ` · ${m.wer}% WER` : '';
        const gpu = (m.engine.indexOf('mlx') !== -1 || m.engine.indexOf('parakeet') !== -1) ? ' · GPU' : '';
        const eng = m.english_only ? ' · English only' : '';
        opt.textContent = `${m.label}${wer}${gpu}${eng}`;
        opt.disabled = !!disabled;
        group.appendChild(opt);
      });
      select.appendChild(group);
    };

    addGroup('Ready to use', usable, false);
    addGroup('Not installed — see Settings', rest, true);

    const custom = document.createElement('option');
    custom.value = '__custom__';
    custom.textContent = 'Custom Hugging Face model / local folder…';
    select.appendChild(custom);

    // Keep the previous choice, else the recommended model, else the first usable one.
    const wanted = [previous, settings.probe && settings.probe.recommended]
      .find(id => id && usable.some(m => m.id === id));
    select.value = wanted || (usable[0] ? usable[0].id : '');
    applyModelRules();
  }

  /** Re-segments the stored transcription and pushes it into the caption list. */
  function applyTranscription(result, opts = {}) {
    if (!result) return 0;
    // Remember it so the segmentation controls can re-cut the same
    // transcription without paying for another model run.
    lastTranscription = result;
    segmenter.updateSettings({
      maxCharsPerLine: opts.maxCharsPerLine,
      maxLines: opts.maxLines,
      maxDurationSec: opts.maxDurationSec,
      fps: FPS
    });

    const words = transcriber.collectWords(result);
    const captions = words.length
      ? segmenter.segment(words)
      : segmenter.segmentFromSegments(result.segments);

    if (captions.length === 0) return 0;

    // Tag each caption with the words the model was unsure about, so the review
    // filter can send the operator straight to them.
    const reported = !!(result.confidence && result.confidence.reported);
    captions.forEach(cap => {
      if (!reported || !Array.isArray(cap.words)) return;
      cap.uncertain = cap.words
        .filter(w => typeof w.confidence === 'number' && w.confidence < LOW_CONFIDENCE)
        .map(w => w.text);
    });

    if (opts.replace === false) {
      // Appending is an edit to the ratio in hand, not a fresh transcript, so
      // it stays where it was made.
      const existing = subManager.getSubtitles()
        .map(s => ({ start: s.start, end: s.end, text: s.text, speaker: s.speaker }));
      subManager.setSubtitles([...existing, ...captions]);
      timelineController.resizeAndDraw();
    } else {
      // One soundtrack, so every deliverable shape starts from the same words
      // and is re-flowed from there.
      setCaptionsEverywhere(captions);
    }

    return captions.length;
  }

  function bindTranscribeModal() {
    const modal = document.getElementById('transcribeModal');
    const modelSelect = document.getElementById('transcribeModelSelect');
    const customRow = document.getElementById('customModelRow');
    const customInput = document.getElementById('transcribeCustomModel');
    const startBtn = document.getElementById('btnStartTranscribe');
    const cancelBtn = document.getElementById('btnCancelTranscribe');
    const note = document.getElementById('transcribeBackendNote');
    const progressWrap = document.getElementById('transcribeProgressWrap');
    const progressBar = document.getElementById('transcribeProgressBar');
    const progressText = document.getElementById('transcribeProgressText');
    const mediaInfo = document.getElementById('transcribeMediaInfo');
    const modelNote = document.getElementById('transcribeModelNote');

    const audioSource = document.getElementById('transcribeAudioSource');
    const audioFileInput = document.getElementById('transcribeAudioFile');
    const audioFileName = document.getElementById('transcribeAudioFileName');
    const vocabulary = document.getElementById('transcribeVocabulary');
    let stemFile = null;

    // The term list is worth keeping between jobs: a house style list and the
    // client's product names rarely change from one deliverable to the next.
    const VOCAB_KEY = 'transcriber.vocabulary';
    try {
      const saved = localStorage.getItem(VOCAB_KEY);
      if (saved) vocabulary.value = saved;
    } catch (e) { /* private mode */ }
    vocabulary.addEventListener('change', () => {
      try { localStorage.setItem(VOCAB_KEY, vocabulary.value); } catch (e) { /* ignore */ }
    });

    audioSource.addEventListener('change', () => {
      document.getElementById('audioFileRow').classList.toggle('hidden', audioSource.value !== 'file');
      if (audioSource.value === 'program') {
        stemFile = null;
        audioFileName.textContent = 'No file chosen';
      }
    });
    document.getElementById('btnChooseAudioFile')
      .addEventListener('click', () => audioFileInput.click());
    audioFileInput.addEventListener('change', (e) => {
      stemFile = e.target.files[0] || null;
      audioFileName.textContent = stemFile ? stemFile.name : 'No file chosen';
      e.target.value = '';
    });

    const diarizeToggle = document.getElementById('transcribeDiarize');
    const speakerCount = document.getElementById('transcribeSpeakerCount');
    const diarizeNote = document.getElementById('transcribeDiarizeNote');

    // The count only means anything once separation is on.
    diarizeToggle.addEventListener('change', () => {
      speakerCount.disabled = !diarizeToggle.checked;
    });
    speakerCount.disabled = true;

    const segChars = document.getElementById('segMaxChars');
    const segLines = document.getElementById('segMaxLines');
    const segDur = document.getElementById('segMaxDur');
    let running = false;

    segChars.addEventListener('input', () => {
      document.getElementById('segMaxCharsVal').textContent = segChars.value;
      reSegmentIfPossible();
    });
    segDur.addEventListener('input', () => {
      document.getElementById('segMaxDurVal').textContent = `${parseFloat(segDur.value).toFixed(1)}s`;
      reSegmentIfPossible();
    });
    segLines.addEventListener('change', reSegmentIfPossible);

    /** Live re-cut of an existing transcription — no model run required. */
    function reSegmentIfPossible() {
      if (running || !lastTranscription) return;
      const n = applyTranscription(lastTranscription, readSegmentSettings());
      if (n) progressText.textContent = `Re-segmented into ${n} captions.`;
    }

    function readSegmentSettings() {
      return {
        ...readSegmentUI(),
        replace: document.getElementById('transcribeReplace').checked
      };
    }

    modelSelect.addEventListener('change', () => {
      customRow.classList.toggle('hidden', modelSelect.value !== '__custom__');
      applyModelLanguageRules();
    });

    /**
     * Keeps the language picker honest about the selected model.
     * An English-only model paired with, say, Japanese returns confident
     * nonsense rather than an error, so those options are disabled outright.
     */
    function applyModelLanguageRules() {
      const langSelect = document.getElementById('transcribeLanguage');
      const alignSelect = document.getElementById('transcribeAlign');
      const model = (settings.models || []).find(m => m.id === modelSelect.value);

      const englishOnly = !!(model && model.english_only);
      Array.from(langSelect.options).forEach(opt => {
        const blocked = englishOnly && opt.value !== 'en';
        opt.disabled = blocked;
        opt.textContent = opt.textContent.replace(/ — unavailable.*$/, '');
        if (blocked && opt.value === 'auto') opt.textContent += ' — unavailable (English-only model)';
      });
      if (englishOnly) {
        langSelect.value = 'en';
        modelNote.textContent = `${model.label} is English-only — language locked to English.`;
        modelNote.classList.remove('hidden');
      } else if (model && !model.word_timings) {
        modelNote.textContent =
          `${model.label} does not report word timings, so the forced aligner supplies them.`;
        modelNote.classList.remove('hidden');
      } else {
        modelNote.classList.add('hidden');
      }

      // Only Whisper discards a passage it doubts, so only Whisper has a gate to
      // stand down. Offered against a model that has none, the control would do
      // nothing at all and look as though it had. A custom repo is assumed
      // Whisper-shaped, which is the same assumption the backend makes.
      const keepUncertain = document.getElementById('transcribeKeepUncertain');
      const gated = modelSelect.value === '__custom__'
        || !!(model && WHISPER_ENGINES.includes(model.engine));
      keepUncertain.disabled = !gated;
      if (!gated) keepUncertain.checked = false;
      keepUncertain.closest('.checkbox-label').classList.toggle('disabled', !gated);

      // "Model's own timings only" is meaningless when the model has none.
      const neverOpt = Array.from(alignSelect.options).find(o => o.value === 'never');
      if (neverOpt) {
        neverOpt.disabled = !!(model && !model.word_timings);
        if (neverOpt.disabled && alignSelect.value === 'never') alignSelect.value = 'auto';
      }
    }

    applyModelRules = applyModelLanguageRules;

    /**
     * Speaker separation needs two things that install separately — the
     * SpeechBrain runtime and the voice model — so the control is switched off
     * and says which one is missing, rather than being offered and then quietly
     * returning unlabelled captions.
     */
    function updateDiarizeNote(probe) {
      const d = probe && probe.diarizer;
      const ready = !!(d && d.available && d.installed);

      diarizeToggle.disabled = !ready;
      if (!ready) diarizeToggle.checked = false;
      speakerCount.disabled = !diarizeToggle.checked;

      if (ready) {
        diarizeNote.classList.add('hidden');
        return;
      }
      diarizeNote.textContent = !d
        ? 'Speaker separation is unavailable on this backend.'
        : (!d.available
            ? 'Install the SpeechBrain runtime in Settings → Speech Runtimes to separate speakers.'
            : 'Install the speaker model in Settings → Speaker Separation to separate speakers.');
      diarizeNote.classList.remove('hidden');
    }

    async function updateBackendNote() {
      const probe = await transcriber.probe();
      // Before the early returns below: the speaker controls need settling
      // whatever else is missing.
      updateDiarizeNote(probe);

      if (!transcriber.hasBackend()) {
        note.className = 'export-note warn';
        note.textContent =
          'AI transcription needs the desktop backend. Launch with run_subtitler.sh '
          + '(or "python3 app.py") instead of opening index.html directly in a browser.';
        startBtn.disabled = true;
        return;
      }
      if (!probe.available) {
        note.className = 'export-note err';
        note.textContent =
          'No speech runtime is installed yet. Open Settings and use '
          + '"Install recommended setup" — it installs into the app\'s own environment.';
        startBtn.disabled = true;
        return;
      }

      const installed = (probe.models || []).filter(m => m.installed && m.engine_available);
      if (installed.length === 0) {
        note.className = 'export-note warn';
        note.textContent =
          `No models are installed yet. Open Settings to install one — `
          + `${probe.device_name} detected.`;
        startBtn.disabled = true;
        return;
      }

      note.className = 'export-note';
      const alignerReady = probe.aligner && probe.aligner.installed && probe.aligner.available;
      note.textContent =
        `Ready — ${installed.length} model${installed.length === 1 ? '' : 's'} installed, `
        + `running on ${probe.device_name}. `
        + (alignerReady
            ? 'Forced aligner installed, so word timings are measured rather than inferred.'
            : 'Forced aligner not installed — install it in Settings for the most precise caption timing.');
      startBtn.disabled = !transcriber.currentFile;
    }

    async function openModal() {
      const file = transcriber.currentFile;
      mediaInfo.textContent = file ? file.name : 'No media loaded — load a video or audio file first';
      progressWrap.classList.add('hidden');
      progressBar.style.width = '0%';
      modal.classList.remove('hidden');
      await populateModelSelect();
      updateBackendNote();
    }

    function closeModal() {
      if (running) {
        transcriber.cancel();
        running = false;
      }
      modal.classList.add('hidden');
    }

    document.getElementById('btnTranscribe').addEventListener('click', openModal);
    document.getElementById('btnCloseTranscribeModal').addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    startBtn.addEventListener('click', async () => {
      if (running) return;
      const haveAudio = transcriber.currentFile || (audioSource.value === 'file' && stemFile);
      if (!haveAudio) {
        toast(audioSource.value === 'file'
          ? 'Choose the dialogue stem to transcribe.'
          : 'Load a video or audio file before transcribing.', 'warn');
        return;
      }

      running = true;
      startBtn.disabled = true;
      playerController.pause();
      progressWrap.classList.remove('hidden');
      progressBar.style.width = '0%';
      progressText.textContent = 'Preparing…';

      try {
        const result = await transcriber.transcribe({
          model: modelSelect.value === '__custom__' ? 'small' : modelSelect.value,
          customModel: modelSelect.value === '__custom__' ? customInput.value.trim() : '',
          language: document.getElementById('transcribeLanguage').value,
          task: document.getElementById('transcribeTask').value,
          vad: document.getElementById('transcribeVad').checked,
          keepUncertain: document.getElementById('transcribeKeepUncertain').checked,
          audioFile: audioSource.value === 'file' ? stemFile : null,
          channel: document.getElementById('transcribeChannel').value,
          normalise: document.getElementById('transcribeNormalise').checked,
          suppressMusic: document.getElementById('transcribeSuppressMusic').checked,
          carryContext: document.getElementById('transcribeCarryContext').checked,
          diarize: diarizeToggle.checked,
          speakers: document.getElementById('transcribeSpeakerCount').value,
          vocabulary: vocabulary.value,
          align: ({ auto: 'auto', always: true, never: false })[
            document.getElementById('transcribeAlign').value],
          onProgress: (frac, msg) => {
            progressBar.style.width = `${Math.round(frac * 100)}%`;
            progressText.textContent = `${msg} (${Math.round(frac * 100)}%)`;
          }
        });

        lastTranscription = result;
        const count = applyTranscription(result, readSegmentSettings());

        if (count === 0) {
          toast('The model did not find any speech in this media.', 'warn', 6000);
          progressText.textContent = 'No speech detected.';
        } else {
          const lang = result.language ? ` (${result.language})` : '';
          const detail = [];
          if (result.separated) detail.push('dialogue isolated');
          if (result.alignment_used) detail.push('timings force-aligned');
          if (result.vad_dropped) detail.push(`${result.vad_dropped} word(s) in silence removed`);
          if (result.corrections && result.corrections.length) {
            detail.push(`${result.corrections.length} vocabulary correction(s)`);
          }
          const conf = result.confidence || {};
          if (conf.reported && conf.low_count) {
            detail.push(`${conf.low_count} uncertain word(s) — use Review in the captions list`);
          }
          if (result.speaker_count) {
            detail.push(`${result.speaker_count} speaker${result.speaker_count === 1 ? '' : 's'} separated`);
          } else if (diarizeToggle.checked) {
            // The backend explains exactly what was missing; repeating it beats
            // silently handing back unlabelled captions.
            const why = (result.notes || []).find(n => n.indexOf('Speaker separation') === 0);
            detail.push(why || 'speaker separation did not run');
          }
          toast(`Transcribed into ${count} captions${lang}.`
            + (detail.length ? `\n${detail.join('; ')}.` : ''), 'success', 10000);
          progressText.textContent = `Done — ${count} captions.`;
          modal.classList.add('hidden');
        }
      } catch (err) {
        const msg = err.message || String(err);
        if (msg === 'Cancelled.') {
          progressText.textContent = 'Cancelled.';
        } else {
          note.className = 'export-note err';
          note.textContent = msg;
          progressText.textContent = 'Failed.';
          toast(`Transcription failed: ${msg}`, 'error', 9000);
        }
      } finally {
        running = false;
        startBtn.disabled = false;
      }
    });
  }

  // --- Projects & Films ---
  /**
   * A job is one project file; the films inside it are separate edits that
   * happen to be delivered together. Each film owns its media, its captions,
   * its caption style and its aspect ratio — a film is not a re-render of
   * another film at a different ratio, so nothing is shared between them.
   *
   * Rather than run four editors at once, one editor is repointed: the live
   * state is read back into the film being left (`captureActiveFilm`) and the
   * incoming film is pushed into the same controllers (`applyActiveFilm`).
   */
  function bindProjectUI() {
    project.onChange(() => {
      renderProjectUI();
      scheduleAutosave();
    });

    document.getElementById('btnAddFilm').addEventListener('click', addFilm);
    document.getElementById('btnAddFilmMenu').addEventListener('click', addFilm);
    document.getElementById('btnDuplicateFilm').addEventListener('click', duplicateActiveFilm);
    document.getElementById('btnRenameFilm').addEventListener('click', () => beginRenameFilm(project.activeId));
    document.getElementById('btnDeleteFilm').addEventListener('click', () => deleteFilm(project.activeId));

    document.getElementById('btnNewProject').addEventListener('click', newProject);
    document.getElementById('btnOpenProject').addEventListener('click', openProject);
    document.getElementById('btnSaveProject').addEventListener('click', () => saveProject());
    document.getElementById('btnSaveProjectAs').addEventListener('click', () => saveProject({ saveAs: true }));

    document.getElementById('btnRelinkBanner').addEventListener('click', promptRelink);
    document.getElementById('btnRelinkMediaMenu').addEventListener('click', promptRelink);

    document.getElementById('projectChip').addEventListener('click', () => {
      const name = prompt('Project name:', project.name);
      if (name === null) return;
      if (project.setName(name)) scheduleAutosave();
    });

    document.getElementById('projectFileInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const reader = new FileReader();
      // A file chosen through the browser gives no path, so a later plain Save
      // downloads a new copy rather than pretending it can overwrite in place.
      reader.onload = (evt) => adoptProjectText(evt.target.result, '');
      reader.onerror = () => toast(`Could not read "${file.name}".`, 'error');
      reader.readAsText(file);
    });

    document.getElementById('relinkFilesInput').addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (files.length) relinkMedia(files);
    });

    document.getElementById('btnCopyCaptionsToRatios')
      .addEventListener('click', copyCaptionsToOtherRatios);
    document.getElementById('btnCopyStyleToRatios')
      .addEventListener('click', copyStyleToOtherRatios);

    subManager.onChange(() => {
      if (!swappingFilm) project.markDirty();
      renderFilmTabs();   // the tab shows a live caption count
      renderRatioUI();
      scheduleAutosave();
    });

    playerController.onPresetChange((preset) => {
      if (swappingFilm) return;
      const ratio = project.getActiveRatio();
      if (ratio) ratio.preset = { ...preset };
      project.markDirty();
      scheduleAutosave();
    });
  }

  // --- pushing one ratio's work over the others ---------------------------
  /**
   * Ratios diverge on purpose — a 9:16 frame wants shorter lines than a 16:9
   * one. These two are the way back when a correction should not be retyped
   * four times, so both confirm before overwriting.
   */
  function copyCaptionsToOtherRatios() {
    const film = project.getActive();
    if (!film) return;
    const count = subManager.getSubtitles().length;
    if (count === 0) {
      toast('There are no captions in this ratio to copy.', 'warn');
      return;
    }
    const from = film.activeRatio.replace('x', ':');
    if (!confirm(
      `Replace the captions in the other three aspect ratios with these ${count} `
      + `${from} lines? Their own line breaks and timing edits are lost.`)) return;

    captureActiveFilm();
    const touched = project.copyCaptionsToOtherRatios(film.id, film.activeRatio);
    renderRatioUI();
    scheduleAutosave();
    toast(`Copied ${count} captions from ${from} into ${touched} other ratios.`, 'success', 6000);
  }

  function copyStyleToOtherRatios() {
    const film = project.getActive();
    if (!film) return;
    const from = film.activeRatio.replace('x', ':');
    if (!confirm(`Apply the ${from} caption style to the other three aspect ratios?`)) return;

    captureActiveFilm();
    const touched = project.copyStyleToOtherRatios(film.id, film.activeRatio);
    scheduleAutosave();
    toast(`Applied the ${from} style to ${touched} other ratios.`, 'success');
  }

  /**
   * Captions that come from the soundtrack — a transcription, an imported
   * subtitle file — are written into every ratio, because there is one set of
   * words per edit. Hand edits stay in the ratio they were made in.
   */
  function setCaptionsEverywhere(captions) {
    const film = project.getActive();
    if (!film) return 0;

    project.setCaptionsAllRatios(film.id, captions);
    swappingFilm = true;
    try {
      subManager.selectedId = null;
      subManager.setSubtitles(film.ratios[film.activeRatio].subtitles);
    } finally {
      swappingFilm = false;
    }
    project.markDirty();
    timelineController.resizeAndDraw();
    renderRatioUI();
    scheduleAutosave();
    return captions.length;
  }

  // --- capture / apply ----------------------------------------------------
  /**
   * Reads the live editor state back where it belongs: the captions, style and
   * guide choice into the ratio variant on screen, everything that comes from
   * the soundtrack — media, transcription, segmentation, transport — onto the
   * film itself.
   */
  function captureActiveFilm() {
    const film = project.getActive();
    if (!film) return null;

    const ratio = film.ratios[film.activeRatio];
    if (ratio) {
      ratio.subtitles = subManager.getSubtitles().map(sub => ({ ...sub }));
      ratio.selectedId = subManager.selectedId;
      ratio.preset = { ...playerController.activePreset };
      ratio.guides = currentGuideSetId();
    }

    film.zoom = timelineController.zoomLevel;
    film.playhead = playerController.getCurrentTime();
    film.transcription = lastTranscription;
    film.segment = readSegmentUI();
    return film;
  }

  /** Points every controller at the active film. The inverse of the above. */
  function applyActiveFilm() {
    const film = project.getActive();
    if (!film) return;

    // try/finally: this drives most of the editor, and a flag left stuck on by
    // a throw halfway through would silently disable dirty tracking for the
    // rest of the session.
    swappingFilm = true;
    try {
      applyFilmState(film);
    } finally {
      swappingFilm = false;
    }
  }

  function applyFilmState(film) {
    playerController.pause();

    const rt = filmRuntimes.get(film.id);
    if (rt && rt.file) {
      playerController.loadMedia(rt.file, rt.objectUrl);
      transcriber.setFile(rt.file);
      document.getElementById('mediaInfoLabel').textContent = rt.file.name;
      document.getElementById('programFrame').classList.add('has-media');
      timelineController.setWaveform(rt.peaks, rt.peaksDuration);
    } else {
      // Showing the previous film's picture under this film's captions would
      // misrepresent what is being captioned, so fall back to the placeholder.
      playerController.unloadMedia();
      transcriber.setFile(null);
      document.getElementById('mediaInfoLabel').textContent =
        film.media && film.media.name ? `${film.media.name} — not linked` : 'No media loaded';
      document.getElementById('programFrame').classList.remove('has-media');
      timelineController.setWaveform(null, 0);
    }

    lastTranscription = film.transcription || null;
    writeSegmentUI(film.segment);

    const zoomSlider = document.getElementById('timelineZoom');
    zoomSlider.value = film.zoom;
    timelineController.setZoom(film.zoom);

    applyRatioState(film, film.activeRatio);

    playerController.seek(film.playhead || 0);
  }

  /**
   * Points the frame, the captions, the style and the guides at one ratio of
   * the film already on screen. The media and the transcription do not move —
   * they belong to the edit, and only the deliverable shape is changing.
   */
  function applyRatioState(film, ratioId) {
    const ratio = film.ratios[ratioId];
    if (!ratio) return;

    playerController.setAspectRatio(ratioId);
    playerController.applyPreset(ratio.preset);
    applyPresetToUI(ratio.preset);
    syncPresetSelect(ratio.preset);

    subManager.selectedId = null;
    subManager.setSubtitles(ratio.subtitles);
    if (ratio.selectedId && subManager.getSubtitles().some(sub => sub.id === ratio.selectedId)) {
      subManager.selectSubtitle(ratio.selectedId);
    }

    populateGuideSelect(ratioId, ratio.guides);
    renderGuides();

    timelineController.resizeAndDraw();
    playerController.renderOverlay();
  }

  /**
   * Switches which aspect ratio of the current film is being captioned. The
   * ratio being left is read back first, so its own line breaks survive.
   */
  function switchRatio(ratioId) {
    const film = project.getActive();
    if (!film || !film.ratios[ratioId]) return;
    if (film.activeRatio === ratioId) return;

    captureActiveFilm();
    swappingFilm = true;
    try {
      film.activeRatio = ratioId;
      applyRatioState(film, ratioId);
    } finally {
      swappingFilm = false;
    }
    renderRatioUI();
    scheduleAutosave();
  }

  /** Keeps the preset dropdown pointing at the film's style where it can. */
  function syncPresetSelect(preset) {
    const select = document.getElementById('presetSelect');
    if (!select || !preset || !preset.id) return;
    const match = Array.from(select.options).find(opt => opt.value === preset.id);
    if (match) select.value = preset.id;
  }

  function readSegmentUI() {
    return {
      maxCharsPerLine: parseInt(document.getElementById('segMaxChars').value, 10),
      maxLines: parseInt(document.getElementById('segMaxLines').value, 10),
      maxDurationSec: parseFloat(document.getElementById('segMaxDur').value)
    };
  }

  function writeSegmentUI(seg) {
    const chars = document.getElementById('segMaxChars');
    const lines = document.getElementById('segMaxLines');
    const dur = document.getElementById('segMaxDur');
    if (!chars || !lines || !dur) return;

    if (seg) {
      if (seg.maxCharsPerLine) chars.value = seg.maxCharsPerLine;
      if (seg.maxLines) lines.value = seg.maxLines;
      if (seg.maxDurationSec) dur.value = seg.maxDurationSec;
    }
    document.getElementById('segMaxCharsVal').textContent = chars.value;
    document.getElementById('segMaxDurVal').textContent = `${parseFloat(dur.value).toFixed(1)}s`;
  }

  // --- film operations ----------------------------------------------------
  function switchFilm(filmId) {
    if (!project.getFilm(filmId) || filmId === project.activeId) return;
    captureActiveFilm();
    project.setActive(filmId);
    applyActiveFilm();
    renderProjectUI();
  }

  function stepFilm(delta) {
    if (project.getFilms().length < 2) return;
    captureActiveFilm();
    if (!project.stepActive(delta)) return;
    applyActiveFilm();
    renderProjectUI();
  }

  function addFilm() {
    captureActiveFilm();
    const current = project.getActive();
    // A new edit inherits the look you were just working in — within one job
    // the caption style is normally the constant and the cut is what changes —
    // and it inherits it in every ratio, since the new film has all four too.
    const ratios = {};
    RATIO_IDS.forEach(rid => {
      ratios[rid] = { preset: { ...current.ratios[rid].preset }, guides: current.ratios[rid].guides };
    });

    const film = project.addFilm({
      name: project.uniqueName(`Film ${project.getFilms().length + 1}`),
      ratios: ratios,
      activeRatio: current.activeRatio,
      segment: readSegmentUI()
    });
    project.setActive(film.id);
    applyActiveFilm();
    renderProjectUI();
    scheduleAutosave();
    toast(`Added "${film.name}". Load its media from Import.`, 'success');
  }

  function duplicateActiveFilm() {
    captureActiveFilm();
    const source = project.getActive();
    const copy = project.duplicateFilm(project.activeId);
    if (!copy) return;

    // Same media file, so carry the live handle across rather than making the
    // operator relink a film they created a second ago. A separate object URL
    // keeps the two films' lifetimes independent.
    const rt = filmRuntimes.get(source.id);
    if (rt && rt.file) {
      filmRuntimes.set(copy.id, {
        file: rt.file,
        objectUrl: URL.createObjectURL(rt.file),
        peaks: rt.peaks,
        peaksDuration: rt.peaksDuration
      });
    }

    project.setActive(copy.id);
    applyActiveFilm();
    renderProjectUI();
    scheduleAutosave();
    toast(`Duplicated to "${copy.name}".`, 'success');
  }

  function deleteFilm(filmId) {
    const film = project.getFilm(filmId);
    if (!film) return;
    if (project.getFilms().length <= 1) {
      toast('A project always holds at least one film. Add another before deleting this one.', 'warn');
      return;
    }

    if (filmId === project.activeId) captureActiveFilm();
    const total = RATIO_IDS.reduce((sum, rid) => sum + project.captionCount(filmId, rid), 0);
    const shapes = project.populatedRatios(filmId).length;
    if (!confirm(`Delete "${film.name}"? That removes ${total} caption${total === 1 ? '' : 's'} `
      + `across ${shapes} aspect ratio${shapes === 1 ? '' : 's'}. This cannot be undone.`)) {
      return;
    }

    const wasActive = filmId === project.activeId;
    if (!wasActive) captureActiveFilm();
    releaseRuntime(filmId);
    project.removeFilm(filmId);
    if (wasActive) applyActiveFilm();
    renderProjectUI();
    scheduleAutosave();
  }

  function beginRenameFilm(filmId) {
    const film = project.getFilm(filmId);
    const tab = document.querySelector(`.film-tab[data-id="${filmId}"]`);
    if (!film || !tab) return;

    tab.innerHTML = '';
    const input = document.createElement('input');
    input.className = 'film-tab-rename';
    input.value = film.name;
    tab.appendChild(input);
    input.focus();
    input.select();

    let settled = false;
    const commit = (save) => {
      if (settled) return;
      settled = true;
      if (save) project.renameFilm(filmId, input.value);
      renderProjectUI();
      scheduleAutosave();
    };

    // Swallowed so Escape does not also close the editor's modals and Enter
    // does not reach the transport shortcuts.
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commit(true);
      else if (e.key === 'Escape') commit(false);
    });
    input.addEventListener('blur', () => commit(true));
  }

  // --- media linking ------------------------------------------------------
  /**
   * @param {Object} opts  `fresh: true` means this is different media, not the
   *   same file being relinked — so any transcription of the old audio is
   *   dropped rather than left describing a file that is no longer loaded.
   */
  function attachMediaToFilm(filmId, file, opts = {}) {
    const film = project.getFilm(filmId);
    if (!film || !file) return;

    const rt = filmRuntimes.get(filmId) || {};
    if (rt.objectUrl) URL.revokeObjectURL(rt.objectUrl);
    rt.file = file;
    rt.objectUrl = URL.createObjectURL(file);
    rt.peaks = null;
    rt.peaksDuration = 0;
    filmRuntimes.set(filmId, rt);

    film.media = { name: file.name, size: file.size || 0, type: file.type || '' };
    if (opts.fresh) film.transcription = null;
    project.markDirty();

    if (filmId === project.activeId) {
      playerController.loadMedia(file, rt.objectUrl);
      transcriber.setFile(file);
      document.getElementById('mediaInfoLabel').textContent = file.name;
      document.getElementById('programFrame').classList.add('has-media');
      if (opts.fresh) lastTranscription = null;
    }

    decodeWaveformFor(filmId, file);
    renderProjectUI();
    scheduleAutosave();
  }

  function decodeWaveformFor(filmId, file) {
    waveformQueue = waveformQueue.then(async () => {
      const rt = filmRuntimes.get(filmId);
      if (!rt || rt.file !== file) return; // the film moved on while we queued
      await timelineController.loadAudioWaveform(file);
      const wave = timelineController.getWaveform();
      rt.peaks = wave.peaks;
      rt.peaksDuration = wave.duration;
      if (project.activeId !== filmId) {
        const active = filmRuntimes.get(project.activeId) || {};
        timelineController.setWaveform(active.peaks, active.peaksDuration);
      }
    }).catch(() => { /* an undecodable file just means no waveform */ });
    return waveformQueue;
  }

  function hasLiveMedia(filmId) {
    const rt = filmRuntimes.get(filmId);
    return !!(rt && rt.file);
  }

  function unlinkedCount() {
    return project.unlinkedFilms(hasLiveMedia).length;
  }

  function promptRelink() {
    if (unlinkedCount() === 0) {
      toast('Every film in this project already has its media.', 'info');
      return;
    }
    document.getElementById('relinkFilesInput').click();
  }

  /**
   * Matches chosen files to the films waiting for them by filename first, then
   * hands whatever is left to the still-waiting films in order — a renamed file
   * is the common case and should not leave the operator stuck.
   *
   * One file can back several films: duplicating an edit leaves two films
   * pointing at the same rushes. So a filename match satisfies every film
   * waiting for that name, not just the first one found.
   */
  function relinkMedia(files) {
    const waiting = () => project.getFilms().filter(
      film => film.media && film.media.name && !hasLiveMedia(film.id) && !claimed.has(film.id));
    const claimed = new Set();
    const pairs = [];
    let namedCount = 0;

    files.forEach(file => {
      const matches = waiting().filter(
        film => film.media.name.toLowerCase() === file.name.toLowerCase());
      matches.forEach(film => {
        claimed.add(film.id);
        pairs.push([film.id, file]);
        namedCount++;
      });
    });

    const spare = files.filter(file => !pairs.some(([, f]) => f === file));
    const orderedCount = Math.min(spare.length, waiting().length);
    waiting().slice(0, orderedCount).forEach((film, i) => {
      claimed.add(film.id);
      pairs.push([film.id, spare[i]]);
    });
    const unused = spare.length - orderedCount;

    pairs.forEach(([filmId, file]) => attachMediaToFilm(filmId, file, { fresh: false }));

    // Only re-point the editor if the film on screen is one of the ones that
    // just gained media — otherwise this would yank the playhead for nothing.
    if (claimed.has(project.activeId)) applyActiveFilm();
    renderProjectUI();

    const parts = [];
    if (namedCount) parts.push(`${namedCount} matched by filename`);
    if (orderedCount) parts.push(`${orderedCount} matched in order — check they are the right cuts`);
    if (unused) parts.push(`${unused} file(s) had no film waiting`);

    toast(pairs.length
      ? `Relinked ${pairs.length} film${pairs.length === 1 ? '' : 's'}: ${parts.join('; ')}.`
      : 'None of those files matched a film waiting for media.',
      orderedCount || unused ? 'warn' : 'success', 8000);
  }

  function releaseRuntime(filmId) {
    const rt = filmRuntimes.get(filmId);
    if (rt && rt.objectUrl) URL.revokeObjectURL(rt.objectUrl);
    filmRuntimes.delete(filmId);
  }

  function releaseAllRuntimes() {
    Array.from(filmRuntimes.keys()).forEach(releaseRuntime);
  }

  // --- project file I/O ---------------------------------------------------
  function nativeProjectApi() {
    const api = window.pywebview && window.pywebview.api;
    return api && api.project_save && api.project_open ? api : null;
  }

  async function saveProject(opts = {}) {
    captureActiveFilm();
    const json = project.serialize();
    const filename = `${ProjectManager.slug(project.name, 'project')}${PROJECT_EXT}`;
    const api = nativeProjectApi();

    if (api) {
      try {
        // No path, or Save As, means "ask me where" — otherwise Cmd+S has to
        // overwrite silently, which is the whole point of having a path.
        const res = await api.project_save(filename, json, opts.saveAs ? '' : (project.path || ''));
        if (res && res.ok) {
          project.markSaved(res.path);
          rememberProjectPath(res.path);
          toast(`Project saved to ${res.path}`, 'success', 6000);
          return true;
        }
        if (res && res.error && res.error !== 'Save cancelled.') {
          toast(res.error, 'error', 8000);
        }
        return false;
      } catch (e) {
        // Fall through to the browser download rather than losing the save.
      }
    }

    downloadFile(json, filename, 'application/json');
    project.markSaved();
    toast(`Downloaded ${filename}.`, 'success');
    return true;
  }

  async function openProject() {
    if (!confirmDiscard('Open another project')) return;
    const api = nativeProjectApi();

    if (api) {
      try {
        const res = await api.project_open();
        if (res && res.ok) {
          adoptProjectText(res.content, res.path);
          return;
        }
        if (res && res.error && res.error !== 'Open cancelled.') {
          toast(res.error, 'error', 8000);
        }
        return;
      } catch (e) {
        // Fall through to the file input.
      }
    }
    document.getElementById('projectFileInput').click();
  }

  function adoptProjectText(text, path) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      toast('That file is not valid JSON, so it is not a project file.', 'error', 7000);
      return;
    }

    try {
      project.load(data);
    } catch (e) {
      toast(e.message, 'error', 8000);
      return;
    }

    releaseAllRuntimes();
    project.path = path || '';
    rememberProjectPath(project.path);
    lastTranscription = null;
    applyActiveFilm();
    renderProjectUI();
    writeAutosave();

    const waiting = unlinkedCount();
    toast(`Opened "${project.name}" — ${project.getFilms().length} film`
      + `${project.getFilms().length === 1 ? '' : 's'}.`
      + (waiting ? ` ${waiting} need media relinking.` : ''), 'success', 8000);
  }

  function newProject() {
    if (!confirmDiscard('Start a new project')) return;
    releaseAllRuntimes();
    project.reset();
    project.path = '';
    rememberProjectPath('');
    lastTranscription = null;
    applyActiveFilm();
    renderProjectUI();
    writeAutosave();
    toast('New project started.', 'success');
  }

  function confirmDiscard(action) {
    if (!project.dirty) return true;
    return confirm(`"${project.name}" has unsaved changes. ${action} anyway?`);
  }

  // --- autosave -----------------------------------------------------------
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(writeAutosave, 1500);
  }

  function writeAutosave() {
    captureActiveFilm();
    try {
      localStorage.setItem(AUTOSAVE_KEY, project.serialize());
    } catch (e) {
      // A long transcription can push a project past the storage quota. The
      // captions are what has to survive a reload, so drop the raw
      // transcriptions and try once more rather than losing the autosave.
      try {
        const lean = project.toJSON();
        lean.films.forEach(film => { film.transcription = null; });
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(lean));
      } catch (e2) { /* private mode, or still too large — the .ttproj is the real safety net */ }
    }
  }

  function rememberProjectPath(path) {
    try { localStorage.setItem(AUTOSAVE_PATH_KEY, path || ''); } catch (e) { /* private mode */ }
  }

  function restoreAutosave() {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return false;
      project.load(JSON.parse(raw));
      project.path = localStorage.getItem(AUTOSAVE_PATH_KEY) || '';
      return true;
    } catch (e) {
      return false; // a corrupt or older autosave must never block startup
    }
  }

  // --- film bar rendering -------------------------------------------------
  function renderProjectUI() {
    renderFilmTabs();
    renderRatioUI();
    renderProjectChip();
    renderRelinkBanner();
  }

  function renderFilmTabs() {
    const strip = document.getElementById('filmTabs');
    if (!strip) return;
    const films = project.getFilms();
    strip.innerHTML = '';

    films.forEach(film => {
      const isActive = film.id === project.activeId;
      // The active film's captions live in the manager, not the record, so read
      // the count from there or a tab lags a caption behind every edit.
      const count = isActive
        ? subManager.getSubtitles().length
        : project.captionCount(film.id, film.activeRatio);
      const shapes = project.populatedRatios(film.id).length;
      const unlinked = !!(film.media && film.media.name) && !hasLiveMedia(film.id);

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = `film-tab${isActive ? ' active' : ''}`;
      tab.dataset.id = film.id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(isActive));
      tab.title = `${film.name} — captioned in ${shapes} of 4 aspect ratios`
        + `\nEditing ${film.activeRatio.replace('x', ':')}: ${count} caption${count === 1 ? '' : 's'}`
        + (unlinked ? `\nMedia "${film.media.name}" is not linked in this session.` : '')
        + '\nDouble-click to rename.';

      const name = document.createElement('span');
      name.className = 'film-tab-name';
      name.textContent = film.name;
      tab.appendChild(name);

      const meta = document.createElement('span');
      meta.className = 'film-tab-meta';
      meta.textContent = `${film.activeRatio.replace('x', ':')} · ${count}`;
      tab.appendChild(meta);

      if (unlinked) {
        const warn = document.createElement('span');
        warn.className = 'film-tab-meta film-tab-warn';
        warn.textContent = '⚠';
        tab.appendChild(warn);
      }

      if (films.length > 1) {
        // A <span>, not a <button>: a button inside a button is invalid markup
        // and browsers disagree about which one the click belongs to.
        const close = document.createElement('span');
        close.className = 'film-tab-close';
        close.setAttribute('role', 'button');
        close.textContent = '✕';
        close.title = `Delete "${film.name}"`;
        close.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteFilm(film.id);
        });
        tab.appendChild(close);
      }

      tab.addEventListener('click', () => switchFilm(film.id));
      tab.addEventListener('dblclick', (e) => {
        e.preventDefault();
        beginRenameFilm(film.id);
      });
      strip.appendChild(tab);
    });
  }

  function renderProjectChip() {
    const label = document.getElementById('projectNameLabel');
    if (!label) return;
    label.textContent = project.name;
    document.getElementById('projectDirtyDot').classList.toggle('hidden', !project.dirty);
    document.getElementById('projectChip').title =
      (project.path ? `${project.path}\n` : 'Not written to a file yet\n')
      + 'Click to rename the project';
  }

  function renderRelinkBanner() {
    const btn = document.getElementById('btnRelinkBanner');
    if (!btn) return;
    const waiting = unlinkedCount();
    btn.classList.toggle('hidden', waiting === 0);
    document.getElementById('relinkLabel').textContent =
      `${waiting} film${waiting === 1 ? '' : 's'} need${waiting === 1 ? 's' : ''} media`;
  }

  // --- Keyboard Shortcuts ---
  function bindKeyboardShortcuts() {
    // Project commands are deliberately outside the editor handler below: they
    // carry a modifier, and Cmd+S has to work while the caret is in a caption
    // box — that is exactly when you most want it to.
    window.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        saveProject({ saveAs: e.shiftKey });
      } else if (key === 'o') {
        e.preventDefault();
        openProject();
      }
    });

    window.addEventListener('keydown', (e) => {
      // Ignore when typing in inputs/textareas
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.target.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const exportOpen = !document.getElementById('exportModal').classList.contains('hidden');
      const transcribeOpen = !document.getElementById('transcribeModal').classList.contains('hidden');
      const settingsOpen = !document.getElementById('settingsModal').classList.contains('hidden');
      const libraryOpen = !document.getElementById('presetLibraryModal').classList.contains('hidden');

      if (e.key === 'Escape') {
        document.getElementById('shortcutsModal').classList.add('hidden');
        document.getElementById('exportModal').classList.add('hidden');
        document.getElementById('transcribeModal').classList.add('hidden');
        document.getElementById('settingsModal').classList.add('hidden');
        document.getElementById('presetLibraryModal').classList.add('hidden');
        return;
      }
      // Don't drive the editor while a dialog is up
      if (exportOpen || transcribeOpen || settingsOpen || libraryOpen) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          playerController.togglePlay();
          updatePlayIcons();
          return;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.shiftKey) playerController.seek(playerController.getCurrentTime() - 1.0);
          else playerController.stepFrame(-1);
          updatePlayIcons();
          return;
        case 'ArrowRight':
          e.preventDefault();
          if (e.shiftKey) playerController.seek(playerController.getCurrentTime() + 1.0);
          else playerController.stepFrame(1);
          updatePlayIcons();
          return;
      }

      switch (e.key.toLowerCase()) {
        case 'c':
          if (subManager.selectedId) {
            subManager.splitSubtitleAt(subManager.selectedId, playerController.getCurrentTime());
          }
          break;
        case 'k':
          playerController.jumpToPrevSubtitle();
          break;
        case 'l':
          playerController.jumpToNextSubtitle();
          break;
        case 'r': {
          const isLooping = playerController.toggleLoopRegion();
          document.getElementById('btnLoopRegion').classList.toggle('active', isLooping);
          break;
        }
        case 'f':
          playerController.toggleFullscreen();
          break;
        case 'g':
          toggleSafeGuides();
          break;
        case 'e':
          document.getElementById('btnExportAlpha').click();
          break;
        case 't':
          document.getElementById('btnTranscribe').click();
          break;
        case ',':
          document.getElementById('btnSettings').click();
          break;
        case 'm': {
          const isMuted = playerController.toggleMute();
          document.getElementById('btnAudioMute').classList.toggle('active', isMuted);
          break;
        }
        case 's': {
          const isSolo = playerController.toggleSolo();
          document.getElementById('btnAudioSolo').classList.toggle('active', isSolo);
          break;
        }
        case '?':
          document.getElementById('shortcutsModal').classList.toggle('hidden');
          break;
        case '1': switchRatio('16x9'); break;
        case '2': switchRatio('1x1'); break;
        case '3': switchRatio('4x5'); break;
        case '4': switchRatio('9x16'); break;
        case '+':
        case '=': zoomBy(15); break;
        case '-':
        case '_': zoomBy(-15); break;
        case '[': stepFilm(-1); break;
        case ']': stepFilm(1); break;
        case 'delete':
        case 'backspace':
          e.preventDefault();
          if (subManager.selectedId) subManager.deleteSubtitle(subManager.selectedId);
          break;
      }
    });
  }

  // --- Helpers ---
  function escapeHtml(str) {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Uses the desktop save dialog when available, otherwise a browser download. */
  async function saveTextFile(content, fileName, mimeType) {
    if (window.pywebview && window.pywebview.api && window.pywebview.api.save_text_file) {
      try {
        const res = await window.pywebview.api.save_text_file(fileName, content);
        if (res && res.ok) {
          toast(`Saved to ${res.path}`, 'success', 6000);
          return;
        }
        if (res && res.error && res.error !== 'Save cancelled.') {
          toast(res.error, 'error');
          return;
        }
        return; // user cancelled
      } catch (e) {
        // fall through to the browser download
      }
    }
    downloadFile(content, fileName, mimeType);
    toast(`Downloaded ${fileName}.`, 'success');
  }

  function downloadFile(content, fileName, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * Built-in placeholder picture — the slate shown until real media is loaded.
   *
   * Deliberately flat and still: it stands behind the caption overlay, so
   * anything moving or coloured under it would be judged as part of the caption
   * style. A neutral grey ground is what caption legibility has to be read
   * against, and the only thing that animates is the timecode, which is there
   * to prove the transport is running.
   *
   * Unlike a live captureStream this is a pure function of time, so the
   * playhead can be scrubbed, stepped and looped before any media exists.
   */
  function setupDemoPicture() {
    const demoCanvas = document.getElementById('demoCanvas');
    const dctx = demoCanvas.getContext('2d');

    // Matches the interface tokens in styles.css. The ground sits a little
    // above --bg-app so the frame reads as picture against the app chrome.
    const SLATE_GROUND = '#212325';
    const SLATE_TEXT = '#e6e8ea';
    const SLATE_MUTED = '#6b7276';

    const trackedWidth = (chars, tracking) =>
      chars.reduce((sum, ch) => sum + dctx.measureText(ch).width, 0)
      + tracking * Math.max(0, chars.length - 1);

    /**
     * Letter-spaced centred text, shrunk to fit. ctx.letterSpacing is too new
     * to rely on in the desktop shell's webview, so the tracking is applied per
     * glyph — which also means the fit has to be measured the same way.
     *
     * The fit matters: 9:16 is only 1080 wide but scales type by height, so a
     * line sized for landscape would otherwise run past both edges.
     */
    const drawTracked = (text, cx, y, sizePx, makeFont, tracking, maxWidth) => {
      const chars = [...text];
      let size = sizePx;
      dctx.font = makeFont(size);
      let width = trackedWidth(chars, tracking);
      while (size > 8 && width > maxWidth) {
        size -= 1;
        dctx.font = makeFont(size);
        width = trackedWidth(chars, tracking * (size / sizePx));
      }
      const track = tracking * (size / sizePx);

      let x = cx - width / 2;
      chars.forEach((ch) => {
        dctx.fillText(ch, x, y);
        x += dctx.measureText(ch).width + track;
      });
    };

    playerController.onFrameRender((timeSec, project) => {
      if (playerController.hasMedia) return;

      if (demoCanvas.width !== project.width || demoCanvas.height !== project.height) {
        demoCanvas.width = project.width;
        demoCanvas.height = project.height;
      }

      const w = demoCanvas.width;
      const h = demoCanvas.height;
      // Every size below is authored against a 1080-tall frame and scaled, the
      // same rule the caption presets follow, so the slate holds its
      // proportions in 16:9, 1:1, 4:5 and 9:16 alike.
      const s = h / 1080;

      dctx.fillStyle = SLATE_GROUND;
      dctx.fillRect(0, 0, w, h);

      dctx.textAlign = 'left';
      dctx.textBaseline = 'alphabetic';

      // Three sizes, one alignment: label, timecode, spec. Sitting above centre
      // keeps the block clear of the caption band at the bottom of the frame.
      const baseline = h * 0.44;

      const maxW = w * 0.72;
      const sans = (n) => `500 ${n}px Inter, sans-serif`;
      const mono = (n) => `400 ${n}px "Roboto Mono", monospace`;

      dctx.fillStyle = SLATE_MUTED;
      drawTracked('NO MEDIA', w / 2, baseline - 52 * s, Math.round(22 * s), sans, 5 * s, maxW);

      dctx.fillStyle = SLATE_TEXT;
      drawTracked(subManager.secondsToTimecode(timeSec, FPS),
        w / 2, baseline + 26 * s, Math.round(72 * s), mono, 2 * s, maxW);

      dctx.fillStyle = SLATE_MUTED;
      drawTracked(`${w} \u00d7 ${h}  \u00b7  ${FPS} FPS`,
        w / 2, baseline + 74 * s, Math.round(20 * s), mono, 2 * s, maxW);
    });
  }

  // Everything above is now declared, so the project can be put on screen.
  bootProject();
});
