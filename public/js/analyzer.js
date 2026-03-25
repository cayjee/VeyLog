/**
 * analyzer.js — Logique de la page d'analyse
 * Gestion de la sélection de fichiers, des tâches et du lancement de l'analyse
 */

'use strict';

// ─── Définition des tâches de la checklist ───────────────────────────────────

const CHECKLIST_TASKS = {
  task1:  { label: 'Authentification & SSH', icon: '🔐', color: 'text-red-400' },
  task2:  { label: 'Élévation de privilèges', icon: '⚠️', color: 'text-orange-400' },
  task3:  { label: 'Activité réseau suspecte', icon: '🌐', color: 'text-blue-400' },
  task4:  { label: 'Erreurs système & kernel', icon: '⚡', color: 'text-purple-400' },
  task5:  { label: 'Services défaillants', icon: '⚙️', color: 'text-yellow-400' },
  task6:  { label: 'Tentatives d\'intrusion', icon: '🛡️', color: 'text-red-500' },
  task7:  { label: 'Modifications système', icon: '📝', color: 'text-orange-300' },
  task8:  { label: 'Activités malveillantes', icon: '☠️', color: 'text-red-600' },
  task9:  { label: 'Ressources système', icon: '📊', color: 'text-cyan-400' },
  task10: { label: 'Services web', icon: '🌍', color: 'text-green-400' },
};

// ─── État global de la page ───────────────────────────────────────────────────

const state = {
  files: [],                // Liste complète des fichiers disponibles
  selectedFiles: new Set(), // Chemins des fichiers sélectionnés
  selectedTasks: new Set(Object.keys(CHECKLIST_TASKS)), // Toutes les tâches sélectionnées par défaut
  availableModels: [],      // Modèles Ollama disponibles
  isAnalyzing: false,
  activeTypeFilter: null,
};

// ─── Initialisation ────────────────────────────────────────────────────────────

async function initAnalyzer() {
  // Pré-sélectionner les fichiers passés depuis le dashboard
  const preSelected = JSON.parse(sessionStorage.getItem('veylog_selected_files') || '[]');
  preSelected.forEach(p => state.selectedFiles.add(p));
  sessionStorage.removeItem('veylog_selected_files');

  await Promise.all([
    loadFileTree(),
    loadModels(),
  ]);

  renderChecklist();
  updateAnalyzeButton();
}

// ─── Chargement des fichiers ──────────────────────────────────────────────────

async function loadFileTree() {
  const container = document.getElementById('fileTreeContainer');
  try {
    const data = await apiGet('/api/logs/list');
    state.files = data.files;

    // Générer les filtres de type
    renderTypeFilters();
    renderFileTree(state.files);
    updateSelectionCount();
  } catch (e) {
    if (container) container.innerHTML = `
      <div class="text-red-400 text-sm p-4 text-center">
        ✗ Erreur : ${escapeHtml(e.message)}
      </div>`;
    showToast('Impossible de charger la liste des fichiers', 'error');
  }
}

// ─── Filtres par type ─────────────────────────────────────────────────────────

function renderTypeFilters() {
  const container = document.getElementById('typeFilters');
  if (!container) return;

  const typeCounts = {};
  state.files.forEach(f => { typeCounts[f.type] = (typeCounts[f.type] || 0) + 1; });

  const typeColors = {
    auth: 'border-red-500 text-red-400',
    syslog: 'border-blue-500 text-blue-400',
    kernel: 'border-purple-500 text-purple-400',
    nginx: 'border-green-500 text-green-400',
    apache: 'border-green-400 text-green-300',
    mysql: 'border-orange-500 text-orange-400',
    cron: 'border-yellow-500 text-yellow-400',
    daemon: 'border-cyan-500 text-cyan-400',
    firewall: 'border-red-400 text-red-300',
    fail2ban: 'border-orange-400 text-orange-300',
    postgresql: 'border-blue-400 text-blue-300',
    mail: 'border-pink-500 text-pink-400',
    journal: 'border-indigo-500 text-indigo-400',
    generic: 'border-gray-500 text-gray-400',
  };

  let html = `<button onclick="filterByType(null)" data-filter="all"
    class="type-filter-btn text-xs px-2 py-0.5 rounded border border-cyan-500 text-cyan-400">
    Tous (${state.files.length})
  </button>`;

  Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
    const cls = typeColors[type] || 'border-gray-500 text-gray-400';
    html += `<button onclick="filterByType('${type}')" data-filter="${type}"
      class="type-filter-btn text-xs px-2 py-0.5 rounded border ${cls} opacity-70 hover:opacity-100">
      ${type} (${count})
    </button>`;
  });

  container.innerHTML = html;
}

function filterByType(type) {
  state.activeTypeFilter = type;
  const filtered = type ? state.files.filter(f => f.type === type) : state.files;
  renderFileTree(filtered);

  // Mettre à jour l'état visuel des boutons
  document.querySelectorAll('.type-filter-btn').forEach(btn => {
    const isActive = (type === null && btn.dataset.filter === 'all') || btn.dataset.filter === type;
    btn.style.opacity = isActive ? '1' : '0.6';
    btn.style.fontWeight = isActive ? '700' : '400';
  });
}

// ─── Arbre des fichiers ───────────────────────────────────────────────────────

const TYPE_ICONS = {
  auth: '🔐', syslog: '📋', kernel: '⚡', nginx: '🌐', apache: '🌐',
  mysql: '🗄️', postgresql: '🐘', cron: '⏰', daemon: '⚙️', firewall: '🛡️',
  fail2ban: '🚫', generic: '📄', boot: '🚀', mail: '📧', package: '📦',
  journal: '📒',
};

const TYPE_BORDER = {
  auth: 'border-l-red-500', syslog: 'border-l-blue-500', kernel: 'border-l-purple-500',
  nginx: 'border-l-green-500', apache: 'border-l-green-400', mysql: 'border-l-orange-500',
  cron: 'border-l-yellow-500', daemon: 'border-l-cyan-500', firewall: 'border-l-red-400',
  fail2ban: 'border-l-orange-400', generic: 'border-l-gray-600', boot: 'border-l-indigo-500',
};

function renderFileTree(files) {
  const container = document.getElementById('fileTreeContainer');
  if (!container) return;

  if (!files.length) {
    container.innerHTML = '<div class="text-gray-600 text-sm text-center py-8">Aucun fichier trouvé</div>';
    return;
  }

  container.innerHTML = files.map(file => {
    const selected = state.selectedFiles.has(file.path);
    const icon = TYPE_ICONS[file.type] || '📄';
    const border = TYPE_BORDER[file.type] || 'border-l-gray-600';
    const locked = !file.readable;

    return `
      <div class="file-item log-card flex items-center gap-3 px-3 py-2 rounded border-l-2 ${border}
                  ${selected ? 'selected' : ''} ${locked ? 'opacity-40' : 'cursor-pointer'}"
           ${!locked ? `onclick="toggleFile('${CSS.escape ? file.path.replace(/'/g, "\\'") : file.path}')"` : ''}>
        <input type="checkbox" class="flex-shrink-0 accent-cyan-400"
               ${selected ? 'checked' : ''} ${locked ? 'disabled' : ''}
               onchange="toggleFile('${file.path.replace(/'/g, "\\'")}'); event.stopPropagation()"
               onclick="event.stopPropagation()">
        <span class="flex-shrink-0 text-sm">${icon}</span>
        <div class="flex-1 min-w-0">
          <div class="text-sm text-gray-200 truncate font-medium">${escapeHtml(file.name)}</div>
          <div class="text-xs text-gray-600 truncate">${escapeHtml(file.relPath)}</div>
        </div>
        <div class="flex-shrink-0 text-right">
          <div class="text-xs text-gray-400">${formatSize(file.size)}</div>
          <div class="text-xs text-gray-600">${formatDate(file.modified)}</div>
        </div>
        ${locked ? '<span class="text-xs text-red-500 flex-shrink-0" title="Permission refusée">🔒</span>' : ''}
      </div>`;
  }).join('');
}

function toggleFile(filePath) {
  if (state.selectedFiles.has(filePath)) {
    state.selectedFiles.delete(filePath);
  } else {
    state.selectedFiles.add(filePath);
  }
  updateSelectionCount();
  updateAnalyzeButton();
  const filtered = state.activeTypeFilter
    ? state.files.filter(f => f.type === state.activeTypeFilter)
    : state.files;
  renderFileTree(filtered);
}

function selectAll() {
  state.files.filter(f => f.readable).forEach(f => state.selectedFiles.add(f.path));
  updateSelectionCount();
  updateAnalyzeButton();
  const filtered = state.activeTypeFilter
    ? state.files.filter(f => f.type === state.activeTypeFilter)
    : state.files;
  renderFileTree(filtered);
}

function deselectAll() {
  state.selectedFiles.clear();
  updateSelectionCount();
  updateAnalyzeButton();
  const filtered = state.activeTypeFilter
    ? state.files.filter(f => f.type === state.activeTypeFilter)
    : state.files;
  renderFileTree(filtered);
}

function updateSelectionCount() {
  const el = document.getElementById('selectionCount');
  const count = state.selectedFiles.size;
  if (el) el.textContent = `${count} fichier${count > 1 ? 's' : ''} sélectionné${count > 1 ? 's' : ''}`;
}

// ─── Chargement des modèles (provider-aware) ──────────────────────────────────

async function loadModels() {
  const select = document.getElementById('modelSelect');
  if (!select) return;

  try {
    const [settings, data] = await Promise.all([
      apiGet('/api/settings'),
      apiGet('/api/llm/models'),
    ]);
    const provider = data.provider || 'ollama';
    const models = data.models || [];
    state.availableModels = models;

    if (!models.length) {
      select.innerHTML = provider === 'ollama'
        ? '<option value="">Aucun modèle Ollama — lancez : ollama pull llama3.3:70b</option>'
        : '<option value="">Aucun modèle disponible</option>';
      if (provider === 'ollama') showToast('Aucun modèle Ollama disponible', 'warn', 6000);
      return;
    }

    if (provider === 'ollama') {
      select.innerHTML = models.map(m =>
        `<option value="${escapeHtml(m.name)}" ${m.name === settings.defaultModel ? 'selected' : ''}>
          ${escapeHtml(m.name)} (${formatSize(m.size || 0)})
        </option>`
      ).join('');
    } else {
      const defaultModel = settings[`${provider}Model`] || models[0]?.name;
      select.innerHTML = models.map(m =>
        `<option value="${escapeHtml(m.name)}" ${m.name === defaultModel ? 'selected' : ''}>
          ${escapeHtml(m.name)}${m.description ? ' — ' + escapeHtml(m.description) : ''}
        </option>`
      ).join('');
    }
  } catch (e) {
    if (select) select.innerHTML = `<option value="">LLM inaccessible</option>`;
  }
}

// ─── Checklist des tâches ─────────────────────────────────────────────────────

function renderChecklist() {
  const container = document.getElementById('taskChecklist');
  if (!container) return;

  container.innerHTML = Object.entries(CHECKLIST_TASKS).map(([id, task]) => {
    const checked = state.selectedTasks.has(id);
    return `
      <label class="flex items-center gap-3 px-3 py-2.5 rounded cursor-pointer
                     hover:bg-gray-800 transition-colors group border border-transparent
                     ${checked ? 'bg-gray-800/50 border-gray-700' : ''}">
        <input type="checkbox" class="accent-cyan-400 flex-shrink-0"
               ${checked ? 'checked' : ''}
               onchange="toggleTask('${id}', this.checked)">
        <span class="text-sm flex-shrink-0">${task.icon}</span>
        <span class="text-sm text-gray-300 group-hover:text-white flex-1">${task.label}</span>
        <span class="text-xs text-gray-600 font-mono">${id}</span>
      </label>`;
  }).join('');
}

function toggleTask(taskId, checked) {
  if (checked) {
    state.selectedTasks.add(taskId);
  } else {
    state.selectedTasks.delete(taskId);
  }
  updateAnalyzeButton();
}

function selectAllTasks() {
  Object.keys(CHECKLIST_TASKS).forEach(id => state.selectedTasks.add(id));
  renderChecklist();
  updateAnalyzeButton();
}

function deselectAllTasks() {
  state.selectedTasks.clear();
  renderChecklist();
  updateAnalyzeButton();
}

// ─── Lancement de l'analyse ───────────────────────────────────────────────────

function updateAnalyzeButton() {
  const btn = document.getElementById('analyzeBtn');
  if (!btn) return;
  const canAnalyze = state.selectedFiles.size > 0 && state.selectedTasks.size > 0 && !state.isAnalyzing;
  btn.disabled = !canAnalyze;
}

async function launchAnalysis() {
  if (state.isAnalyzing) return;

  const files = Array.from(state.selectedFiles);
  const tasks = Array.from(state.selectedTasks);
  const model = document.getElementById('modelSelect')?.value;

  if (!files.length) { showToast('Sélectionnez au moins un fichier', 'warn'); return; }
  if (!tasks.length) { showToast('Sélectionnez au moins une tâche', 'warn'); return; }
  if (!model) { showToast('Sélectionnez un modèle', 'warn'); return; }

  state.isAnalyzing = true;
  updateAnalyzeButton();
  showProgress(true);
  addLog('info', `Démarrage de l'analyse avec ${model}`);
  addLog('info', `${files.length} fichier(s) · ${tasks.length} tâche(s)`);

  // Simuler une progression pendant l'attente du LLM
  const progressInterval = simulateProgress();

  try {
    addLog('info', 'Lecture et pré-traitement des fichiers...');
    setProgressLabel('Lecture des fichiers...');

    const result = await apiPost('/api/analyze', { files, model, tasks });

    clearInterval(progressInterval);
    setProgress(100);

    if (result.success) {
      addLog('success', `Analyse terminée — ${result.report?.findings?.length || 0} finding(s) détecté(s)`);
      addLog('success', `Sévérité globale : ${result.report?.severity_global}`);

      // Afficher les résultats de traitement des fichiers
      result.fileResults?.forEach(fr => {
        if (fr.error) {
          addLog('error', `✗ ${fr.path} : ${fr.error}`);
        } else {
          addLog('success', `✓ ${fr.path} (${fr.lines} lignes analysées)`);
        }
      });

      showToast(`Analyse complète ! ${result.report?.findings?.length || 0} finding(s)`, 'success', 3000);

      // Rediriger vers le rapport après 1.5s
      setTimeout(() => {
        window.location.href = `report.html?id=${result.reportId}`;
      }, 1500);
    } else {
      addLog('error', `Erreur d'analyse : ${result.error}`);
      if (result.rawResponse) {
        addLog('warn', 'Le LLM n\'a pas retourné un JSON valide. Vérifiez le modèle sélectionné.');
      }
      showToast(result.error || 'Erreur lors de l\'analyse', 'error');
      state.isAnalyzing = false;
      showProgress(false);
      updateAnalyzeButton();
    }
  } catch (e) {
    clearInterval(progressInterval);
    addLog('error', `Erreur : ${e.message}`);
    showToast(`Erreur : ${e.message}`, 'error');
    state.isAnalyzing = false;
    showProgress(false);
    updateAnalyzeButton();
  }
}

// ─── Progression & Logs temps réel ────────────────────────────────────────────

let currentProgress = 0;

function showProgress(visible) {
  const section = document.getElementById('progressSection');
  if (section) section.style.display = visible ? 'block' : 'none';
  if (!visible) {
    currentProgress = 0;
    setProgress(0);
  }
}

function setProgress(pct) {
  currentProgress = pct;
  const bar = document.getElementById('progressBar');
  const label = document.getElementById('progressPct');
  if (bar) bar.style.width = `${pct}%`;
  if (label) label.textContent = `${Math.round(pct)}%`;
}

function setProgressLabel(msg) {
  const el = document.getElementById('progressLabel');
  if (el) el.textContent = msg;
}

function simulateProgress() {
  const stages = [
    { target: 20, label: 'Lecture des fichiers...', delay: 800 },
    { target: 40, label: 'Pré-traitement et filtrage...', delay: 1500 },
    { target: 60, label: 'Envoi au modèle LLM...', delay: 2000 },
    { target: 75, label: 'Analyse en cours (peut prendre plusieurs minutes)...', delay: 5000 },
    { target: 88, label: 'Traitement de la réponse...', delay: 3000 },
    { target: 95, label: 'Finalisation...', delay: 2000 },
  ];

  let stageIndex = 0;
  return setInterval(() => {
    if (stageIndex < stages.length) {
      const stage = stages[stageIndex];
      if (currentProgress < stage.target) {
        setProgress(Math.min(currentProgress + 0.5, stage.target));
        setProgressLabel(stage.label);
      } else {
        stageIndex++;
      }
    }
  }, 100);
}

function addLog(type, message) {
  const container = document.getElementById('analysisLogs');
  if (!container) return;

  const colors = { info: 'text-cyan-400', success: 'text-green-400', error: 'text-red-400', warn: 'text-yellow-400' };
  const prefixes = { info: '→', success: '✓', error: '✗', warn: '▲' };

  const now = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const line = document.createElement('div');
  line.className = `text-xs flex gap-2 ${colors[type] || 'text-gray-400'}`;
  line.innerHTML = `<span class="text-gray-600 flex-shrink-0">${now}</span><span>${prefixes[type] || '›'}</span><span>${escapeHtml(message)}</span>`;

  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}

// ─── Démarrage ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', initAnalyzer);
