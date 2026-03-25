# Veylog — Analyseur de logs Linux par LLM local

Veylog analyse vos logs Linux avec un LLM local via Ollama. Tout tourne en local — aucune donnée ne quitte votre infrastructure.

```
  ██╗   ██╗███████╗██╗   ██╗██╗      ██████╗  ██████╗
  ██║   ██║██╔════╝╚██╗ ██╔╝██║     ██╔═══██╗██╔════╝
  ██║   ██║█████╗   ╚████╔╝ ██║     ██║   ██║██║  ███╗
  ╚██╗ ██╔╝██╔══╝    ╚██╔╝  ██║     ██║   ██║██║   ██║
   ╚████╔╝ ███████╗   ██║   ███████╗╚██████╔╝╚██████╔╝
    ╚═══╝  ╚══════╝   ╚═╝   ╚══════╝ ╚═════╝  ╚═════╝
```

## Fonctionnalités

- **Dashboard** : vue d'ensemble des fichiers logs disponibles dans `/var/log`
- **Analyse sécurité** : 10 tâches de checklist couvrant SSH, élévation de privilèges, intrusions, malware, etc.
- **Rapport détaillé** : findings triés par sévérité (CRITIQUE → INFO), preuves, recommandations, commandes shell
- **LLM local** : Ollama (llama3.3, qwen2.5, mistral...) — zéro donnée sortante
- **Export Markdown** : rapports exportables
- **100% local** : Docker, pas de cloud, pas d'API externe

## Stack

| Composant  | Technologie                    |
|------------|-------------------------------|
| Backend    | Node.js 20 + Express 4        |
| Frontend   | HTML5 + Tailwind CSS + Vanilla JS |
| Police     | JetBrains Mono                |
| LLM        | Ollama (API REST locale)      |
| Déploiement| Docker + Docker Compose       |

---

## Prérequis

- Docker 24+
- Docker Compose v2
- GPU NVIDIA (optionnel mais recommandé pour les gros modèles)
- Minimum 8 GB RAM (16 GB recommandé pour llama3.3:70b)

---

## Installation rapide

### 1. Cloner et configurer

```bash
git clone https://github.com/votre-repo/veylog.git
cd veylog
cp .env.example .env
```

Éditez `.env` si nécessaire (généralement pas nécessaire en configuration standard).

### 2. Démarrer les services

```bash
docker compose up -d --build
```

Veylog sera accessible sur **http://localhost:3000**

### 3. Installer un modèle Ollama

```bash
# Modèle léger (recommandé pour commencer)
docker exec veylog-ollama ollama pull llama3.1:8b

# Modèle équilibré (bonne qualité, 16 GB RAM)
docker exec veylog-ollama ollama pull qwen2.5:32b

# Modèle de référence (meilleure qualité, 40+ GB RAM)
docker exec veylog-ollama ollama pull llama3.3:70b
```

### 4. Accéder à l'interface

Ouvrez http://localhost:3000 dans votre navigateur.

---

## Utilisation

### Analyser des logs

1. **Dashboard** → sélectionnez les fichiers logs à analyser
2. Cliquez **→ Analyser** pour être redirigé vers la page d'analyse
3. Choisissez le **modèle Ollama** et les **tâches de sécurité** à couvrir
4. Cliquez **Lancer l'analyse** et attendez (1-20 min selon le modèle)
5. Le **rapport** s'affiche automatiquement une fois l'analyse terminée

### Checklist des 10 tâches de sécurité

| ID      | Tâche                              |
|---------|------------------------------------|
| task1   | Authentification & SSH             |
| task2   | Élévation de privilèges            |
| task3   | Activité réseau suspecte           |
| task4   | Erreurs système & kernel           |
| task5   | Services défaillants               |
| task6   | Tentatives d'intrusion             |
| task7   | Modifications système              |
| task8   | Activités malveillantes            |
| task9   | Ressources système                 |
| task10  | Services web (nginx/apache)        |

---

## Configuration avancée

### Variables d'environnement (`.env`)

| Variable        | Défaut                    | Description                          |
|-----------------|---------------------------|--------------------------------------|
| `PORT`          | `3000`                    | Port du serveur web                  |
| `OLLAMA_URL`    | `http://ollama:11434`     | URL de l'API Ollama                  |
| `DEFAULT_MODEL` | `llama3.3:70b`            | Modèle Ollama utilisé par défaut     |
| `LOGS_PATH`     | `/var/log`                | Répertoire des logs (monté en :ro)   |
| `MAX_LINES`     | `300`                     | Lignes max analysées par fichier     |

### Activer le GPU NVIDIA

Décommentez la section `deploy` dans `docker-compose.yml` :

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]
```

Assurez-vous d'avoir le [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) installé.

### Volume logs personnalisé

Pour analyser les logs d'un autre répertoire :

```yaml
volumes:
  - /chemin/custom:/var/log:ro
```

---

## Architecture

```
veylog/
├── server.js          ← Backend Express — API REST + logique d'analyse
├── public/
│   ├── index.html     ← Dashboard
│   ├── analyze.html   ← Page d'analyse
│   ├── report.html    ← Rapport des résultats
│   ├── settings.html  ← Configuration
│   └── js/
│       ├── app.js     ← Utilitaires partagés (API, toast, formatage)
│       ├── analyzer.js← Logique page d'analyse
│       └── report.js  ← Rendu rapport + graphiques
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

### Flux d'analyse

```
Sélection fichiers
       ↓
Lecture + truncature (fichiers > 10MB)
       ↓
Filtrage sécurité (regex keywords)
       ↓
Déduplication des lignes répétées
       ↓
Construction du prompt (≤ 4000 tokens par fichier)
       ↓
Appel Ollama API (stream: false)
       ↓
Parsing JSON de la réponse
       ↓
Sauvegarde rapport + Affichage
```

---

## API Backend

| Méthode | Endpoint                | Description                          |
|---------|-------------------------|--------------------------------------|
| GET     | `/api/health`           | Statut serveur + statut Ollama       |
| GET     | `/api/logs/list`        | Liste fichiers dans `/var/log`       |
| GET     | `/api/logs/read`        | Lire un fichier log (N dernières lignes) |
| GET     | `/api/ollama/models`    | Modèles Ollama disponibles           |
| POST    | `/api/analyze`          | Lancer une analyse complète          |
| GET     | `/api/settings`         | Lire la configuration                |
| POST    | `/api/settings`         | Sauvegarder la configuration         |
| GET     | `/api/reports/history`  | Historique des analyses              |
| GET     | `/api/reports/:id`      | Récupérer un rapport par ID          |

---

## Sécurité

- Le volume `/var/log` est monté en **lecture seule** (`:ro`)
- Tous les chemins de fichiers sont **validés** pour rester dans le volume autorisé (prévention path traversal)
- L'application tourne **entièrement en local** — aucune donnée n'est envoyée à l'extérieur
- Les logs sont **pré-filtrés** avant envoi au LLM (uniquement les lignes pertinentes)

---

## Dépannage

### Ollama ne répond pas

```bash
# Vérifier l'état du container
docker compose logs ollama

# Redémarrer Ollama
docker compose restart ollama

# Vérifier que le modèle est bien téléchargé
docker exec veylog-ollama ollama list
```

### Aucun fichier log visible

```bash
# Vérifier le volume monté
docker exec veylog ls -la /var/log/

# Vérifier les permissions
docker exec veylog ls -la /var/log/auth.log
```

### L'analyse échoue avec "JSON invalide"

Le modèle choisi est peut-être trop petit pour suivre les instructions de format JSON.
Essayez un modèle plus capable (qwen2.5:32b ou llama3.3:70b).

### Voir les logs du serveur

```bash
docker compose logs -f veylog
```

---

## Licence

MIT — Voir [LICENSE](LICENSE)

---

*Veylog — Analyseur de logs Linux propulsé par LLM local. Inspiré du design d'[OinkView](https://github.com/cayjee/OinkView).*
