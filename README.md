# Secret Hitler: web edition

A browser version of the social deduction game *Secret Hitler* for 5–10 players. Everyone plays on their own phone or laptop. It's plain HTML, CSS and JavaScript with no build step, and it runs on GitHub Pages.

## How multiplayer works without a server

GitHub Pages can only serve static files, so the **host's browser acts as the game server**:

1. The host clicks **Host a new game** and gets a 5-letter room code and an invite link.
2. Other players open the link, or visit the site and type the code.
3. Browsers connect directly to each other over WebRTC using [PeerJS](https://peerjs.com). PeerJS's free public broker only introduces the browsers to each other. Game traffic goes peer to peer.
4. The host's browser runs the rules engine and sends each player **only what they're allowed to see**. Liberals never receive anyone's role, and only the President or Chancellor receives the cards in their hand.

**The host must keep their tab open.** If the host refreshes the page, the game is restored from session storage and players reconnect automatically. If the host closes the tab, the game ends.

Players who refresh, lose signal or switch apps reconnect automatically. A player on a new device can rejoin a game in progress by entering the **same name** as their disconnected seat.

## Deploy to GitHub Pages

1. Create a new repository on GitHub, for example `secret-hitler`.
2. Upload everything in this folder to the root of the repo: `index.html`, `css/`, `js/`, `lib/` and `.nojekyll`. You can drag them into GitHub's "Add file → Upload files" page, or use git:
   ```bash
   git init && git add . && git commit -m "Secret Hitler web"
   git branch -M main
   git remote add origin https://github.com/YOUR-USER/secret-hitler.git
   git push -u origin main
   ```
3. In the repo, go to **Settings → Pages**, set **Source** to *Deploy from a branch*, pick `main` and `/ (root)`, then save.
4. After a minute the site is live at `https://YOUR-USER.github.io/secret-hitler/`.

If you fork the project, change `PEER_PREFIX` in `js/net.js` to your own random string so your room IDs can't clash with other copies.

## Testing on one computer

Add `?local=1` to the URL to play across **several tabs of the same browser** without any network. This uses a BroadcastChannel instead of WebRTC:

```bash
python3 -m http.server 8000
# open http://localhost:8000/?local=1 in 5+ tabs
```

Each tab is a separate player. Host in the first tab, then paste the invite link (it keeps `local=1`) into the others.

## If players can't connect

Most home Wi-Fi and mobile networks work with the built-in STUN servers. Some strict networks (certain corporate Wi-Fi or mobile carriers) block direct peer-to-peer connections. If one player can't join while others can, add a TURN relay to `ICE_SERVERS` in `js/net.js`. Metered, Twilio and Cloudflare all offer free tiers, or you can run your own with coturn.

## What's implemented

- All official roles and player counts (5–10), including Hitler knowing his team only at 5–6 players
- Nomination with term limits (the last President's limit is lifted at 5 living players)
- Simultaneous secret voting, revealed together, with a per-player Ja!/Nein! history
- Legislative session: the President discards 1 of 3 and the Chancellor enacts 1 of 2
- Election tracker and chaos policy (no power granted, term limits reset)
- Every presidential power, using the correct board for each player count: policy peek, investigate loyalty (each player at most once), special election (order resumes after the caller) and execution
- Veto power after 5 Fascist policies
- All four win conditions, followed by a full role reveal and a return to the lobby for a rematch
- Host controls: remove players in the lobby and end a game early
- "Your turn" indicator in the tab title, plus a short vibration on phones

## Files

| File | Purpose |
|---|---|
| `index.html` | Page shell |
| `css/style.css` | All styling (mobile first) |
| `js/game.js` | Pure rules engine, also runs in Node for testing |
| `js/net.js` | PeerJS and local-tab transports |
| `js/app.js` | Home, lobby, host server, member client and game UI |
| `lib/peerjs.min.js` | PeerJS 1.5.5 (MIT), bundled so no CDN is needed |

## License and credits

*Secret Hitler* was designed by Mike Boxleiter, Tommy Maranges and Max Temkin, with illustrations by Mac Schubert. It is released under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). This adaptation uses no original artwork and is not affiliated with or endorsed by the creators. Because it is a derivative work, this project is also shared under **CC BY-NC-SA 4.0**: you may share and adapt it with attribution, but **not for commercial use**.

PeerJS is © Michelle Bu and Eric Zhang, MIT License (`lib/PEERJS-LICENSE.txt`).
