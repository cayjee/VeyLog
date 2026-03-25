/**
 * app.js — Utilitaires partagés Veylog
 * Fonctions communes à toutes les pages
 */

'use strict';

// ─── API Helpers ─────────────────────────────────────────────────────────────

/**
 * Effectuer un GET JSON vers l'API backend.
 */
async function apiGet(endpoint) {
  const res = await fetch(endpoint);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Effectuer un POST JSON vers l'API backend.
 */
async function apiPost(endpoint, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ─── Formatage ────────────────────────────────────────────────────────────────

/**
 * Formater une taille en octets en unité lisible.
 */
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/**
 * Formater une date ISO en format court lisible.
 */
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;

  if (diff < 60000) return 'à l\'instant';
  if (diff < 3600000) return `il y a ${Math.floor(diff / 60000)} min`;
  if (diff < 86400000) return `il y a ${Math.floor(diff / 3600000)} h`;
  if (diff < 604800000) return `il y a ${Math.floor(diff / 86400000)} j`;

  return d.toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Formater une date ISO complète.
 */
function formatDateFull(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// ─── Sévérité ─────────────────────────────────────────────────────────────────

const SEVERITY_ORDER = { CRITIQUE: 0, 'ÉLEVÉ': 1, MOYEN: 2, FAIBLE: 3, INFO: 4, OK: 5 };

/**
 * Retourner les classes CSS Tailwind pour un badge de sévérité.
 */
function severityClass(sev) {
  const map = {
    'CRITIQUE': 'severity-critique',
    'ÉLEVÉ':    'severity-eleve',
    'MOYEN':    'severity-moyen',
    'FAIBLE':   'severity-faible',
    'INFO':     'severity-info',
    'OK':       'severity-ok',
  };
  return map[sev?.toUpperCase()] || 'severity-info';
}

/**
 * Retourner la couleur hex principale pour une sévérité.
 */
function severityColor(sev) {
  const map = {
    'CRITIQUE': '#ef4444',
    'ÉLEVÉ':    '#f97316',
    'MOYEN':    '#eab308',
    'FAIBLE':   '#22c55e',
    'INFO':     '#818cf8',
    'OK':       '#22c55e',
  };
  return map[sev?.toUpperCase()] || '#6b7280';
}

/**
 * Générer le HTML d'un badge de sévérité.
 */
function severityBadge(sev, size = 'sm') {
  const cls = severityClass(sev);
  const textSize = size === 'lg' ? 'text-base px-3 py-1' : 'text-xs px-2 py-0.5';
  return `<span class="severity-badge ${cls} ${textSize} rounded font-semibold">${sev || '?'}</span>`;
}

// ─── Toast Notifications ─────────────────────────────────────────────────────

let toastCount = 0;

/**
 * Afficher une notification toast en bas à droite.
 * @param {string} message - Message à afficher
 * @param {'info'|'success'|'error'|'warn'} type - Type de notification
 * @param {number} duration - Durée en ms (0 = permanent)
 */
function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const id = `toast-${++toastCount}`;
  const icons = {
    info:    '◆',
    success: '✓',
    error:   '✗',
    warn:    '▲',
  };
  const colors = {
    info:    'border-cyan-500 text-cyan-400',
    success: 'border-green-500 text-green-400',
    error:   'border-red-500 text-red-400',
    warn:    'border-yellow-500 text-yellow-400',
  };

  const div = document.createElement('div');
  div.id = id;
  div.className = `toast panel border ${colors[type] || colors.info} px-4 py-2.5 text-sm flex items-center gap-2 min-w-64 max-w-sm shadow-lg`;
  div.innerHTML = `
    <span class="flex-shrink-0 font-bold">${icons[type] || '◆'}</span>
    <span class="flex-1">${escapeHtml(message)}</span>
    <button onclick="document.getElementById('${id}').remove()" class="flex-shrink-0 text-gray-500 hover:text-gray-300 ml-1">✕</button>
  `;

  container.appendChild(div);

  if (duration > 0) {
    setTimeout(() => {
      const el = document.getElementById(id);
      if (el) {
        el.style.transition = 'opacity 0.3s, transform 0.3s';
        el.style.opacity = '0';
        el.style.transform = 'translateX(100%)';
        setTimeout(() => el.remove(), 300);
      }
    }, duration);
  }
}

// ─── Statut Ollama sidebar ────────────────────────────────────────────────────

/**
 * Vérifier et afficher le statut Ollama dans la sidebar.
 */
async function checkOllamaStatus() {
  const dot = document.getElementById('ollamaStatusDot');
  const text = document.getElementById('ollamaStatusText');
  if (!dot) return;

  try {
    const data = await apiGet('/api/health');
    if (data.ollama === 'connected') {
      dot.className = 'status-dot online';
      if (text) text.textContent = 'Ollama connecté';
    } else {
      dot.className = 'status-dot offline';
      if (text) text.textContent = 'Ollama hors ligne';
    }
    return data.ollama === 'connected';
  } catch {
    if (dot) dot.className = 'status-dot offline';
    if (text) text.textContent = 'Erreur connexion';
    return false;
  }
}

// ─── Sécurité HTML ────────────────────────────────────────────────────────────

/**
 * Échapper les caractères spéciaux HTML pour prévenir les injections XSS.
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Export Markdown ──────────────────────────────────────────────────────────

/**
 * Convertir un rapport JSON en texte Markdown exportable.
 */
function reportToMarkdown(reportData) {
  const { report, timestamp, model, files } = reportData;
  if (!report) return '# Rapport vide';

  const lines = [];
  const sev = report.severity_global || '?';

  lines.push(`# Rapport Veylog — ${sev}`);
  lines.push('');
  lines.push(`> Généré le ${formatDateFull(timestamp)} avec le modèle \`${model || 'inconnu'}\``);
  lines.push('');

  lines.push('## Résumé exécutif');
  lines.push('');
  lines.push(report.summary || '_Aucun résumé disponible_');
  lines.push('');

  lines.push(`**Sévérité globale :** ${sev}`);
  lines.push('');

  if (report.statistics) {
    lines.push('## Statistiques');
    lines.push('');
    lines.push(`| Indicateur | Valeur |`);
    lines.push(`|---|---|`);
    lines.push(`| Erreurs | ${report.statistics.errors || 0} |`);
    lines.push(`| Avertissements | ${report.statistics.warnings || 0} |`);
    lines.push(`| Lignes suspectes | ${report.statistics.suspicious || 0} |`);
    lines.push(`| Total analysé | ${report.statistics.total_analyzed || 0} |`);
    lines.push('');
  }

  if (files?.length) {
    lines.push('## Fichiers analysés');
    lines.push('');
    files.forEach(f => lines.push(`- \`${f}\``));
    lines.push('');
  }

  if (report.findings?.length) {
    lines.push('## Findings');
    lines.push('');
    const sorted = [...report.findings].sort(
      (a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99)
    );
    sorted.forEach((f, i) => {
      lines.push(`### ${i + 1}. [${f.severity}] ${f.title}`);
      lines.push('');
      lines.push(`**Catégorie :** ${f.category || '—'}`);
      lines.push('');
      lines.push(f.description || '');
      lines.push('');
      if (f.evidence?.length) {
        lines.push('**Preuves :**');
        lines.push('```');
        f.evidence.forEach(e => lines.push(e));
        lines.push('```');
        lines.push('');
      }
      if (f.recommendation) {
        lines.push(`**Recommandation :** ${f.recommendation}`);
        lines.push('');
      }
    });
  }

  if (report.recommendations?.length) {
    lines.push('## Recommandations prioritaires');
    lines.push('');
    report.recommendations.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
    lines.push('');
  }

  if (report.commands_suggested?.length) {
    lines.push('## Commandes suggérées');
    lines.push('');
    lines.push('```bash');
    report.commands_suggested.forEach(c => lines.push(c));
    lines.push('```');
    lines.push('');
  }

  lines.push('---');
  lines.push('_Rapport généré par [Veylog](https://github.com/cayjee/veylog) — Analyseur de logs Linux propulsé par LLM local_');

  return lines.join('\n');
}

/**
 * Déclencher le téléchargement d'un fichier texte.
 */
function downloadText(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Init commune ─────────────────────────────────────────────────────────────

// Vérifier le statut Ollama au chargement + toutes les 30 secondes
document.addEventListener('DOMContentLoaded', () => {
  checkOllamaStatus();
  setInterval(checkOllamaStatus, 30000);
});
