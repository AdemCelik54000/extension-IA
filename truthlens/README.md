# TruthLens

Une extension de navigateur qui vérifie les informations sur les pages web en utilisant Mistral AI et Brave Search.

## Configuration locale

1. Copiez `backend/.env.example` vers `backend/.env`
2. Renseignez vos clés API dans `backend/.env`
3. Gardez `backend/.env` privé : il est ignoré par Git et ne doit jamais être publié

## Fonctionnalités

### 1. Vérification de Page Complète
- Bouton "Verify Page" : analyse tout le texte de la page
- Utilise Mistral pour extraire les affirmations clés
- Brave Search pour trouver des sources fiables
- Résultats affichés dans une boîte en bas de la popup

### 2. Mode Sélection
- Bouton "Selection" (bascule) : active/désactive le mode
- Survol : texte en surbrillance bleue
- Clic : sélectionne le texte (reste en bleu)
- Bouton "Search Selection" : vérifie uniquement le texte sélectionné

## Technologies Utilisées

- Frontend : Extension Chrome Manifest V3, JavaScript
- Backend : Node.js, Express, Mistral AI (mistral-small-latest), Brave Search API

```bash
cd backend
npm install
npm start
```

Le backend tournera sur http://localhost:3001

### 3. Configuration de l'Extension

1. Ouvrez Chrome et allez sur `chrome://extensions/`
2. Activez le "Mode développeur"
3. Cliquez sur "Charger l'extension non empaquetée" et sélectionnez le dossier `extension`
4. L'extension devrait maintenant être installée

### 4. Icônes

Remplacez les fichiers d'espace réservé dans `extension/icons/` par des icônes PNG réelles des tailles spécifiées.

## Comment Ça Marche

1. Cliquez sur l'icône de l'extension TruthLens
2. Cliquez sur "Scanner la Page"
3. L'extension extrait le texte de la page actuelle
4. Envoie le texte au backend pour analyse
5. Le backend utilise Mistral (mistral-small-latest) pour extraire les affirmations
6. Vérifie les affirmations en utilisant l'API Google Fact Check Tools (si disponible) ou Brave Search
7. Retourne les résultats à l'extension
8. L'extension affiche les badges sur la page et un résumé dans la popup

## Points de Terminaison API

- `POST /verify` : Accepte `{ text: "contenu de la page" }`, retourne un tableau de résultats de vérification

## Améliorer la Vérification IA

- Utiliser des modèles NLP plus avancés pour l'extraction d'affirmations
- Implémenter une logique de vérification des faits meilleure avec plusieurs sources
- Ajouter une mise en cache avec une base de données pour éviter les appels API répétés
- Utiliser des modèles d'apprentissage automatique pour le score de crédibilité
- Intégrer plus d'APIs de vérification des faits (ex. : Snopes, FactCheck.org)
- Ajouter un mécanisme de retour d'utilisateur pour améliorer la précision

## Déploiement

Pour le déploiement en production :

1. Hébergez le backend sur un serveur (ex. : Heroku, AWS)
2. Mettez à jour les `host_permissions` de l'extension pour pointer vers l'URL de production
3. Sécurisez les clés API correctement
4. Considérez la limitation de débit et l'authentification

## Technologies Utilisées

- Frontend : Extension Chrome Manifest V3, JavaScript
- Backend : Node.js, Express, API OpenAI, APIs Google