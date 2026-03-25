/**
 * auth.js — Gestion de l'authentification Veylog
 * Inclure AVANT tout autre script sur chaque page protégée.
 */
'use strict';

const VEYLOG_TOKEN_KEY = 'veylog_token';

function getToken() {
  return localStorage.getItem(VEYLOG_TOKEN_KEY) || '';
}

function setToken(token) {
  localStorage.setItem(VEYLOG_TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(VEYLOG_TOKEN_KEY);
}

// ── Wrap fetch pour injecter automatiquement le token sur /api ────────────────

const _origFetch = window.fetch.bind(window);
window.fetch = function(url, opts) {
  opts = opts || {};
  if (typeof url === 'string' && url.startsWith('/api')) {
    opts.headers = Object.assign({}, opts.headers, { 'X-Auth-Token': getToken() });
  }
  return _origFetch(url, opts);
};

// ── Vérification auth au chargement (redirige vers login si besoin) ───────────

(async function checkAuth() {
  if (window.location.pathname.includes('login.html')) return;
  try {
    const r = await _origFetch('/api/auth/check', {
      headers: { 'X-Auth-Token': getToken() }
    });
    const d = await r.json();
    if (d.authRequired && !d.ok) {
      window.location.href = '/login.html';
      return;
    }
    // Afficher le bouton logout si auth activée
    if (d.authRequired) {
      const btn = document.getElementById('logoutBtn');
      if (btn) btn.classList.remove('hidden');
    }
  } catch (_) {
    // Serveur inaccessible — ne pas rediriger
  }
})();

// ── Déconnexion ───────────────────────────────────────────────────────────────

window.veylogLogout = async function() {
  await fetch('/api/auth/logout', { method: 'POST' });
  clearToken();
  window.location.href = '/login.html';
};
