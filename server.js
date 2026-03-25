/**
 * Veylog — Serveur Backend
 * Analyseur de logs Linux propulsé par LLM local via Ollama
 * Architecture : Node.js 20 + Express 4
 */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG_PATH = '/app/config/settings.json';

// ─── Configuration par défaut ────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  logsPath: process.env.LOGS_PATH || '/var/log',
  ollamaUrl: process.env.OLLAMA_URL || 'http://ollama:11434',
  defaultModel: process.env.DEFAULT_MODEL || 'llama3.3:70b',
  maxLines: parseInt(process.env.MAX_LINES) || 300,
};

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers config ──────────────────────────────────────────────────────────

/**
 * Charger la configuration depuis le disque, avec fallback sur les valeurs par défaut.
 */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return { ...DEFAULT_CONFIG, ...saved };
    }
  } catch (e) {
    console.error('[Config] Erreur de lecture :', e.message);
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Persister la configuration sur le disque.
 */
function saveConfig(config) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

// ─── Helpers HTTP Ollama ──────────────────────────────────────────────────────

/**
 * Effectuer une requête HTTP/HTTPS vers l'API Ollama.
 * @param {string} urlStr - URL complète
 * @param {string} method - GET | POST
 * @param {object|null} body - Corps de la requête (sérialisé en JSON)
 * @param {number} timeoutMs - Timeout en millisecondes
 */
function ollamaRequest(urlStr, method = 'GET', body = null, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(urlStr);
    } catch (e) {
      return reject(new Error(`URL Ollama invalide : ${urlStr}`));
    }

    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 11434),
      path: parsedUrl.pathname + (parsedUrl.search || ''),
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = transport.request(options, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, data: { response: raw } });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timeout Ollama après ${timeoutMs / 1000}s`));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Helpers fichiers logs ────────────────────────────────────────────────────

/**
 * Détecter le type de fichier log à partir de son nom.
 */
function detectLogType(filename) {
  const n = filename.toLowerCase();
  if (/auth|secure/.test(n)) return 'auth';
  if (/syslog|messages/.test(n)) return 'syslog';
  if (/kern/.test(n)) return 'kernel';
  if (/nginx/.test(n)) return 'nginx';
  if (/apache|httpd/.test(n)) return 'apache';
  if (/mysql|mariadb/.test(n)) return 'mysql';
  if (/postgresql|postgres/.test(n)) return 'postgresql';
  if (/fail2ban/.test(n)) return 'fail2ban';
  if (/ufw|firewall|iptables|nftables/.test(n)) return 'firewall';
  if (/dpkg|apt/.test(n)) return 'package';
  if (/daemon/.test(n)) return 'daemon';
  if (/boot/.test(n)) return 'boot';
  if (/cron/.test(n)) return 'cron';
  if (/mail|postfix|sendmail/.test(n)) return 'mail';
  if (/journal/.test(n)) return 'journal';
  return 'generic';
}

/**
 * Vérifier si un fichier est lisible par le processus courant.
 */
function isReadable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scanner récursivement un répertoire et retourner les fichiers.
 */
function scanDirectory(dir, base = '') {
  const results = [];
  let items;
  try {
    items = fs.readdirSync(dir);
  } catch {
    return results; // Dossier inaccessible
  }

  for (const item of items) {
    const fullPath = path.join(dir, item);
    const relPath = base ? `${base}/${item}` : item;
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        // Récursion limitée à 2 niveaux pour éviter les boucles symboliques
        if (base.split('/').length < 2) {
          results.push(...scanDirectory(fullPath, relPath));
        }
      } else if (stat.isFile() && stat.size > 0) {
        results.push({
          path: fullPath,
          name: item,
          relPath,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          type: detectLogType(item),
          readable: isReadable(fullPath),
        });
      }
    } catch {
      // Fichier inaccessible ou erreur stat — ignorer
    }
  }
  return results;
}

/**
 * Lire les N dernières lignes d'un fichier en évitant de charger > 10MB en mémoire.
 */
function readLastLines(filePath, maxLines) {
  const stat = fs.statSync(filePath);
  let content;

  if (stat.size > 10 * 1024 * 1024) {
    // Fichier volumineux : lire les 2 derniers MB seulement
    const chunkSize = 2 * 1024 * 1024;
    const offset = Math.max(0, stat.size - chunkSize);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(chunkSize);
    const bytesRead = fs.readSync(fd, buf, 0, chunkSize, offset);
    fs.closeSync(fd);
    content = buf.slice(0, bytesRead).toString('utf8');
    // Supprimer la première ligne potentiellement tronquée
    const firstNl = content.indexOf('\n');
    if (firstNl > 0) content = content.slice(firstNl + 1);
  } else {
    content = fs.readFileSync(filePath, 'utf8');
  }

  const lines = content.split('\n').filter(l => l.trim().length > 0);
  return { lines, total: lines.length, content, truncated: stat.size > 10 * 1024 * 1024 };
}

/**
 * Pré-filtrer les lignes pour ne garder que celles pertinentes en sécurité.
 */
function filterSecurityLines(lines) {
  const pattern = /error|warn|fail|denied|refused|killed|oom|attack|invalid|unauthorized|forbidden|critical|alert|emerg|panic|segfault|exploit|inject|scan|brute|overflow|chmod|chown|passwd|sudo|su\s|rootkit|malware|virus|trojan|backdoor|shell|exec\(|eval\(/i;
  return lines.filter(l => pattern.test(l));
}

/**
 * Dédupliquer les lignes similaires (même message, timestamps différents).
 * Résume les occurrences répétées : "... (×47)".
 */
function deduplicateLines(lines) {
  // Normaliser une ligne : retirer timestamps, PIDs numériques
  const normalize = (l) =>
    l.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\b/g, 'TIMESTAMP')
     .replace(/\[\d+\]/g, '[PID]')
     .replace(/\b\d{4,}\b/g, 'NUM');

  const result = [];
  let prevNorm = null;
  let prevLine = null;
  let count = 0;

  for (const line of lines) {
    const norm = normalize(line);
    if (norm === prevNorm) {
      count++;
    } else {
      if (prevLine !== null) {
        result.push(prevLine);
        if (count > 1) result.push(`  └─ ... répété ×${count}`);
      }
      prevLine = line;
      prevNorm = norm;
      count = 1;
    }
  }
  if (prevLine !== null) {
    result.push(prevLine);
    if (count > 1) result.push(`  └─ ... répété ×${count}`);
  }

  return result;
}

// ─── Construction du prompt Ollama ───────────────────────────────────────────

const TASK_DESCRIPTIONS = {
  task1: 'Authentification & SSH : connexions échouées, root login, clés inconnues, sessions suspectes',
  task2: 'Élévation de privilèges : sudo/su, accès root non autorisé, SUID/SGID suspects',
  task3: 'Activité réseau suspecte : connexions vers IPs inconnues, ports inhabituels, scans, trafic nocturne',
  task4: 'Erreurs système & kernel : panics, OOM killer, erreurs matérielles, segfaults, crashs',
  task5: 'Services défaillants : crashs en boucle, erreurs de démarrage, timeouts, watchdog',
  task6: 'Tentatives d\'intrusion : brute force, injections, exploits, DDoS, reconnaissance',
  task7: 'Modifications système : /etc/passwd, /etc/shadow, crontab, binaires système altérés',
  task8: 'Activités malveillantes : comportements rootkit/malware, processus suspects, exfiltration',
  task9: 'Ressources système : OOM kills, disque saturé, swap épuisé, quotas dépassés',
  task10: 'Services web : erreurs 4xx/5xx massives, injection SQL/XSS, scans de vulnérabilités',
};

/**
 * Construire le prompt complet envoyé à Ollama.
 */
function buildAnalysisPrompt(logChunks, selectedTasks) {
  const tasksBlock = selectedTasks
    .map(t => `  - [${t}] ${TASK_DESCRIPTIONS[t] || t}`)
    .join('\n');

  const logsBlock = logChunks
    .map(c =>
      `=== FICHIER : ${c.file} | TYPE : ${c.type} | ${c.filteredLines}/${c.totalLines} lignes ===\n${c.content}`
    )
    .join('\n\n');

  return `Tu es Veylog, expert senior en sécurité Linux et analyse forensique de logs.
Analyse les logs ci-dessous et génère un rapport de sécurité complet.

TÂCHES À COUVRIR :
${tasksBlock}

LOGS À ANALYSER :
${logsBlock}

INSTRUCTIONS :
- Identifie TOUS les problèmes, même mineurs
- Pour chaque finding, cite les lignes exactes comme preuves (champ "evidence")
- Sévérités : CRITIQUE (exploitation active/confirmée), ÉLEVÉ (risque important), MOYEN (risque modéré), FAIBLE (best practice), INFO (informatif)
- Propose des commandes shell précises et applicables
- Si aucun problème pour une tâche : indique covered=false avec explication

Réponds UNIQUEMENT avec ce JSON valide (aucun markdown, aucune explication autour) :
{
  "summary": "Résumé exécutif en 2-3 phrases",
  "severity_global": "CRITIQUE|ÉLEVÉ|MOYEN|FAIBLE|OK",
  "statistics": {
    "errors": 0,
    "warnings": 0,
    "suspicious": 0,
    "total_analyzed": 0
  },
  "findings": [
    {
      "severity": "CRITIQUE|ÉLEVÉ|MOYEN|FAIBLE|INFO",
      "category": "Authentification|Réseau|Système|Malware|Web|Ressources|Intégrité",
      "title": "Titre court et précis",
      "description": "Description détaillée du problème",
      "evidence": ["ligne de log exacte 1", "ligne de log exacte 2"],
      "recommendation": "Action corrective concrète recommandée"
    }
  ],
  "checklist_coverage": {
    "task1": { "covered": true, "notes": "Explication de ce qui a été trouvé ou non" }
  },
  "recommendations": [
    "Recommandation prioritaire 1",
    "Recommandation prioritaire 2"
  ],
  "commands_suggested": [
    "journalctl -p err --since '24 hours ago'",
    "grep 'Failed password' /var/log/auth.log | awk '{print $11}' | sort | uniq -c | sort -rn | head -20"
  ]
}`;
}

// ─── Historique des analyses ──────────────────────────────────────────────────

function updateHistory(reportId, report, files) {
  const histPath = '/app/config/history.json';
  let history = [];
  try {
    if (fs.existsSync(histPath)) {
      history = JSON.parse(fs.readFileSync(histPath, 'utf8'));
    }
  } catch { /* Historique corrompu ou absent */ }

  history.unshift({
    id: reportId,
    timestamp: new Date().toISOString(),
    severity: report.severity_global || 'INCONNU',
    summary: (report.summary || '').substring(0, 120),
    filesCount: files.length,
    findingsCount: (report.findings || []).length,
  });

  // Conserver seulement les 30 dernières entrées
  history = history.slice(0, 30);

  const dir = path.dirname(histPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(histPath, JSON.stringify(history, null, 2));
}

// ─── Routes API ───────────────────────────────────────────────────────────────

/**
 * GET /api/health — Statut du serveur et d'Ollama
 */
app.get('/api/health', async (req, res) => {
  const config = loadConfig();
  let ollamaStatus = 'disconnected';
  let ollamaVersion = null;

  try {
    const result = await ollamaRequest(`${config.ollamaUrl}/api/tags`, 'GET', null, 5000);
    if (result.status === 200) {
      ollamaStatus = 'connected';
    }
  } catch { /* Ollama inaccessible */ }

  res.json({
    status: 'ok',
    ollama: ollamaStatus,
    ollamaUrl: config.ollamaUrl,
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/logs/list — Liste des fichiers dans le volume logs
 */
app.get('/api/logs/list', (req, res) => {
  const config = loadConfig();
  try {
    const files = scanDirectory(config.logsPath);
    files.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    res.json({ files, logsPath: config.logsPath, count: files.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/logs/read?path=...&lines=300 — Lire un fichier log
 */
app.get('/api/logs/read', (req, res) => {
  const config = loadConfig();
  const logPath = req.query.path;
  const maxLines = parseInt(req.query.lines) || config.maxLines;

  if (!logPath) return res.status(400).json({ error: 'Paramètre "path" manquant' });

  // Sécurité : vérifier que le chemin est dans le volume autorisé
  const resolvedPath = path.resolve(logPath);
  const resolvedBase = path.resolve(config.logsPath);
  if (!resolvedPath.startsWith(resolvedBase)) {
    return res.status(403).json({ error: 'Accès refusé : chemin hors du volume logs' });
  }

  try {
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'Fichier non trouvé' });
    }
    const { lines, total, truncated } = readLastLines(resolvedPath, maxLines);
    const lastLines = lines.slice(-maxLines);

    res.json({
      path: logPath,
      totalLines: total,
      returnedLines: lastLines.length,
      truncated,
      content: lastLines.join('\n'),
    });
  } catch (e) {
    if (e.code === 'EACCES') {
      res.status(403).json({ error: 'Permission refusée pour ce fichier' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

/**
 * GET /api/ollama/models — Liste des modèles Ollama disponibles
 */
app.get('/api/ollama/models', async (req, res) => {
  const config = loadConfig();
  try {
    const result = await ollamaRequest(`${config.ollamaUrl}/api/tags`, 'GET', null, 10000);
    if (result.status === 200) {
      res.json(result.data);
    } else {
      res.status(result.status).json({ error: 'Réponse inattendue d\'Ollama' });
    }
  } catch (e) {
    res.status(503).json({ error: `Ollama inaccessible : ${e.message}` });
  }
});

/**
 * GET /api/settings — Lire la configuration courante
 */
app.get('/api/settings', (req, res) => {
  res.json(loadConfig());
});

/**
 * POST /api/settings — Sauvegarder la configuration
 */
app.post('/api/settings', (req, res) => {
  const current = loadConfig();
  // Valider et filtrer les champs acceptés
  const allowed = ['logsPath', 'ollamaUrl', 'defaultModel', 'maxLines'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  const updated = { ...current, ...updates };
  saveConfig(updated);
  res.json({ success: true, settings: updated });
});

/**
 * GET /api/reports/history — Historique des analyses
 */
app.get('/api/reports/history', (req, res) => {
  const histPath = '/app/config/history.json';
  try {
    if (fs.existsSync(histPath)) {
      res.json(JSON.parse(fs.readFileSync(histPath, 'utf8')));
    } else {
      res.json([]);
    }
  } catch {
    res.json([]);
  }
});

/**
 * GET /api/reports/:id — Récupérer un rapport par son ID
 */
app.get('/api/reports/:id', (req, res) => {
  // Sanitizer l'ID pour éviter path traversal
  const id = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  const reportPath = `/app/config/reports/${id}.json`;
  try {
    if (!fs.existsSync(reportPath)) {
      return res.status(404).json({ error: 'Rapport non trouvé' });
    }
    res.json(JSON.parse(fs.readFileSync(reportPath, 'utf8')));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/analyze — Lancer une analyse complète
 * Body: { files: string[], model: string, tasks: string[] }
 */
app.post('/api/analyze', async (req, res) => {
  const { files, model, tasks } = req.body;
  const config = loadConfig();

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'Aucun fichier sélectionné' });
  }

  const selectedTasks = Array.isArray(tasks) && tasks.length
    ? tasks
    : Object.keys(TASK_DESCRIPTIONS);

  // ── Étape 1 : Lire et pré-traiter chaque fichier ──────────────────────────

  const logChunks = [];
  const fileResults = [];

  for (const filePath of files) {
    // Sécurité : empêcher l'accès hors du volume
    const resolved = path.resolve(filePath);
    const base = path.resolve(config.logsPath);
    if (!resolved.startsWith(base)) {
      fileResults.push({ path: filePath, error: 'Chemin non autorisé' });
      continue;
    }

    try {
      const { lines, total, truncated } = readLastLines(resolved, config.maxLines);

      // Filtrage sécurité
      let filtered = filterSecurityLines(lines);

      // Si trop peu de lignes filtrées, prendre les dernières N lignes brutes
      if (filtered.length < 5) {
        filtered = lines.slice(-config.maxLines);
      } else {
        filtered = filtered.slice(-config.maxLines);
      }

      // Dédupliquer
      filtered = deduplicateLines(filtered);

      logChunks.push({
        file: path.basename(filePath),
        path: filePath,
        type: detectLogType(path.basename(filePath)),
        content: filtered.join('\n'),
        totalLines: total,
        filteredLines: filtered.length,
        truncated,
      });

      fileResults.push({ path: filePath, success: true, lines: filtered.length, truncated });
    } catch (e) {
      const errMsg = e.code === 'EACCES' ? 'Permission refusée' : e.message;
      fileResults.push({ path: filePath, error: errMsg });
    }
  }

  if (logChunks.length === 0) {
    return res.status(400).json({ error: 'Aucun fichier lisible parmi la sélection', fileResults });
  }

  // ── Étape 2 : Construire le prompt et appeler Ollama ──────────────────────

  const prompt = buildAnalysisPrompt(logChunks, selectedTasks);
  const chosenModel = model || config.defaultModel;

  console.log(`[Analyse] Modèle : ${chosenModel}, fichiers : ${logChunks.length}, tâches : ${selectedTasks.length}`);

  let ollamaResult;
  try {
    ollamaResult = await ollamaRequest(
      `${config.ollamaUrl}/api/generate`,
      'POST',
      {
        model: chosenModel,
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: 8000 },
      },
      360000 // 6 minutes max pour les gros modèles
    );
  } catch (e) {
    return res.status(503).json({
      error: `Erreur de communication avec Ollama : ${e.message}`,
      fileResults,
    });
  }

  if (ollamaResult.status !== 200) {
    return res.status(502).json({
      error: `Ollama a retourné le statut ${ollamaResult.status}`,
      fileResults,
    });
  }

  // ── Étape 3 : Parser la réponse JSON du LLM ───────────────────────────────

  const rawResponse = ollamaResult.data.response || '';
  let report;

  try {
    // Extraire le JSON même s'il est entouré de balises markdown
    const jsonMatch =
      rawResponse.match(/```json\s*([\s\S]*?)\s*```/) ||
      rawResponse.match(/```\s*([\s\S]*?)\s*```/) ||
      rawResponse.match(/(\{[\s\S]*\})/);

    if (!jsonMatch) throw new Error('Aucun JSON trouvé dans la réponse');
    report = JSON.parse(jsonMatch[1] || jsonMatch[0]);
  } catch (parseErr) {
    console.error('[Parse] Impossible de parser la réponse LLM :', parseErr.message);
    return res.json({
      success: false,
      error: `Impossible de parser la réponse JSON du LLM : ${parseErr.message}`,
      rawResponse: rawResponse.substring(0, 2000),
      fileResults,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Étape 4 : Persister et retourner le rapport ───────────────────────────

  const reportId = Date.now().toString();
  const reportDir = '/app/config/reports';
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

  const reportData = {
    id: reportId,
    timestamp: new Date().toISOString(),
    model: chosenModel,
    files,
    fileResults,
    report,
  };

  fs.writeFileSync(`${reportDir}/${reportId}.json`, JSON.stringify(reportData, null, 2));
  updateHistory(reportId, report, files);

  console.log(`[Analyse] Rapport ${reportId} sauvegardé — sévérité : ${report.severity_global}`);

  res.json({
    success: true,
    reportId,
    fileResults,
    report,
    timestamp: new Date().toISOString(),
  });
});

// ─── Démarrage ────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('');
  console.log('  ██╗   ██╗███████╗██╗   ██╗██╗      ██████╗  ██████╗ ');
  console.log('  ██║   ██║██╔════╝╚██╗ ██╔╝██║     ██╔═══██╗██╔════╝ ');
  console.log('  ██║   ██║█████╗   ╚████╔╝ ██║     ██║   ██║██║  ███╗');
  console.log('  ╚██╗ ██╔╝██╔══╝    ╚██╔╝  ██║     ██║   ██║██║   ██║');
  console.log('   ╚████╔╝ ███████╗   ██║   ███████╗╚██████╔╝╚██████╔╝');
  console.log('    ╚═══╝  ╚══════╝   ╚═╝   ╚══════╝ ╚═════╝  ╚═════╝ ');
  console.log('');
  console.log(`  Serveur actif sur http://0.0.0.0:${PORT}`);
  console.log(`  Ollama URL : ${process.env.OLLAMA_URL || DEFAULT_CONFIG.ollamaUrl}`);
  console.log('');
});
