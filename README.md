# Coach Assiette

© 2026 Sébastien Bassous (github.com/keyvos). **Tous droits réservés.** Voir [LICENSE](LICENSE) : ce code est visible
uniquement pour faire fonctionner l'application. Copier, modifier, redistribuer ou exploiter
commercialement l'application, en tout ou en partie, est interdit sans autorisation écrite.

Application web de coaching nutritionnel (FR · EN · PT · ES · AR, l’arabe s’affichant de droite à gauche) : analyse des repas par photo ou texte (6 cases repas, une photo par case et par jour), suivi des boissons (« Ma gourde »), pesée du matin facultative (tendance sur 7 jours, rappel « chiffre indicatif » à chaque pesée), rappels de repas et de pesée par notification, guide d'utilisation intégré (bouton « ? », imprimable),
coaching STRICT ou BIENVEILLANT, idées de repas, suivi de la faim, du stress, du poids, partage
avec le coach (avec l'accord du client) et abonnements mensuels facultatifs (Stripe).

> Estimations indicatives. L'application ne remplace pas un médecin, un diététicien ni un allergologue.

## Contenu du dépôt

| Fichier | Rôle |
|---|---|
| `index.html` | L'application (tout est dans ce fichier) |
| `manifest.webmanifest`, `icon-*.png` | Permettent d'ajouter l'application à l'écran d'accueil du téléphone |
| `supabase/schema.sql` | Base de données et règles de confidentialité (à lancer dans Supabase ; peut être relancé sans risque) |
| `supabase/functions/ai/index.ts` | Fonction IA sécurisée : la clé de l'API Claude reste sur le serveur ; vérifie l'abonnement |
| `supabase/functions/billing/index.ts` | Abonnements : page de paiement Stripe, espace « Gérer mon abonnement », mise à jour au retour du paiement |
| `supabase/functions/stripe-webhook/index.ts` | Reçoit les messages de Stripe (paiement, échec, résiliation) ; signature vérifiée |
| `supabase/functions/remind/index.ts` | Rappels de repas et de pesée (5 langues) : notifications Web Push (VAPID, chiffrement aes128gcm), clés créées automatiquement |
| `supabase/cron.sql` | Lance la vérification des rappels toutes les 15 minutes (pg_cron + pg_net) |
| `sw.js` | Service worker, uniquement pour afficher les notifications (aucune mise en cache) |

## Fonctionnement

- **Site** : hébergé gratuitement par GitHub Pages (chaque modification du dépôt est mise en ligne automatiquement).
- **Comptes et données** : Supabase (serveurs en Europe). Chaque client ne voit que ses propres données ;
  le coach ne voit que les résumés des clients qui ont accepté le partage.
- **IA** : la fonction `ai` appelle l'API Claude. Limite par client et par jour réglable avec le secret
  `AI_DAILY_LIMIT` (20 par défaut). Modèles réglables avec `AI_MODEL` (analyse des photos, `claude-haiku-5-5` par défaut, le moins cher ; `claude-sonnet-5-5` pour plus de précision) et `AI_MODEL_QUICK` (messages courts).
- **Protection contre les copies** : les fonctions `ai` et `billing` n'acceptent que les demandes venant du site
  officiel (`ALLOWED_ORIGINS`, défaut `https://keyvos.github.io`). Une copie de l'application hébergée ailleurs
  ne peut donc ni utiliser l'IA ni encaisser d'abonnements. Si le site change d'adresse (nom de domaine),
  mettre la nouvelle adresse dans le secret `ALLOWED_ORIGINS`.
- **Conditions d'utilisation** : acceptées à la création du compte (version enregistrée dans les données du compte).

## Abonnements (facultatif)

Désactivés par défaut : tout le monde utilise l'application gratuitement. Le coach règle tout dans
**Mes clients > Abonnements** :

- interrupteur général (activé / désactivé) ;
- règle des nouveaux comptes (offert ou payant) ;
- réglage personne par personne, par adresse e-mail, même avant l'inscription (famille, proches : « Offert »).

Quand c'est activé, une personne « Payant » sans abonnement à jour garde l'accès à ses données et peut noter ses
repas à la main ; seules l'analyse des photos et les réponses de l'IA sont mises en pause. Après un paiement
refusé, un délai de grâce de 3 jours s'applique. La résiliation se fait par le client lui-même (espace Stripe),
l'abonnement reste actif jusqu'à la fin du mois payé. Supprimer son compte résilie l'abonnement.

Mise en place (une fois) :

1. Compte Stripe (stripe.com) ; activer la carte bancaire et le prélèvement SEPA dans *Paramètres > Moyens de paiement* ;
   activer le *portail client* dans *Paramètres > Billing > Portail client*.
2. Créer un produit « Coach Assiette » avec un prix mensuel récurrent ; noter son identifiant `price_…`.
3. Dans Supabase, créer les fonctions `billing` et `stripe-webhook` (option « Verify JWT » désactivée).
4. Dans Stripe, *Développeurs > Webhooks* : adresse `https://<projet>.supabase.co/functions/v1/stripe-webhook`,
   événements `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted` ; noter le secret de signature `whsec_…`.
5. Secrets Supabase (*Edge Functions > Secrets*) : `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`.
6. Tester d'abord en mode test de Stripe (carte 4242 4242 4242 4242), puis passer aux clés réelles.

## Configuration

Dans `index.html`, en haut du script : `SUPABASE_URL`, `SUPABASE_KEY` (clé *publishable*, publique par conception)
et `OWNER` (nom affiché dans les mentions de droits et les conditions d'utilisation).
Ne jamais mettre de clé secrète, ni la clé de l'API Claude, ni la clé Stripe dans ce dépôt.
