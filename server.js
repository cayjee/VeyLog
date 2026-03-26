/**
 * Veylog — Serveur Backend
 * Analyseur de logs Linux — supporte Ollama, OpenAI, Gemini et Claude
 * Architecture : Node.js 20 + Express 4
 */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG_PATH = '/app/config/settings.json';

// ─── Configuration par défaut ────────────────────────────────────────────────

// Sessions auth en mémoire
const sessions = new Set();

const DEFAULT_CONFIG = {
  logsPath:      process.env.LOGS_PATH     || '/var/log',
  ollamaUrl:     process.env.OLLAMA_URL    || 'http://host.docker.internal:11434',
  defaultModel:  process.env.DEFAULT_MODEL || 'llama3.3:70b',
  maxLines:      parseInt(process.env.MAX_LINES) || 300,
  // Provider LLM : 'ollama' | 'openai' | 'gemini' | 'claude'
  llmProvider:   process.env.LLM_PROVIDER  || 'ollama',
  openaiApiKey:  process.env.OPENAI_API_KEY  || '',
  openaiModel:   process.env.OPENAI_MODEL    || 'gpt-4o',
  geminiApiKey:  process.env.GEMINI_API_KEY  || '',
  geminiModel:   process.env.GEMINI_MODEL    || 'gemini-2.0-flash',
  claudeApiKey:  process.env.CLAUDE_API_KEY  || '',
  claudeModel:   process.env.CLAUDE_MODEL    || 'claude-sonnet-4-6',
  // Auth
  authEnabled:  process.env.AUTH_ENABLED === 'true' || false,
  authPassword: process.env.AUTH_PASSWORD || '',
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

// ─── Clients LLM ─────────────────────────────────────────────────────────────

/**
 * Appeler l'API OpenAI (ChatGPT).
 */
async function callOpenAI(prompt, apiKey, model) {
  if (!apiKey) throw new Error('Clé API OpenAI non configurée dans les paramètres');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.1 }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`OpenAI ${res.status}: ${err.error?.message || res.statusText}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

/**
 * Appeler l'API Google Gemini.
 */
async function callGemini(prompt, apiKey, model) {
  if (!apiKey) throw new Error('Clé API Gemini non configurée dans les paramètres');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1 },
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Gemini ${res.status}: ${err.error?.message || res.statusText}`);
  }
  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

/**
 * Appeler l'API Anthropic Claude.
 */
async function callClaude(prompt, apiKey, model) {
  if (!apiKey) throw new Error('Clé API Claude non configurée dans les paramètres');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: 8192, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Claude ${res.status}: ${err.error?.message || res.statusText}`);
  }
  const data = await res.json();
  return data.content[0].text;
}

/**
 * Appeler Ollama en local.
 */
async function callOllama(prompt, ollamaUrl, model) {
  const result = await ollamaRequest(`${ollamaUrl}/api/generate`, 'POST', {
    model, prompt, stream: false, options: { temperature: 0.1, num_predict: 16000 },
  }, 360000);
  if (result.status !== 200) throw new Error(`Ollama a retourné le statut ${result.status}`);
  return result.data.response || '';
}

/**
 * Dispatcher LLM — route vers le bon provider selon la configuration.
 * @param {string} prompt - Prompt complet
 * @param {object} config - Configuration chargée
 * @param {string} [model] - Modèle à utiliser (override)
 */
async function callLLM(prompt, config, model) {
  const provider = config.llmProvider || 'ollama';
  if (provider === 'openai') return callOpenAI(prompt, config.openaiApiKey, model || config.openaiModel);
  if (provider === 'gemini') return callGemini(prompt, config.geminiApiKey, model || config.geminiModel);
  if (provider === 'claude') return callClaude(prompt, config.claudeApiKey, model || config.claudeModel);
  return callOllama(prompt, config.ollamaUrl, model || config.defaultModel);
}

// Modèles disponibles par provider cloud
const PROVIDER_MODELS = {
  openai: [
    { name: 'gpt-4o',      description: 'Recommandé — meilleur rapport qualité/prix' },
    { name: 'gpt-4o-mini', description: 'Rapide et économique' },
    { name: 'gpt-4-turbo', description: 'Contexte 128k tokens' },
    { name: 'o1',          description: 'Raisonnement avancé' },
  ],
  gemini: [
    { name: 'gemini-2.0-flash', description: 'Recommandé — rapide et performant' },
    { name: 'gemini-1.5-pro',   description: 'Contexte 1M tokens' },
    { name: 'gemini-1.5-flash', description: 'Économique' },
  ],
  claude: [
    { name: 'claude-sonnet-4-6',          description: 'Recommandé — équilibré performance/coût' },
    { name: 'claude-opus-4-6',            description: 'Meilleure capacité d\'analyse' },
    { name: 'claude-haiku-4-5-20251001',  description: 'Rapide et économique' },
  ],
};

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

const TASK_CATEGORIES = {
  task1: 'Authentification',
  task2: 'Système',
  task3: 'Réseau',
  task4: 'Système',
  task5: 'Système',
  task6: 'Réseau',
  task7: 'Intégrité',
  task8: 'Malware',
  task9: 'Ressources',
  task10: 'Web',
};

/**
 * Construire le prompt complet envoyé à Ollama.
 */
function buildAnalysisPrompt(logChunks, selectedTasks) {
  const tasksBlock = selectedTasks
    .map(t => `  - [${t}] ${TASK_DESCRIPTIONS[t] || t}`)
    .join('\n');

  const allowedCategories = [...new Set(selectedTasks.map(t => TASK_CATEGORIES[t]).filter(Boolean))];
  const categoriesStr = allowedCategories.join('|');

  const logsBlock = logChunks
    .map(c =>
      `=== FICHIER : ${c.file} | TYPE : ${c.type} | ${c.filteredLines}/${c.totalLines} lignes ===\n${c.content}`
    )
    .join('\n\n');

  return `Tu es Veylog, expert senior en sécurité Linux et analyse forensique de logs.
Analyse les logs ci-dessous et génère un rapport de sécurité strictement limité aux tâches demandées.

TÂCHES À COUVRIR :
${tasksBlock}

CONTRAINTE STRICTE : Tu dois UNIQUEMENT rapporter des findings liés aux tâches listées ci-dessus.
N'inclus AUCUN finding hors de ce périmètre, même si tu détectes d'autres problèmes dans les logs.
Les catégories autorisées pour les findings sont : ${categoriesStr}

LOGS À ANALYSER :
${logsBlock}

INSTRUCTIONS :
- Identifie les problèmes liés aux tâches sélectionnées uniquement
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
      "category": "${categoriesStr}",
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

// ─── Prompt focalisé sur une seule tâche ─────────────────────────────────────

function buildTaskPrompt(logChunks, task) {
  const taskDesc = TASK_DESCRIPTIONS[task] || task;
  const category = TASK_CATEGORIES[task] || 'Système';

  const logsBlock = logChunks
    .map(c =>
      `=== FICHIER : ${c.file} | TYPE : ${c.type} | ${c.filteredLines}/${c.totalLines} lignes ===\n${c.content}`
    )
    .join('\n\n');

  return `Tu es Veylog, expert senior en sécurité Linux et analyse forensique de logs.

TÂCHE UNIQUE : ${taskDesc}

LOGS À ANALYSER :
${logsBlock}

INSTRUCTIONS :
- Concentre-toi EXCLUSIVEMENT sur : ${taskDesc}
- Sois EXHAUSTIF : examine chaque ligne, signale TOUT indice même subtil
- Ne passe à la ligne suivante qu'après l'avoir analysée en profondeur
- Cite les lignes exactes comme preuves (champ "evidence")
- Sévérités : CRITIQUE (exploitation active), ÉLEVÉ (risque important), MOYEN (risque modéré), FAIBLE (best practice), INFO (informatif)
- Si aucun problème trouvé, retourne findings vide

Réponds UNIQUEMENT avec ce JSON valide (aucun markdown autour) :
{
  "findings": [
    {
      "severity": "CRITIQUE|ÉLEVÉ|MOYEN|FAIBLE|INFO",
      "category": "${category}",
      "title": "Titre court et précis",
      "description": "Description détaillée",
      "evidence": ["ligne exacte 1", "ligne exacte 2"],
      "recommendation": "Action corrective concrète"
    }
  ],
  "commands_suggested": ["commande shell concrète liée à cette tâche"],
  "covered": true,
  "notes": "Résumé de ce qui a été analysé pour cette tâche"
}`;
}

// ─── Fusion des résultats multi-tâches ────────────────────────────────────────

function mergeTaskResults(taskResults, logChunks) {
  const allFindings = [];
  const checklistCoverage = {};
  let suspicious = 0, warnings = 0, errors = 0;

  const allFindingsRaw = [];
  const commandsSet = new Set();

  for (const { task, result } of taskResults) {
    if (Array.isArray(result.findings)) allFindingsRaw.push(...result.findings);
    if (Array.isArray(result.commands_suggested)) {
      result.commands_suggested.forEach(c => c && commandsSet.add(c));
    }
    checklistCoverage[task] = { covered: result.covered !== false, notes: result.notes || '' };
  }

  // Dédupliquer les findings par première ligne d'evidence (même événement détecté par plusieurs tâches)
  const severityOrder = ['CRITIQUE', 'ÉLEVÉ', 'MOYEN', 'FAIBLE', 'INFO', 'OK'];
  const evidenceMap = new Map();
  for (const f of allFindingsRaw) {
    const key = (f.evidence && f.evidence[0]) ? f.evidence[0].trim() : f.title;
    if (!evidenceMap.has(key)) {
      evidenceMap.set(key, f);
    } else {
      // Garder le finding avec la sévérité la plus haute
      const existing = evidenceMap.get(key);
      if (severityOrder.indexOf(f.severity) < severityOrder.indexOf(existing.severity)) {
        evidenceMap.set(key, f);
      }
    }
  }
  const allFindings = Array.from(evidenceMap.values());

  allFindings.forEach(f => {
    if (f.severity === 'CRITIQUE' || f.severity === 'ÉLEVÉ') suspicious++;
    else if (f.severity === 'MOYEN') warnings++;
    else errors++;
  });

  const severityOrder = ['CRITIQUE', 'ÉLEVÉ', 'MOYEN', 'FAIBLE', 'INFO', 'OK'];
  let severityGlobal = 'OK';
  for (const f of allFindings) {
    if (severityOrder.indexOf(f.severity) < severityOrder.indexOf(severityGlobal)) {
      severityGlobal = f.severity;
    }
  }

  const totalLines = logChunks.reduce((sum, c) => sum + c.filteredLines, 0);
  const critiques = allFindings.filter(f => f.severity === 'CRITIQUE').length;
  const eleves    = allFindings.filter(f => f.severity === 'ÉLEVÉ').length;
  const summary   = allFindings.length
    ? `Analyse complète : ${allFindings.length} finding(s) détecté(s) (${critiques} critique(s), ${eleves} élevé(s)). Sévérité globale : ${severityGlobal}.`
    : 'Aucun problème de sécurité détecté dans les logs analysés.';

  // Extraire les recommandations uniques depuis les findings
  const seen = new Set();
  const recommendations = [];
  for (const f of allFindings) {
    if (f.recommendation && !seen.has(f.recommendation)) {
      seen.add(f.recommendation);
      recommendations.push(f.recommendation);
    }
  }

  return {
    summary,
    severity_global: severityGlobal,
    statistics: { errors, warnings, suspicious, total_analyzed: totalLines },
    findings: allFindings,
    checklist_coverage: checklistCoverage,
    recommendations,
    commands_suggested: [...commandsSet],
  };
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

// ─── Auth ─────────────────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const config = loadConfig();
  if (!config.authEnabled) return next();
  if (['/auth/login', '/auth/check', '/auth/logout'].includes(req.path)) return next();
  const token = req.headers['x-auth-token'] || '';
  if (!token || !sessions.has(token)) return res.status(401).json({ error: 'Non autorisé' });
  next();
}

app.use('/api', authMiddleware);

app.get('/api/auth/check', (req, res) => {
  const config = loadConfig();
  if (!config.authEnabled) return res.json({ authRequired: false, ok: true });
  const token = req.headers['x-auth-token'] || '';
  res.json({ authRequired: true, ok: sessions.has(token) });
});

app.post('/api/auth/login', (req, res) => {
  const config = loadConfig();
  if (!config.authEnabled) return res.json({ ok: true, token: '' });
  const { password } = req.body;
  if (!password || password !== config.authPassword) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.add(token);
  res.json({ ok: true, token });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-auth-token'] || '';
  sessions.delete(token);
  res.json({ ok: true });
});

// ─── Routes API ───────────────────────────────────────────────────────────────

/**
 * GET /api/health — Statut du serveur et du provider LLM
 */
app.get('/api/health', async (req, res) => {
  const config = loadConfig();
  const provider = config.llmProvider || 'ollama';
  let llmStatus = 'disconnected';

  if (provider === 'ollama') {
    try {
      const result = await ollamaRequest(`${config.ollamaUrl}/api/tags`, 'GET', null, 5000);
      if (result.status === 200) llmStatus = 'connected';
    } catch { /* Ollama inaccessible */ }
  } else {
    // Pour les providers cloud, vérifier que la clé API est configurée
    const keyMap = { openai: 'openaiApiKey', gemini: 'geminiApiKey', claude: 'claudeApiKey' };
    llmStatus = config[keyMap[provider]] ? 'configured' : 'no_key';
  }

  res.json({
    status: 'ok',
    llmProvider: provider,
    llmStatus,
    // Rétrocompatibilité
    ollama: provider === 'ollama' ? llmStatus : 'disabled',
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
 * GET /api/ollama/models — Rétrocompatibilité (redirige vers /api/llm/models)
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
 * GET /api/llm/models — Liste des modèles selon le provider actif
 */
app.get('/api/llm/models', async (req, res) => {
  const config = loadConfig();
  const provider = config.llmProvider || 'ollama';

  if (provider === 'ollama') {
    try {
      const result = await ollamaRequest(`${config.ollamaUrl}/api/tags`, 'GET', null, 10000);
      if (result.status === 200) {
        res.json({ provider, models: result.data.models || [] });
      } else {
        res.status(result.status).json({ error: 'Réponse inattendue d\'Ollama' });
      }
    } catch (e) {
      res.status(503).json({ error: `Ollama inaccessible : ${e.message}` });
    }
  } else {
    res.json({ provider, models: PROVIDER_MODELS[provider] || [] });
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
  const allowed = [
    'logsPath', 'ollamaUrl', 'defaultModel', 'maxLines',
    'llmProvider',
    'openaiApiKey', 'openaiModel',
    'geminiApiKey', 'geminiModel',
    'claudeApiKey', 'claudeModel',
    'authEnabled', 'authPassword',
  ];
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

  // ── Étape 2 : Construire le prompt et appeler le LLM ─────────────────────

  const prompt = buildAnalysisPrompt(logChunks, selectedTasks);
  const provider = config.llmProvider || 'ollama';
  const modelDefaults = {
    ollama: config.defaultModel,
    openai: config.openaiModel,
    gemini: config.geminiModel,
    claude: config.claudeModel,
  };
  const chosenModel = model || modelDefaults[provider] || config.defaultModel;

  console.log(`[Analyse] Provider : ${provider}, Modèle : ${chosenModel}, fichiers : ${logChunks.length}, tâches : ${selectedTasks.length}`);

  let rawResponse;
  try {
    rawResponse = await callLLM(prompt, config, chosenModel);
  } catch (e) {
    return res.status(503).json({
      error: `Erreur LLM (${provider}) : ${e.message}`,
      fileResults,
    });
  }

  // ── Étape 3 : Parser la réponse JSON du LLM ───────────────────────────────

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

/**
 * POST /api/analyze/stream — Analyse tâche par tâche avec progression SSE
 * Body: { files: string[], model: string, tasks: string[] }
 */
app.post('/api/analyze/stream', async (req, res) => {
  const { files, model, tasks } = req.body;
  const config = loadConfig();

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'Aucun fichier sélectionné' });
  }

  const selectedTasks = Array.isArray(tasks) && tasks.length
    ? tasks
    : Object.keys(TASK_DESCRIPTIONS);

  // ── Headers SSE ──────────────────────────────────────────────────────────────
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // ── Étape 1 : Lire les fichiers ──────────────────────────────────────────────
  send('progress', { message: 'Lecture des fichiers...' });

  const logChunks = [];
  const fileResults = [];

  for (const filePath of files) {
    const resolved = path.resolve(filePath);
    const base = path.resolve(config.logsPath);
    if (!resolved.startsWith(base)) {
      fileResults.push({ path: filePath, error: 'Chemin non autorisé' });
      send('file_error', { path: filePath, error: 'Chemin non autorisé' });
      continue;
    }
    try {
      const { lines, total, truncated } = readLastLines(resolved, config.maxLines);
      let filtered = filterSecurityLines(lines);
      if (filtered.length < 5) filtered = lines.slice(-config.maxLines);
      else filtered = filtered.slice(-config.maxLines);
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
      send('file_ok', { path: filePath, lines: filtered.length });
    } catch (e) {
      const errMsg = e.code === 'EACCES' ? 'Permission refusée' : e.message;
      fileResults.push({ path: filePath, error: errMsg });
      send('file_error', { path: filePath, error: errMsg });
    }
  }

  if (logChunks.length === 0) {
    send('error', { message: 'Aucun fichier lisible parmi la sélection' });
    res.end();
    return;
  }

  // ── Étape 2 : Analyser tâche par tâche ──────────────────────────────────────
  const provider = config.llmProvider || 'ollama';
  const modelDefaults = {
    ollama: config.defaultModel, openai: config.openaiModel,
    gemini: config.geminiModel, claude: config.claudeModel,
  };
  const chosenModel = model || modelDefaults[provider] || config.defaultModel;

  console.log(`[Stream] Provider : ${provider}, Modèle : ${chosenModel}, fichiers : ${logChunks.length}, tâches : ${selectedTasks.length}`);

  const taskResults = [];

  for (let i = 0; i < selectedTasks.length; i++) {
    const task = selectedTasks[i];
    send('task_start', { task, label: TASK_DESCRIPTIONS[task] || task, index: i + 1, total: selectedTasks.length });

    try {
      const prompt = buildTaskPrompt(logChunks, task);
      const rawResponse = await callLLM(prompt, config, chosenModel);

      const jsonMatch =
        rawResponse.match(/```json\s*([\s\S]*?)\s*```/) ||
        rawResponse.match(/```\s*([\s\S]*?)\s*```/)     ||
        rawResponse.match(/(\{[\s\S]*\})/);

      if (!jsonMatch) throw new Error('Réponse JSON invalide');
      const result = JSON.parse(jsonMatch[1] || jsonMatch[0]);

      taskResults.push({ task, result });
      send('task_done', { task, findings: result.findings?.length || 0 });
    } catch (e) {
      console.error(`[Stream] Erreur tâche ${task} :`, e.message);
      taskResults.push({ task, result: { findings: [], covered: false, notes: e.message } });
      send('task_error', { task, error: e.message });
    }
  }

  // ── Étape 3 : Fusionner et sauvegarder ──────────────────────────────────────
  send('progress', { message: 'Fusion des résultats...' });

  const report = mergeTaskResults(taskResults, logChunks);

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

  console.log(`[Stream] Rapport ${reportId} — ${report.findings.length} finding(s) — sévérité : ${report.severity_global}`);

  send('done', { reportId, findings: report.findings.length, severity: report.severity_global });
  res.end();
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
