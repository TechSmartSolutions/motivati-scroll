# Motivati-scroll

A private, chat-free vertical video scroller for your own motivational videos, in random order,
with a "get out of your comfort zone" challenge card every N videos.

- Videos are imported from Photos/Files and stored on the device (IndexedDB). Nothing is uploaded.
- Installable PWA (iPhone/iPad: Safari, Share, Add to Home Screen, then open from the icon).
- Challenges are in `src/prompts.json` (draft), and you can add your own in the app menu.

## Develop

Docker Desktop (host port 5183; 37291 is reserved for Docker Monitor):

    docker compose up --build
    # open http://localhost:5183

Or without Docker: `npm install && npm run dev`.

`npm test` runs unit tests, `npm run build` makes the static site in `dist/`.
`node scripts/make-icons.mjs` regenerates the icons.

## Publish

Pushing to `main` deploys to GitHub Pages (`.github/workflows/deploy.yml`) at
`https://<user>.github.io/motivati-scroll/`. For root hosting (e.g. Netlify) build with `BASE_PATH=/`.
