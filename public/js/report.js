/**
 * report.js — Logique de la page de rapport
 * Rendu des findings, graphiques, modals, export Markdown
 */

'use strict';

// ─── État global ──────────────────────────────────────────────────────────────

let currentReport = null;

// ─── Initialisation ───────────────────────────────────────────────────────────

async function initReport() {
  const params = new URLSearchParams(window.location.search);
  const reportId = params.get('id');

  if (!reportId) {
    // Charger le rapport le plus récent
    try {
      const history = await apiGet('/api/reports/history');
      if (history.length) {
        window.location.replace(`report.html?id=${history[0].id}`);
        return;
      }
    } catch { /* Ignorer */ }
    renderEmptyState();
    return;
  }

  try {
    const data = await apiGet(`/api/reports/${reportId}`);
    currentReport = data;
    renderReport(data);
  } catch (e) {
    renderError(e.message);
  }
}

// ─── Rendu du rapport complet ─────────────────────────────────────────────────

function renderReport(data) {
  const { report, timestamp, model, files, fileResults } = data;

  if (!report) {
    renderError('Rapport vide ou corrompu');
    return;
  }

  document.title = `Veylog — Rapport ${report.severity_global || '?'}`;

  renderSummary(report, timestamp, model, files);
  renderStatistics(report);
  renderFindings(report.findings || []);
  renderChecklist(report.checklist_coverage || {});
  renderRecommendations(report.recommendations || []);
  renderCommands(report.commands_suggested || []);
  renderFileResults(fileResults || []);
  drawSeverityChart(report.findings || []);
}

// ─── Résumé exécutif ──────────────────────────────────────────────────────────

function renderSummary(report, timestamp, model, files) {
  const sev = report.severity_global || '?';

  // Badge sévérité géant
  const el = document.getElementById('severityBadge');
  if (el) {
    el.className = `severity-badge ${severityClass(sev)} text-2xl px-6 py-3 rounded-lg font-bold tracking-widest`;
    el.textContent = sev;
  }

  const summaryEl = document.getElementById('reportSummary');
  if (summaryEl) summaryEl.textContent = report.summary || 'Aucun résumé disponible.';

  const metaEl = document.getElementById('reportMeta');
  if (metaEl) {
    metaEl.innerHTML = `
      <span class="text-gray-500">Généré le</span>
      <span class="text-gray-300">${formatDateFull(timestamp)}</span>
      <span class="text-gray-600">·</span>
      <span class="text-gray-500">Modèle</span>
      <span class="text-cyan-400 font-mono">${escapeHtml(model || '—')}</span>
      <span class="text-gray-600">·</span>
      <span class="text-gray-500">${(files || []).length} fichier(s)</span>
      <span class="text-gray-600">·</span>
      <span class="text-gray-500">${(report.findings || []).length} finding(s)</span>
    `;
  }
}

// ─── Statistiques ─────────────────────────────────────────────────────────────

function renderStatistics(report) {
  const stats = report.statistics || {};
  const statsEl = document.getElementById('statsGrid');
  if (!statsEl) return;

  const findingsBySev = {};
  (report.findings || []).forEach(f => {
    findingsBySev[f.severity] = (findingsBySev[f.severity] || 0) + 1;
  });

  statsEl.innerHTML = `
    <div class="panel p-4 text-center">
      <div class="text-3xl font-bold text-red-400">${findingsBySev['CRITIQUE'] || 0}</div>
      <div class="text-xs text-gray-500 mt-1">CRITIQUE</div>
    </div>
    <div class="panel p-4 text-center">
      <div class="text-3xl font-bold text-orange-400">${findingsBySev['ÉLEVÉ'] || 0}</div>
      <div class="text-xs text-gray-500 mt-1">ÉLEVÉ</div>
    </div>
    <div class="panel p-4 text-center">
      <div class="text-3xl font-bold text-yellow-400">${findingsBySev['MOYEN'] || 0}</div>
      <div class="text-xs text-gray-500 mt-1">MOYEN</div>
    </div>
    <div class="panel p-4 text-center">
      <div class="text-3xl font-bold text-green-400">${findingsBySev['FAIBLE'] || 0}</div>
      <div class="text-xs text-gray-500 mt-1">FAIBLE</div>
    </div>
    <div class="panel p-4 text-center">
      <div class="text-3xl font-bold text-indigo-400">${findingsBySev['INFO'] || 0}</div>
      <div class="text-xs text-gray-500 mt-1">INFO</div>
    </div>
    <div class="panel p-4 text-center">
      <div class="text-3xl font-bold text-gray-300">${stats.total_analyzed || 0}</div>
      <div class="text-xs text-gray-500 mt-1">LIGNES ANALYSÉES</div>
    </div>
  `;
}

// ─── Findings ─────────────────────────────────────────────────────────────────

const SEVERITY_ORDER_MAP = { CRITIQUE: 0, 'ÉLEVÉ': 1, MOYEN: 2, FAIBLE: 3, INFO: 4 };

let activeFilter = null;

function renderFindings(findings, filter = null) {
  activeFilter = filter;
  const container = document.getElementById('findingsList');
  if (!container) return;

  const sorted = [...findings].sort(
    (a, b) => (SEVERITY_ORDER_MAP[a.severity] ?? 99) - (SEVERITY_ORDER_MAP[b.severity] ?? 99)
  );

  const filtered = filter ? sorted.filter(f => f.severity === filter) : sorted;

  if (!filtered.length) {
    container.innerHTML = `
      <div class="text-gray-600 text-sm text-center py-12">
        ${filter ? `Aucun finding de sévérité ${filter}` : 'Aucun finding détecté — système sain ✓'}
      </div>`;
    return;
  }

  container.innerHTML = filtered.map((finding, idx) => `
    <div class="finding-card panel border border-gray-800 hover:border-gray-700 transition-colors cursor-pointer"
         onclick="openFindingModal(${findings.indexOf(finding)})">
      <div class="flex items-start gap-3 p-4">
        <div class="flex-shrink-0 mt-0.5">
          ${severityBadge(finding.severity)}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-start justify-between gap-2">
            <div>
              <span class="text-xs text-gray-500 font-mono">${escapeHtml(finding.category || '—')}</span>
              <h3 class="text-sm font-semibold text-white mt-0.5">${escapeHtml(finding.title)}</h3>
            </div>
            <span class="text-xs text-gray-600 flex-shrink-0">#${idx + 1}</span>
          </div>
          <p class="text-xs text-gray-400 mt-1.5 line-clamp-2">${escapeHtml(finding.description)}</p>
          ${finding.evidence?.length
            ? `<div class="mt-2 bg-gray-900 border border-gray-800 rounded px-3 py-1.5 font-mono text-xs text-gray-400 truncate">
                 ${escapeHtml(finding.evidence[0])}
                 ${finding.evidence.length > 1 ? `<span class="text-gray-600"> +${finding.evidence.length - 1} ligne(s)</span>` : ''}
               </div>`
            : ''}
        </div>
        <span class="text-gray-600 flex-shrink-0 text-lg">›</span>
      </div>
    </div>
  `).join('');

  // Mettre à jour le compteur
  const countEl = document.getElementById('findingsCount');
  if (countEl) countEl.textContent = `${filtered.length} finding(s)${filter ? ` [${filter}]` : ''}`;
}

function filterFindings(sev) {
  const findings = currentReport?.report?.findings || [];
  renderFindings(findings, sev === activeFilter ? null : sev);

  // Mettre à jour les boutons de filtre
  document.querySelectorAll('.findings-filter-btn').forEach(btn => {
    const isActive = btn.dataset.sev === (sev === activeFilter ? null : sev);
    btn.style.opacity = isActive ? '1' : '0.5';
  });
}

// ─── Modal de détail d'un finding ─────────────────────────────────────────────

function openFindingModal(index) {
  const findings = currentReport?.report?.findings || [];
  const finding = findings[index];
  if (!finding) return;

  const modal = document.getElementById('findingModal');
  if (!modal) return;

  document.getElementById('modalSeverity').innerHTML = severityBadge(finding.severity, 'sm');
  document.getElementById('modalCategory').textContent = finding.category || '—';
  document.getElementById('modalTitle').textContent = finding.title || '';
  document.getElementById('modalDescription').textContent = finding.description || '';
  document.getElementById('modalRecommendation').textContent = finding.recommendation || '';

  const evidenceEl = document.getElementById('modalEvidence');
  if (evidenceEl) {
    if (finding.evidence?.length) {
      evidenceEl.innerHTML = finding.evidence.map(e =>
        `<div class="text-xs text-green-300 font-mono">${escapeHtml(e)}</div>`
      ).join('');
      evidenceEl.parentElement.style.display = '';
    } else {
      evidenceEl.parentElement.style.display = 'none';
    }
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.body.style.overflow = 'hidden';
}

function closeFindingModal() {
  const modal = document.getElementById('findingModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
  document.body.style.overflow = '';
}

// Fermer la modal en cliquant sur l'overlay
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeFindingModal();
});

// ─── Checklist de couverture ──────────────────────────────────────────────────

const TASK_LABELS = {
  task1: 'Authentification & SSH',
  task2: 'Élévation de privilèges',
  task3: 'Activité réseau suspecte',
  task4: 'Erreurs système & kernel',
  task5: 'Services défaillants',
  task6: 'Tentatives d\'intrusion',
  task7: 'Modifications système',
  task8: 'Activités malveillantes',
  task9: 'Ressources système',
  task10: 'Services web',
};

function renderChecklist(coverage) {
  const container = document.getElementById('checklistGrid');
  if (!container) return;

  const entries = Object.entries(coverage);
  if (!entries.length) {
    container.innerHTML = '<div class="text-gray-600 text-xs col-span-2">Couverture non disponible</div>';
    return;
  }

  container.innerHTML = entries.map(([taskId, data]) => {
    const covered = data.covered === true;
    const label = TASK_LABELS[taskId] || taskId;
    return `
      <div class="flex items-start gap-2.5 p-2.5 rounded ${covered ? 'bg-green-900/10' : 'bg-gray-900/50'}
                  border ${covered ? 'border-green-900/30' : 'border-gray-800'}">
        <span class="flex-shrink-0 text-sm mt-0.5">${covered ? '✅' : '⬜'}</span>
        <div class="min-w-0">
          <div class="text-xs font-semibold ${covered ? 'text-green-300' : 'text-gray-500'}">${label}</div>
          <div class="text-xs text-gray-600 mt-0.5 truncate" title="${escapeHtml(data.notes || '')}">${escapeHtml(data.notes || '—')}</div>
        </div>
      </div>`;
  }).join('');
}

// ─── Recommandations ──────────────────────────────────────────────────────────

function exportRecommendations() {
  const report = currentReport?.report;
  if (!report) return;

  const lines = [];
  lines.push(`# Recommandations Veylog — ${new Date().toLocaleDateString('fr-FR')}`);
  lines.push(`Sévérité globale : ${report.severity_global}`);
  lines.push('');

  if (report.recommendations?.length) {
    lines.push('## Recommandations');
    report.recommendations.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
    lines.push('');
  }

  if (report.commands_suggested?.length) {
    lines.push('## Commandes suggérées');
    report.commands_suggested.forEach(c => lines.push(`    ${c}`));
    lines.push('');
  }

  if (report.findings?.length) {
    lines.push('## Findings');
    report.findings.forEach((f, i) => {
      lines.push(`### #${i + 1} [${f.severity}] ${f.title}`);
      lines.push(`Catégorie : ${f.category}`);
      lines.push(`${f.description}`);
      if (f.recommendation) lines.push(`Action : ${f.recommendation}`);
      lines.push('');
    });
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `veylog-rapport-${Date.now()}.md`;
  a.click();
}

function renderRecommendations(recommendations) {
  const container = document.getElementById('recommendationsList');
  if (!container) return;

  if (!recommendations.length) {
    container.innerHTML = '<div class="text-gray-600 text-xs">Aucune recommandation</div>';
    return;
  }

  container.innerHTML = recommendations.map((rec, i) => `
    <div class="flex gap-3 p-3 rounded bg-gray-900/50 border border-gray-800 hover:border-gray-700 transition-colors">
      <span class="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-900/50 border border-cyan-800 flex items-center justify-center text-cyan-400 text-xs font-bold">${i + 1}</span>
      <p class="text-sm text-gray-300 flex-1">${escapeHtml(rec)}</p>
    </div>
  `).join('');
}

// ─── Commandes suggérées ──────────────────────────────────────────────────────

function renderCommands(commands) {
  const container = document.getElementById('commandsList');
  if (!container) return;

  if (!commands.length) {
    container.innerHTML = '<div class="text-gray-600 text-xs">Aucune commande suggérée</div>';
    return;
  }

  container.innerHTML = commands.map(cmd => `
    <div class="group flex items-center gap-2 bg-gray-950 border border-gray-800 rounded px-4 py-2.5 hover:border-gray-700 transition-colors">
      <span class="text-cyan-400 font-mono text-xs flex-shrink-0">$</span>
      <code class="text-green-300 font-mono text-sm flex-1 break-all">${escapeHtml(cmd)}</code>
      <button onclick="copyToClipboard('${escapeHtml(cmd).replace(/'/g, "&#39;")}')"
              class="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity btn-terminal text-xs px-2 py-0.5 rounded">
        copier
      </button>
    </div>
  `).join('');
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('Commande copiée !', 'success', 2000);
  }).catch(() => {
    showToast('Impossible de copier', 'error');
  });
}

// ─── Résultats des fichiers ───────────────────────────────────────────────────

function renderFileResults(fileResults) {
  const container = document.getElementById('fileResultsList');
  if (!container) return;

  container.innerHTML = fileResults.map(fr => `
    <div class="flex items-center gap-2 text-xs py-1">
      <span class="${fr.error ? 'text-red-400' : 'text-green-400'}">${fr.error ? '✗' : '✓'}</span>
      <span class="text-gray-400 font-mono truncate flex-1" title="${escapeHtml(fr.path)}">${escapeHtml(fr.path)}</span>
      <span class="flex-shrink-0 ${fr.error ? 'text-red-500' : 'text-gray-600'}">
        ${fr.error ? escapeHtml(fr.error) : `${fr.lines} lignes`}
      </span>
    </div>
  `).join('');
}

// ─── Graphique camembert sévérités ────────────────────────────────────────────

function drawSeverityChart(findings) {
  const canvas = document.getElementById('severityChart');
  if (!canvas || !findings.length) return;

  const ctx = canvas.getContext('2d');
  const counts = { CRITIQUE: 0, 'ÉLEVÉ': 0, MOYEN: 0, FAIBLE: 0, INFO: 0 };
  findings.forEach(f => { if (counts[f.severity] !== undefined) counts[f.severity]++; });

  const data = Object.entries(counts).filter(([, v]) => v > 0);
  if (!data.length) return;

  const colors = {
    'CRITIQUE': '#ef4444',
    'ÉLEVÉ':    '#f97316',
    'MOYEN':    '#eab308',
    'FAIBLE':   '#22c55e',
    'INFO':     '#818cf8',
  };

  const total = data.reduce((s, [, v]) => s + v, 0);
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = Math.min(cx, cy) - 20;
  const innerRadius = radius * 0.55; // Donut chart

  let startAngle = -Math.PI / 2;

  data.forEach(([sev, count]) => {
    const slice = (count / total) * 2 * Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, startAngle, startAngle + slice);
    ctx.closePath();
    ctx.fillStyle = colors[sev];
    ctx.fill();

    // Trou central pour l'effet donut
    ctx.beginPath();
    ctx.arc(cx, cy, innerRadius, 0, 2 * Math.PI);
    ctx.fillStyle = '#141720';
    ctx.fill();

    startAngle += slice;
  });

  // Texte central
  ctx.fillStyle = '#e5e7eb';
  ctx.font = `bold 28px 'JetBrains Mono', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(total.toString(), cx, cy - 8);
  ctx.font = `11px 'JetBrains Mono', monospace`;
  ctx.fillStyle = '#6b7280';
  ctx.fillText('findings', cx, cy + 14);

  // Légende
  const legendEl = document.getElementById('chartLegend');
  if (legendEl) {
    legendEl.innerHTML = data.map(([sev, count]) => `
      <div class="flex items-center gap-1.5 text-xs">
        <span class="w-2.5 h-2.5 rounded-sm flex-shrink-0" style="background:${colors[sev]}"></span>
        <span class="text-gray-400">${sev}</span>
        <span class="text-gray-300 font-bold ml-auto">${count}</span>
      </div>
    `).join('');
  }
}

// ─── Export Markdown ──────────────────────────────────────────────────────────

function exportMarkdown() {
  if (!currentReport) {
    showToast('Aucun rapport à exporter', 'warn');
    return;
  }
  const md = reportToMarkdown(currentReport);
  const filename = `veylog-rapport-${currentReport.id || Date.now()}.md`;
  downloadText(md, filename);
  showToast('Rapport exporté en Markdown', 'success');
}

// ─── États vides ──────────────────────────────────────────────────────────────

function renderEmptyState() {
  const main = document.getElementById('reportContent');
  if (main) {
    main.innerHTML = `
      <div class="flex flex-col items-center justify-center h-96 text-center">
        <div class="text-6xl mb-4">📋</div>
        <h2 class="text-xl font-bold text-gray-400 mb-2">Aucun rapport disponible</h2>
        <p class="text-gray-600 mb-6">Lancez une analyse pour générer votre premier rapport.</p>
        <a href="analyze.html" class="btn-primary px-4 py-2 rounded text-sm font-semibold">
          → Lancer une analyse
        </a>
      </div>`;
  }
}

function renderError(msg) {
  const main = document.getElementById('reportContent');
  if (main) {
    main.innerHTML = `
      <div class="flex flex-col items-center justify-center h-96 text-center">
        <div class="text-6xl mb-4">⚠️</div>
        <h2 class="text-xl font-bold text-red-400 mb-2">Erreur de chargement</h2>
        <p class="text-gray-500">${escapeHtml(msg)}</p>
      </div>`;
  }
}

// ─── Démarrage ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', initReport);
