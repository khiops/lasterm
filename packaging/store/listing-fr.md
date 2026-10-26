# Fiche Store — français (fr-FR)

Pour la soumission au Microsoft Store (#618). Le workflow de release envoie ce texte à Partner Center
à chaque release (#619) ; garder les quatre sections dans cet ordre, qui est lu par position. Chaque
affirmation doit rester vraie de l’app publiée et suivre `listing-en.md`, qui fait foi.

## Description courte (affichée dans les résultats de recherche)

Des terminaux qui restent là où vous les avez laissés : vos shells locaux et SSH continuent de tourner quand vous fermez la fenêtre.

## Description

Lasterm fait tourner vos shells dans un hub sur votre ordinateur, pas dans la fenêtre. Réduisez la fenêtre dans la zone de notification : ils continuent de tourner, ceux en SSH compris. Rouvrez-la : chaque écran est tel que vous l’avez laissé.

Ajoutez les machines sur lesquelles vous travaillez en SSH, directement ou via un hôte de rebond. Lasterm copie son petit agent sur chacune, adapté à son système, et n’y ouvre aucun port. Un hôte Linux peut garder cet agent en marche : ses terminaux survivent alors aussi à une connexion perdue.

POINTS FORTS
• Les sessions survivent à la fenêtre : fermez-la ou rechargez-la, chaque terminal continue de tourner et revient avec son écran.
• Hôtes distants en SSH : une clé, votre agent SSH ou un mot de passe demandé à chaque fois ; hôtes de rebond ; clés d’hôte vérifiées par rapport à ce que vous approuvez, y compris votre propre known_hosts.
• Des terminaux qui survivent à une connexion perdue, sur les hôtes Linux qui gardent un agent en marche. Sur les hôtes Windows, les shells se terminent avec la connexion.
• Une barre d’hôtes : un badge, une couleur et un point d’état pour chacun, dans les groupes et l’ordre que vous choisissez.
• Onglets, panneaux divisés, et recherche dans un panneau ou dans tous.
• Profils de lancement : shell, environnement, dossier de travail et élévation avec sudo, doas, pkexec ou gsudo.
• Neuf thèmes, par hôte et par terminal, avec Mica et Acrylic sous Windows 11.
• Pas de compte, pas de télémétrie : Lasterm n’envoie rien sur vous, votre ordinateur ou vos terminaux. Les mises à jour arrivent par le Store.

Logiciel libre, sous licence AGPL-3.0.

## Fonctionnalités (une courte liste, affichée sur la page du Store)

- Des terminaux locaux et SSH qui continuent de tourner quand la fenêtre se ferme
- Chaque écran restauré tel que vous l’avez laissé
- Hôtes SSH joints directement ou via un hôte de rebond
- Des terminaux qui survivent à une connexion perdue sur les hôtes Linux
- Une barre d’hôtes avec l’état de chacun d’un coup d’œil
- Onglets, panneaux divisés et recherche dans tous les panneaux
- Profils de lancement avec environnement, dossier de travail et élévation
- Neuf thèmes, par hôte et par terminal ; Mica et Acrylic sous Windows 11
- Pas de compte, pas de télémétrie

## Mots-clés (7 au plus, 40 caractères chacun)

ssh, client ssh, terminal, émulateur de terminal, sessions persistantes, shell distant, hôte de rebond
