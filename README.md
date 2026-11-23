# Motivati-scroll

A private, chat-free vertical scroller for your own motivational videos and images, in random order,
with a "get out of your comfort zone" challenge card every N items.

- Your media lives on a home server (this repo's Docker container), so every device on your Wi-Fi shows the same feed.
- Add or remove videos and images from the app menu. Files are stored as plain files in `./media-library`.
- Settings, level progress and custom challenges are still stored per device (in the browser).
- No login: anyone on your Wi-Fi who can reach the server can view, add and delete media. Do not expose the port to the internet.

## Run (home server, Docker Desktop)

    docker compose up -d --build

Then open `http://<server-PC-IP>:5183` on your phone (find the IP with `ipconfig` on Windows).
Give the PC a fixed IP or a DHCP reservation in your router, otherwise a home-screen icon can stop working when the IP changes.
To store media somewhere else, set `MEDIA_DIR` (for example in a `.env` file next to `docker-compose.yml`):

    MEDIA_DIR=D:/motivati-media

Back up that folder to back up the library (`media/` plus `library.json`).

Over plain http, browsers do not run service workers or keep the screen awake (Wake Lock), so the app is online-only and the
screen may dim while an image is shown. iPhone "Add to Home Screen" still opens it full screen.
Supported files: mp4, m4v, mov, webm, jpg, png, gif, webp, avif, heic (HEIC images only display in Safari).

## Develop

    npm install
    npm run build && npm start      # server on http://localhost:5183 (data in ./media-library)
    npm run dev                     # Vite on :5186, proxies /api and /media to :5183

Or with Docker: `docker compose --profile dev up --build`, then open `http://localhost:5186`.

`npm test` runs unit tests, `npm run build` makes the static site in `dist/`.
`node scripts/make-icons.mjs` regenerates the icons.
