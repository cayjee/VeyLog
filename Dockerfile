FROM node:20-alpine

WORKDIR /app

# Copier les fichiers de dépendances en premier pour profiter du cache Docker
COPY package*.json ./

# Installer les dépendances de production uniquement
RUN npm install --production && npm cache clean --force

# Copier le reste du code source
COPY . .

# Créer les dossiers nécessaires
RUN mkdir -p /app/config/reports

# Exposer le port de l'application
EXPOSE 3000

# Démarrer le serveur
CMD ["node", "server.js"]
