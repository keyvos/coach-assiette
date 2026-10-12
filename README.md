# Coach Assiette

Application web de coaching nutritionnel (FR · EN · PT · ES) : analyse des repas par photo ou texte,
coaching STRICT ou BIENVEILLANT, idées de repas, suivi de la faim, du stress, du poids, et partage
avec le coach (avec l'accord du client).

> Estimations indicatives. L'application ne remplace pas un médecin, un diététicien ni un allergologue.

## Contenu du dépôt

| Fichier | Rôle |
|---|---|
| `index.html` | L'application (tout est dans ce fichier) |
| `manifest.webmanifest`, `icon-*.png` | Permettent d'ajouter l'application à l'écran d'accueil du téléphone |
| `supabase/schema.sql` | Base de données et règles de confidentialité (à lancer une fois dans Supabase) |
| `supabase/functions/ai/index.ts` | Fonction IA sécurisée : la clé de l'API Claude reste sur le serveur |

## Fonctionnement

- **Site** : hébergé gratuitement par GitHub Pages (chaque modification du dépôt est mise en ligne automatiquement).
- **Comptes et données** : Supabase (serveurs en Europe). Chaque client ne voit que ses propres données ;
  le coach ne voit que les résumés des clients qui ont accepté le partage.
- **IA** : la fonction `ai` appelle l'API Claude. Limite par client et par jour réglable avec le secret
  `AI_DAILY_LIMIT` (40 par défaut). Modèles réglables avec `AI_MODEL` (analyse des photos, `claude-haiku-5-5` par défaut, le moins cher ; `claude-sonnet-5-5` pour plus de précision) et `AI_MODEL_QUICK` (messages courts).

## Configuration

Dans `index.html`, en haut du script : `SUPABASE_URL` et `SUPABASE_KEY` (clé *publishable*, publique par conception).
Ne jamais mettre de clé secrète ni la clé de l'API Claude dans ce dépôt.
