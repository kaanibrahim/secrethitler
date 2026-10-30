/*
 * App: home screen, lobby, host server and game UI.
 *
 * The host's browser owns the real game state (SHGame) and sends every player
 * a personalised view after each change. Members only ever send intents
 * ("I vote Ja", "I nominate X"); the host validates them with the rules engine.
 */
(function () {
  'use strict';

  const G = window.SHGame;
  const Net = window.SHNet;
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  const params = new URLSearchParams(location.search);
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

  /* ---------------- utilities ---------------- */

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => 'p' + Math.random().toString(36).slice(2, 10);
  const genCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  const cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
  const cleanName = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  const ss = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };

  let toastTimer;
  function toast(msg, kind) {
    $toast.textContent = msg;
    $toast.className = 'toast show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $toast.className = 'toast'; }, 3800);
  }

  function shareLink(code) {
    const u = new URL(location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('room', code);
    if (Net.LOCAL) u.searchParams.set('local', '1');
    return u.toString();
  }

  /* ---------------- client-side state ---------------- */

  const S = {
    role: null,        // 'host' | 'member' | null
    code: null,
    pid: null,
    name: ls.get('sh_name') || '',
    lobby: null,
    view: null,
    conn: 'idle',      // idle | connecting | connected | reconnecting
    status: '',
    sel: null,
    selKey: '',
    roleShown: false,
    confirmEnd: false,
    screen: null,
  };

  let server = null;   // HostServer when hosting
  let client = null;   // MemberClient when joined

  /* ================= HOST SERVER ================= */

  class HostServer {
    constructor(opts) {
      this.code = opts.code;
      this.hostId = opts.hostId;
      this.players = opts.players || [{ id: opts.hostId, name: opts.hostName }];
      this.game = opts.game || null;
      this.connOf = new Map(); // playerId -> connId
      this.pidOf = new Map();  // connId -> playerId
      this.net = Net.host(this.code, {
        onReady: () => { S.conn = 'connected'; S.status = ''; this.broadcast(); },
        onMessage: (cid, msg) => this.onMessage(cid, msg),
        onClose: cid => this.onClose(cid),
        onError: (msg, kind) => {
          toast(msg, 'bad');
          if (kind === 'taken') { leaveToHome(); }
        },
        onStatus: msg => { S.status = msg; render(); },
      });
    }

    save() {
      ss.set('sh_host', { code: this.code, hostId: this.hostId, players: this.players, game: this.game });
    }

    isConnected(pid) { return pid === this.hostId || this.connOf.has(pid); }

    lobbyView() {
      return {
        code: this.code,
        hostId: this.hostId,
        started: !!this.game,
        players: this.players.map(p => ({ id: p.id, name: p.name, connected: this.isConnected(p.id) })),
      };
    }

    send(pid, msg) {
      if (pid === this.hostId) return receive(msg);
      const cid = this.connOf.get(pid);
      if (cid) this.net.send(cid, msg);
    }

    broadcast() {
      this.save();
      const lobby = this.lobbyView();
      for (const p of this.players) {
        this.send(p.id, { t: 'state', lobby, view: this.game ? G.getView(this.game, p.id) : null });
      }
    }

    bind(cid, pid) {
      const old = this.connOf.get(pid);
      if (old && old !== cid) { this.pidOf.delete(old); this.net.drop(old); }
      this.connOf.set(pid, cid);
      this.pidOf.set(cid, pid);
      this.net.send(cid, { t: 'welcome', pid, code: this.code });
    }

    reject(cid, msg) {
      this.net.send(cid, { t: 'reject', msg });
      this.net.drop(cid);
    }

    onMessage(cid, msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'hello') return this.join(cid, msg);
      const pid = this.pidOf.get(cid);
      if (pid) this.handle(pid, msg);
    }

    onClose(cid) {
      const pid = this.pidOf.get(cid);
      this.pidOf.delete(cid);
      if (pid && this.connOf.get(pid) === cid) {
        this.connOf.delete(pid);
        this.broadcast();
      }
    }

    join(cid, msg) {
      const name = cleanName(msg.name);
      if (!name) return this.reject(cid, 'Please enter a name.');
      let p = this.players.find(x => x.id === msg.pid);
      if (!p) {
        const same = this.players.find(x => x.name.toLowerCase() === name.toLowerCase());
        if (same && this.game && !this.isConnected(same.id)) {
          p = same; // rejoining from a different device / after closing the tab
        } else if (same) {
          return this.reject(cid, 'Someone in this room is already called "' + same.name + '".');
        } else if (this.game) {
          return this.reject(cid, 'This game has already started.');
        } else if (this.players.length >= G.MAX_PLAYERS) {
          return this.reject(cid, 'This room is full (10 players).');
        } else {
          p = { id: msg.pid || uid(), name };
          this.players.push(p);
        }
      } else if (!this.game && p.name !== name) {
        if (this.players.some(x => x !== p && x.name.toLowerCase() === name.toLowerCase())) {
          return this.reject(cid, 'Someone in this room is already called "' + name + '".');
        }
        p.name = name;
      }
      this.bind(cid, p.id);
      this.broadcast();
    }

    handle(pid, msg) {
      const isHost = pid === this.hostId;
      try {
        switch (msg.t) {
          case 'act':
            if (!this.game) return;
            G.applyAction(this.game, pid, msg.a);
            break;
          case 'leave':
            if (!this.game) this.players = this.players.filter(p => p.id !== pid);
            if (pid !== this.hostId) {
              const cid = this.connOf.get(pid);
              this.connOf.delete(pid);
              if (cid) { this.pidOf.delete(cid); this.net.drop(cid); }
            }
            break;
          case 'start':
            if (!isHost) return;
            if (this.game) return;
            if (this.players.length < G.MIN_PLAYERS) throw Object.assign(new Error('You need at least 5 players.'), { userFacing: true });
            this.game = G.createGame(this.players);
            break;
          case 'kick': {
            if (!isHost || this.game || msg.target === this.hostId) return;
            this.send(msg.target, { t: 'kicked' });
            const cid = this.connOf.get(msg.target);
            this.connOf.delete(msg.target);
            if (cid) { this.pidOf.delete(cid); this.net.drop(cid); }
            this.players = this.players.filter(p => p.id !== msg.target);
            break;
          }
          case 'tolobby':
            if (!isHost) return;
            this.game = null;
            break;
          default:
            return;
        }
      } catch (err) {
        this.send(pid, { t: 'error', msg: err.userFacing ? err.message : 'Something went wrong.' });
        if (!err.userFacing) console.error(err);
        return;
      }
      this.broadcast();
    }

    close() {
      for (const p of this.players) if (p.id !== this.hostId) this.send(p.id, { t: 'closed' });
      setTimeout(() => this.net.close(), 300);
      ss.del('sh_host');
    }
  }

  /* ================= MEMBER CLIENT ================= */

  class MemberClient {
    constructor(code, pid, name) {
      this.code = code;
      this.pid = pid;
      this.name = name;
      this.welcomed = false;
      this.dead = false;
      this.retries = 0;
      this.connect();
    }

    connect() {
      if (this.dead) return;
      S.conn = this.welcomed ? 'reconnecting' : 'connecting';
      render();
      this.link = Net.join(this.code, {
        onOpen: () => { this.retries = 0; this.link.send({ t: 'hello', pid: this.pid, name: this.name }); },
        onMessage: msg => {
          if (msg.t === 'welcome') {
            this.welcomed = true;
            this.pid = msg.pid;
            S.pid = msg.pid;
            S.conn = 'connected';
            ss.set('sh_member', { code: this.code, pid: this.pid, name: this.name });
          }
          receive(msg);
        },
        onClose: () => this.retry(),
        onError: (msg, kind) => {
          if (this.welcomed || (kind === 'network')) return this.retry();
          this.dead = true;
          toast(msg, 'bad');
          leaveToHome();
        },
      });
    }

    retry() {
      if (this.dead) return;
      try { this.link && this.link.close(); } catch (e) { /* ignore */ }
      this.link = null;
      S.conn = 'reconnecting';
      render();
      this.retries++;
      if (this.retries > 60) { this.dead = true; toast('Lost connection to the host.', 'bad'); leaveToHome(); return; }
      setTimeout(() => this.connect(), Math.min(1000 * this.retries, 4000));
    }

    send(msg) { this.link && this.link.send(msg); }

    close() {
      this.dead = true;
      this.send({ t: 'leave' });
      setTimeout(() => { try { this.link && this.link.close(); } catch (e) { /* ignore */ } }, 200);
    }
  }

  /* ================= message handling ================= */

  function receive(msg) {
    switch (msg.t) {
      case 'state': {
        const hadGame = !!S.view;
        S.lobby = msg.lobby;
        S.view = msg.view;
        if (!S.view || !hadGame) S.roleShown = false;
        render();
        notifyTurn();
        break;
      }
      case 'error': toast(msg.msg, 'bad'); break;
      case 'reject':
        if (client) client.dead = true;
        toast(msg.msg, 'bad');
        leaveToHome();
        break;
      case 'kicked':
        if (client) client.dead = true;
        toast('You were removed from the room by the host.', 'bad');
        leaveToHome();
        break;
      case 'closed':
        if (client) client.dead = true;
        toast('The host closed the room.', 'bad');
        leaveToHome();
        break;
    }
  }

  function send(msg) {
    if (S.role === 'host' && server) server.handle(S.pid, msg);
    else if (client) client.send(msg);
  }
  const act = a => send({ t: 'act', a });

  /* ================= navigation ================= */

  function startHosting(name) {
    const code = genCode();
    S.role = 'host';
    S.code = code;
    S.pid = uid();
    S.name = name;
    S.conn = 'connecting';
    server = new HostServer({ code, hostId: S.pid, hostName: name });
    history.replaceState(null, '', shareLink(code).replace('?room=', '?host='));
    render();
  }

  function resumeHosting(saved) {
    S.role = 'host';
    S.code = saved.code;
    S.pid = saved.hostId;
    S.name = (saved.players.find(p => p.id === saved.hostId) || {}).name || S.name;
    S.conn = 'connecting';
    server = new HostServer({ code: saved.code, hostId: saved.hostId, players: saved.players, game: saved.game });
    render();
  }

  function joinRoom(code, name, pid) {
    S.role = 'member';
    S.code = code;
    S.name = name;
    S.pid = pid || uid();
    client = new MemberClient(code, S.pid, name);
  }

  function leaveToHome() {
    if (server) { server.close(); server = null; }
    if (client) { client.close(); client = null; }
    ss.del('sh_host');
    ss.del('sh_member');
    Object.assign(S, { role: null, code: null, lobby: null, view: null, conn: 'idle', status: '', sel: null, roleShown: false });
    const u = new URL(location.href);
    u.searchParams.delete('host');
    u.searchParams.delete('room');
    history.replaceState(null, '', u.toString());
    document.title = 'Secret Hitler';
    render();
  }

  /* ================= rendering ================= */

  function render() {
    let screen;
    if (!S.role) screen = 'home';
    else if (!S.lobby) screen = 'connecting';
    else if (S.view) screen = 'game';
    else screen = 'lobby';

    // Home has text inputs, so only build it when we arrive there.
    if (screen === 'home' && S.screen === 'home') return;
    S.screen = screen;
    if (screen === 'home') $app.innerHTML = renderHome();
    else if (screen === 'connecting') $app.innerHTML = renderConnecting();
    else if (screen === 'lobby') $app.innerHTML = renderLobby();
    else $app.innerHTML = renderGame();
    if (screen === 'home') {
      const n = document.getElementById('name');
      if (n && !n.value) n.focus();
    }
  }

  function connBanner() {
    if (S.conn === 'reconnecting') return '<div class="banner warn">Connection lost. Reconnecting to the host…</div>';
    if (S.status) return `<div class="banner warn">${esc(S.status)}</div>`;
    return '';
  }

  function renderHome() {
    const room = cleanCode(params.get('room'));
    return `
      <main class="home">
        <header class="title">
          <div class="title-top">A game of hidden roles</div>
          <h1>Secret Hitler</h1>
          <div class="title-sub">5–10 players · one device each</div>
        </header>
        <form class="panel" data-form="home" autocomplete="off">
          <label class="field">
            <span>Your name</span>
            <input id="name" maxlength="16" value="${esc(S.name)}" placeholder="e.g. Ada" required>
          </label>
          ${room ? `
            <div class="invite">You've been invited to room <b class="code">${esc(room)}</b></div>
            <input type="hidden" id="code" value="${esc(room)}">
            <button class="btn primary big" data-act="join" type="submit">Join game</button>
            <button class="btn ghost" data-act="clear-invite" type="button">Host a new game instead</button>
          ` : `
            <button class="btn primary big" data-act="create" type="button">Host a new game</button>
            <div class="or"><span>or join with a code</span></div>
            <div class="join-row">
              <input id="code" maxlength="5" placeholder="CODE" class="code-input" autocapitalize="characters" spellcheck="false">
              <button class="btn" data-act="join" type="submit">Join</button>
            </div>
          `}
        </form>
        <details class="panel rules">
          <summary>How to play</summary>
          ${rulesHtml()}
        </details>
        <footer class="foot">
          Fan-made adaptation of <i>Secret Hitler</i> by Mike Boxleiter, Tommy Maranges, Max Temkin and Mac Schubert,
          used under <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a>.
          Not affiliated with the original creators.${Net.LOCAL ? '<br><b>Local test mode</b>: open more tabs in this browser to add players.' : ''}
        </footer>
      </main>`;
  }

  function rulesHtml() {
    return `
      <p>Players are secretly split into <b class="lib">Liberals</b> and <b class="fas">Fascists</b>. One Fascist is <b class="fas">Hitler</b>.
      Fascists know who each other are; Hitler only knows his team in 5–6 player games. Liberals know nothing.</p>
      <p>Each round the <b>President</b> nominates a <b>Chancellor</b> and everyone votes <i>Ja!</i> or <i>Nein!</i>.
      If the vote passes, the President draws three policies, discards one, and the Chancellor enacts one of the remaining two.
      Three failed votes in a row enacts the top policy automatically.</p>
      <p>Some Fascist policies give the President a power: examine the top three policies, investigate a player's party,
      call a special election, or execute a player. After five Fascist policies, the government may veto an agenda.</p>
      <p><b class="lib">Liberals win</b> by enacting 5 Liberal policies or executing Hitler.
      <b class="fas">Fascists win</b> by enacting 6 Fascist policies or electing Hitler Chancellor after 3 Fascist policies are in play.</p>
      <p>Talk, accuse and lie out loud (or on a call). This app handles the cards and votes.</p>`;
  }

  function renderConnecting() {
    const label = S.role === 'host' ? 'Opening room…' : (S.conn === 'reconnecting' ? 'Reconnecting…' : 'Joining room ' + esc(S.code) + '…');
    return `
      <main class="center">
        <div class="spinner"></div>
        <p>${label}</p>
        ${S.status ? `<p class="muted">${esc(S.status)}</p>` : ''}
        <button class="btn ghost" data-act="leave">Cancel</button>
      </main>`;
  }

  function renderLobby() {
    const L = S.lobby;
    const isHost = S.role === 'host';
    const n = L.players.length;
    const link = shareLink(L.code);
    const counts = G.ROLE_COUNTS[n];
    return `
      <main class="lobby">
        ${connBanner()}
        <section class="panel room">
          <div class="muted small">Room code</div>
          <div class="big-code">${esc(L.code)}</div>
          <div class="link-row">
            <input readonly value="${esc(link)}" class="link" onclick="this.select()">
            <button class="btn" data-act="copy-link">Copy link</button>
            ${navigator.share ? '<button class="btn" data-act="share-link">Share</button>' : ''}
          </div>
          <p class="muted small">Friends can open the link, or go to this site and type the code.</p>
        </section>

        <section class="panel">
          <h2>Players <span class="muted">${n}/10</span></h2>
          <ul class="lobby-list">
            ${L.players.map(p => `
              <li class="${p.connected ? '' : 'offline'}">
                <span class="dot ${p.connected ? 'on' : ''}"></span>
                <span class="pname">${esc(p.name)}</span>
                ${p.id === L.hostId ? '<span class="tag gold">Host</span>' : ''}
                ${p.id === S.pid ? '<span class="tag">You</span>' : ''}
                ${isHost && p.id !== L.hostId ? `<button class="btn tiny ghost" data-act="kick" data-id="${esc(p.id)}">Remove</button>` : ''}
              </li>`).join('')}
          </ul>
          ${counts ? `<p class="muted small">With ${n} players: ${counts[0]} Liberals, ${counts[1]} Fascist${counts[1] > 1 ? 's' : ''} + Hitler.</p>` : ''}
        </section>

        ${isHost ? `
          <button class="btn primary big" data-act="start" ${n < 5 ? 'disabled' : ''}>
            ${n < 5 ? `Waiting for players (${n}/5 minimum)` : `Start game with ${n} players`}
          </button>
          <p class="muted small center-text">Keep this tab open: your browser is running the game.</p>
        ` : `<div class="panel waiting">Waiting for the host to start the game…</div>`}
        <button class="btn ghost" data-act="leave">${isHost ? 'Close room' : 'Leave room'}</button>
      </main>`;
  }

  /* ---------------- game screen ---------------- */

  const ROLE_LABEL = { liberal: 'Liberal', fascist: 'Fascist', hitler: 'Hitler' };
  const POWER_LABEL = {
    peek: 'Policy peek',
    investigate: 'Investigate loyalty',
    special: 'Special election',
    execute: 'Execution',
  };

  function pname(pub, id) {
    const p = pub.players.find(x => x.id === id);
    return p ? esc(p.name) : '?';
  }

  function policyCard(card, opts) {
    opts = opts || {};
    const lib = card === 'L';
    return `<button class="policy ${lib ? 'lib' : 'fas'} ${opts.selected ? 'selected' : ''}" ${opts.act ? `data-act="${opts.act}" data-idx="${opts.idx}"` : 'disabled'}>
      <span class="policy-inner"><span class="policy-mark">${lib ? '◆' : '✕'}</span><span>${lib ? 'Liberal' : 'Fascist'}</span><small>policy</small></span>
    </button>`;
  }

  function targetButtons(pub, ids, confirmLabel, actType) {
    const sel = S.sel;
    return `
      <div class="targets">
        ${ids.map(id => `<button class="btn target ${sel === id ? 'selected' : ''}" data-act="select" data-id="${esc(id)}">${pname(pub, id)}</button>`).join('')}
      </div>
      <button class="btn primary" data-act="confirm-target" data-type="${actType}" ${sel && ids.includes(sel) ? '' : 'disabled'}>
        ${sel && ids.includes(sel) ? `${confirmLabel} ${pname(pub, sel)}` : 'Select a player'}
      </button>`;
  }

  function actionPanel(pub, priv, me) {
    const amPres = pub.presidentId === S.pid;
    const amChanc = pub.chancellorId === S.pid;
    const pres = pname(pub, pub.presidentId);
    const alive = me && me.alive;
    const wait = (txt) => `<div class="action waiting"><div class="action-title">${txt}</div></div>`;
    const mine = (title, body) => `<div class="action mine"><div class="action-kicker">Your move</div><div class="action-title">${title}</div>${body}</div>`;

    if (!me) return wait('You are spectating.');

    let out = '';
    if (!alive && pub.phase !== 'gameover') {
      out += '<div class="banner dead">You have been executed. You may not vote, speak about your role, or hold office.</div>';
    }

    switch (pub.phase) {
      case 'nominate':
        if (amPres) {
          out += mine('Nominate a Chancellor', `
            <p class="muted small">Ineligible: you, the last elected Chancellor${pub.termLimitPresident ? ' and the last elected President' : ''}.</p>
            ${targetButtons(pub, pub.eligibleChancellors, 'Nominate', 'nominate')}`);
        } else out += wait(`${pres} is choosing a Chancellor…`);
        break;

      case 'vote': {
        const living = pub.players.filter(p => p.alive);
        const voted = living.filter(p => p.hasVoted).length;
        const govt = `<div class="govt"><span><small>President</small>${pres}</span><span><small>Chancellor</small>${pname(pub, pub.nomineeId)}</span></div>`;
        if (alive) {
          const v = priv.myVote;
          out += mine('Vote on this government', `${govt}
            <div class="vote-row">
              <button class="vote ja ${v === true ? 'selected' : ''}" data-act="vote" data-ja="1">Ja!</button>
              <button class="vote nein ${v === false ? 'selected' : ''}" data-act="vote" data-ja="0">Nein!</button>
            </div>
            <p class="muted small center-text">${v === undefined ? 'Votes are revealed once everyone has voted.' : 'Vote cast. You can change it until everyone has voted.'} ${voted}/${living.length} voted.</p>`);
        } else {
          out += `<div class="action waiting"><div class="action-title">The table is voting</div>${govt}<p class="muted small center-text">${voted}/${living.length} voted.</p></div>`;
        }
        break;
      }

      case 'president_legislate':
        if (amPres && priv.hand) {
          out += mine('Discard one policy', `
            <p class="muted small">The other two go to Chancellor ${pname(pub, pub.chancellorId)}.</p>
            <div class="hand">${priv.hand.map((c, i) => policyCard(c, { act: 'pick-card', idx: i, selected: S.sel === i })).join('')}</div>
            <button class="btn primary" data-act="confirm-card" data-type="discard" ${Number.isInteger(S.sel) ? '' : 'disabled'}>${Number.isInteger(S.sel) ? 'Discard this policy' : 'Tap a policy to discard'}</button>`);
        } else out += wait(`President ${pres} is reviewing three policies…`);
        break;

      case 'chancellor_legislate':
        if (amChanc && priv.hand) {
          const canVeto = pub.vetoUnlocked && !pub.vetoRejected;
          out += mine('Enact one policy', `
            <div class="hand">${priv.hand.map((c, i) => policyCard(c, { act: 'pick-card', idx: i, selected: S.sel === i })).join('')}</div>
            <button class="btn primary" data-act="confirm-card" data-type="enact" ${Number.isInteger(S.sel) ? '' : 'disabled'}>${Number.isInteger(S.sel) ? 'Enact this policy' : 'Tap a policy to enact'}</button>
            ${canVeto ? '<button class="btn ghost" data-act="veto">Propose a veto</button>' : ''}
            ${pub.vetoUnlocked && pub.vetoRejected ? '<p class="muted small">The President refused your veto.</p>' : ''}`);
        } else out += wait(`Chancellor ${pname(pub, pub.chancellorId)} is choosing a policy to enact…`);
        break;

      case 'veto_response':
        if (amPres) {
          out += mine('The Chancellor wants to veto', `
            <p class="muted small">If you agree, both policies are discarded and the election tracker advances.</p>
            <div class="hand">${(priv.hand || []).map(c => policyCard(c)).join('')}</div>
            <div class="vote-row">
              <button class="vote ja" data-act="veto-yes">Agree to veto</button>
              <button class="vote nein" data-act="veto-no">Refuse</button>
            </div>`);
        } else out += wait(`Chancellor ${pname(pub, pub.chancellorId)} proposed a veto. President ${pres} is deciding…`);
        break;

      case 'power_peek':
        if (amPres && priv.peek) {
          out += mine('Policy peek', `
            <p class="muted small">These are the next three policies, in order. Only you can see them.</p>
            <div class="hand">${priv.peek.map(c => policyCard(c)).join('')}</div>
            <button class="btn primary" data-act="ack">Done</button>`);
        } else out += wait(`President ${pres} is examining the top three policies…`);
        break;

      case 'power_investigate':
        if (amPres) out += mine('Investigate a player', `<p class="muted small">You'll see their party membership (Hitler shows as Fascist).</p>${targetButtons(pub, pub.targets, 'Investigate', 'investigate')}`);
        else out += wait(`President ${pres} is choosing someone to investigate…`);
        break;

      case 'investigate_result': {
        const r = priv.investigationResult;
        if (amPres && r) {
          out += mine('Investigation result', `
            <div class="reveal ${r.party === 'liberal' ? 'lib' : 'fas'}">${pname(pub, r.targetId)} is a <b>${r.party === 'liberal' ? 'Liberal' : 'Fascist'}</b></div>
            <p class="muted small">Only you know this. Share it, or lie about it.</p>
            <button class="btn primary" data-act="ack">Done</button>`);
        } else out += wait(`President ${pres} is reviewing the investigation…`);
        break;
      }

      case 'power_special':
        if (amPres) out += mine('Call a special election', `<p class="muted small">Choose the next presidential candidate. Afterwards the order resumes from you.</p>${targetButtons(pub, pub.targets, 'Make President:', 'special')}`);
        else out += wait(`President ${pres} is choosing the next presidential candidate…`);
        break;

      case 'power_execute':
        if (amPres) out += mine('Execute a player', `<p class="muted small">If you execute Hitler, the Liberals win.</p>${targetButtons(pub, pub.targets, 'Execute', 'execute')}`);
        else out += wait(`President ${pres} must execute a player…`);
        break;

      case 'gameover':
        out += gameOverPanel(pub);
        break;
    }
    return out;
  }

  function gameOverPanel(pub) {
    const lib = pub.winner === 'liberal';
    return `
      <div class="action gameover ${lib ? 'lib' : 'fas'}">
        <div class="action-kicker">Game over</div>
        <div class="win-title">${lib ? 'Liberals win' : 'Fascists win'}</div>
        <p>${esc(pub.winReason)}</p>
        <ul class="role-reveal">
          ${pub.players.map(p => `<li class="${p.role}"><span>${esc(p.name)}${p.alive ? '' : ' ✝'}</span><b>${ROLE_LABEL[p.role]}</b></li>`).join('')}
        </ul>
        ${S.role === 'host' ? '<button class="btn primary" data-act="tolobby">Back to lobby</button>' : '<p class="muted small">Waiting for the host to start another game.</p>'}
      </div>`;
  }

  function roleCard(pub, priv) {
    if (!priv) return '';
    const known = priv.known.map(k => `<li class="${k.role}">${pname(pub, k.id)} <b>${ROLE_LABEL[k.role]}</b></li>`).join('');
    const inv = priv.investigations.map(r => `<li class="${r.party}">${pname(pub, r.targetId)} <b>${r.party === 'liberal' ? 'Liberal' : 'Fascist'}</b></li>`).join('');
    let teamNote = '';
    if (priv.role === 'liberal') teamNote = 'Find and stop the Fascists. Trust no one.';
    else if (priv.role === 'hitler') teamNote = priv.known.length ? 'Your fellow Fascists:' : 'You do not know who the Fascists are, but they know you. Play it safe and act Liberal.';
    else teamNote = 'Your team:';
    return `
      <section class="panel role-panel">
        <button class="role-toggle" data-act="toggle-role">
          <span>Your secret role</span><span class="muted small">${S.roleShown ? 'Tap to hide' : 'Tap to reveal'}</span>
        </button>
        ${S.roleShown ? `
          <div class="role-card ${priv.role}">
            <div class="role-name">${ROLE_LABEL[priv.role]}</div>
            <div class="role-party">Party: ${priv.party === 'liberal' ? 'Liberal' : 'Fascist'}</div>
          </div>
          <p class="small">${teamNote}</p>
          ${known ? `<ul class="known">${known}</ul>` : ''}
          ${inv ? `<p class="small muted">Your investigations:</p><ul class="known">${inv}</ul>` : ''}
        ` : ''}
      </section>`;
  }

  function boards(pub) {
    const libSlots = Array.from({ length: 5 }, (_, i) => `
      <div class="slot ${i < pub.liberal ? 'filled lib' : ''}">${i < pub.liberal ? '◆' : (i === 4 ? '<small>Liberals win</small>' : '')}</div>`).join('');
    const fasSlots = Array.from({ length: 6 }, (_, i) => {
      const power = pub.powers[i];
      let label = power ? POWER_LABEL[power] : '';
      if (i === 5) label = 'Fascists win';
      const extra = i === 4 ? '<em>+ veto</em>' : '';
      return `<div class="slot ${i < pub.fascist ? 'filled fas' : ''} ${i >= 3 && i < 5 ? 'danger' : ''}">${i < pub.fascist ? '✕' : `<small>${label}</small>${extra}`}</div>`;
    }).join('');
    const tracker = [0, 1, 2].map(i => `<span class="pip ${i < pub.tracker ? 'on' : ''}"></span>`).join('');
    return `
      <section class="panel boards">
        <div class="track-label lib">Liberal policies <span>${pub.liberal}/5</span></div>
        <div class="track lib">${libSlots}</div>
        <div class="track-label fas">Fascist policies <span>${pub.fascist}/6</span></div>
        <div class="track fas">${fasSlots}</div>
        ${pub.fascist >= 3 ? '<div class="hitler-warn">Hitler wins if elected Chancellor</div>' : ''}
        <div class="meta-row">
          <div><small>Failed elections</small><div class="pips">${tracker}</div></div>
          <div><small>Draw pile</small><b>${pub.deckCount}</b></div>
          <div><small>Discard</small><b>${pub.discardCount}</b></div>
        </div>
      </section>`;
  }

  function playersPanel(pub, priv) {
    const connected = id => !S.lobby || (S.lobby.players.find(p => p.id === id) || {}).connected;
    const knownRole = id => {
      if (!priv) return null;
      const k = priv.known.find(x => x.id === id);
      if (k) return k.role;
      const inv = priv.investigations.find(x => x.targetId === id);
      return inv ? (inv.party === 'liberal' ? 'liberal?' : 'fascist?') : null;
    };
    const items = pub.players.map(p => {
      const tags = [];
      if (p.id === pub.presidentId) tags.push('<span class="tag gold">President</span>');
      if (p.id === pub.chancellorId) tags.push('<span class="tag gold">Chancellor</span>');
      if (p.id === pub.nomineeId) tags.push('<span class="tag">Nominee</span>');
      if (pub.phase === 'nominate' && p.alive && p.id !== pub.presidentId && !pub.eligibleChancellors.includes(p.id)) tags.push('<span class="tag dim">Term-limited</span>');
      if (pub.phase === 'vote' && p.alive) tags.push(p.hasVoted ? '<span class="tag ok">Voted</span>' : '<span class="tag dim">Thinking…</span>');
      if (!p.alive) tags.push('<span class="tag dead">Executed</span>');
      if (!connected(p.id)) tags.push('<span class="tag warn">Offline</span>');
      const role = p.role || knownRole(p.id);
      const roleTag = role ? `<span class="role-chip ${role.replace('?', '')}">${role.endsWith('?') ? (role.startsWith('lib') ? 'Liberal (investigated)' : 'Fascist (investigated)') : ROLE_LABEL[role]}</span>` : '';
      const voteRes = pub.lastVote && pub.phase !== 'vote' && p.id in pub.lastVote.votes
        ? `<span class="last-vote ${pub.lastVote.votes[p.id] ? 'ja' : 'nein'}">${pub.lastVote.votes[p.id] ? 'Ja!' : 'Nein!'}</span>` : '';
      return `
        <li class="${p.alive ? '' : 'is-dead'} ${p.id === S.pid ? 'is-me' : ''}">
          <div class="p-top"><span class="pname">${esc(p.name)}${p.id === S.pid ? ' <span class="muted">(you)</span>' : ''}</span>${voteRes}</div>
          <div class="p-tags">${tags.join('')}${roleTag}</div>
        </li>`;
    }).join('');
    const lv = pub.lastVote;
    return `
      <section class="panel">
        <h2>Players</h2>
        ${lv && pub.phase !== 'vote' ? `<p class="small muted">Last vote: ${pname(pub, lv.presidentId)} / ${pname(pub, lv.chancellorId)} <b class="${lv.passed ? 'ok-text' : 'bad-text'}">${lv.passed ? 'passed' : 'failed'}</b> ${lv.ja}–${lv.nein}</p>` : ''}
        <ul class="players">${items}</ul>
      </section>`;
  }

  function logPanel(pub) {
    const items = pub.log.slice().reverse().map(l => `<li class="${l.kind}">${esc(l.text)}</li>`).join('');
    return `<section class="panel log"><h2>Game log</h2><ul>${items}</ul></section>`;
  }

  function renderGame() {
    const { pub, priv } = S.view;
    const me = pub.players.find(p => p.id === S.pid);
    const key = pub.phase + ':' + pub.round + ':' + (pub.vetoRejected ? 'r' : '');
    if (key !== S.selKey) { S.sel = null; S.selKey = key; }
    const isHost = S.role === 'host';
    return `
      <div class="game">
        <header class="game-head">
          <div><span class="muted small">Room</span> <b class="code">${esc(S.code)}</b></div>
          <div class="small">${me ? esc(me.name) : ''}${isHost ? ' <span class="tag gold">Host</span>' : ''}</div>
        </header>
        ${connBanner()}
        <div class="game-grid">
          <div class="col-main">
            ${actionPanel(pub, priv, me)}
            ${roleCard(pub, priv)}
            ${boards(pub)}
          </div>
          <div class="col-side">
            ${playersPanel(pub, priv)}
            ${logPanel(pub)}
            ${isHost && pub.phase !== 'gameover' ? `
              <button class="btn ghost small-btn ${S.confirmEnd ? 'danger' : ''}" data-act="end-game">${S.confirmEnd ? 'Tap again to end the game for everyone' : 'End game & return to lobby'}</button>` : ''}
            ${!isHost ? '<button class="btn ghost small-btn" data-act="leave">Leave game</button>' : ''}
          </div>
        </div>
      </div>`;
  }

  /* ---------------- "your turn" nudges ---------------- */

  let lastNeedKey = '';
  function needsMe() {
    if (!S.view) return false;
    const { pub, priv } = S.view;
    const me = pub.players.find(p => p.id === S.pid);
    if (!me || !me.alive) return false;
    const amPres = pub.presidentId === S.pid;
    switch (pub.phase) {
      case 'vote': return priv.myVote === undefined;
      case 'chancellor_legislate': return pub.chancellorId === S.pid;
      case 'nominate': case 'president_legislate': case 'veto_response': case 'power_peek':
      case 'power_investigate': case 'investigate_result': case 'power_special': case 'power_execute':
        return amPres;
      default: return false;
    }
  }
  function notifyTurn() {
    const need = needsMe();
    document.title = (need ? '● Your turn · ' : '') + 'Secret Hitler';
    const key = need ? S.view.pub.phase + S.view.pub.round : '';
    const activated = !navigator.userActivation || navigator.userActivation.hasBeenActive;
    if (need && key !== lastNeedKey && navigator.vibrate && activated) { try { navigator.vibrate(120); } catch (e) { /* ignore */ } }
    lastNeedKey = key;
  }

  /* ================= events ================= */

  function submitJoin() {
    const name = cleanName(document.getElementById('name').value);
    const codeEl = document.getElementById('code');
    const code = cleanCode(codeEl && codeEl.value);
    if (!name) return toast('Enter your name first.', 'bad');
    if (code.length !== 5) return toast('Room codes are 5 letters.', 'bad');
    ls.set('sh_name', name);
    joinRoom(code, name);
  }

  document.addEventListener('submit', e => {
    if (e.target.matches('[data-form="home"]')) { e.preventDefault(); submitJoin(); }
  });

  document.addEventListener('input', e => {
    if (e.target.id === 'code') e.target.value = cleanCode(e.target.value);
  });

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const a = el.dataset.act;
    if (a !== 'end-game' && S.confirmEnd) { S.confirmEnd = false; }

    switch (a) {
      case 'create': {
        const name = cleanName(document.getElementById('name').value);
        if (!name) return toast('Enter your name first.', 'bad');
        ls.set('sh_name', name);
        startHosting(name);
        break;
      }
      case 'join': e.preventDefault(); submitJoin(); break;
      case 'clear-invite': {
        const u = new URL(location.href);
        u.searchParams.delete('room');
        history.replaceState(null, '', u.toString());
        params.delete('room');
        S.screen = null;
        S.name = cleanName(document.getElementById('name').value) || S.name;
        render();
        break;
      }
      case 'leave': leaveToHome(); break;
      case 'copy-link': {
        const link = shareLink(S.code);
        (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
          .then(() => toast('Invite link copied.'))
          .catch(() => { const i = document.querySelector('.link'); i && i.select(); toast('Press Ctrl/Cmd+C to copy.'); });
        break;
      }
      case 'share-link':
        navigator.share({ title: 'Secret Hitler', text: 'Join my Secret Hitler game (code ' + S.code + ')', url: shareLink(S.code) }).catch(() => {});
        break;
      case 'kick': send({ t: 'kick', target: el.dataset.id }); break;
      case 'start': send({ t: 'start' }); break;
      case 'tolobby': send({ t: 'tolobby' }); break;
      case 'end-game':
        if (!S.confirmEnd) { S.confirmEnd = true; render(); setTimeout(() => { if (S.confirmEnd) { S.confirmEnd = false; render(); } }, 4000); return; }
        S.confirmEnd = false;
        send({ t: 'tolobby' });
        break;
      case 'toggle-role': S.roleShown = !S.roleShown; render(); break;
      case 'select': S.sel = el.dataset.id; render(); break;
      case 'pick-card': S.sel = Number(el.dataset.idx); render(); break;
      case 'confirm-target': if (S.sel) act({ type: el.dataset.type, target: S.sel }); break;
      case 'confirm-card':
        if (Number.isInteger(S.sel)) act({ type: el.dataset.type, index: S.sel });
        break;
      case 'vote': act({ type: 'vote', ja: el.dataset.ja === '1' }); break;
      case 'veto': act({ type: 'veto' }); break;
      case 'veto-yes': act({ type: 'veto_response', accept: true }); break;
      case 'veto-no': act({ type: 'veto_response', accept: false }); break;
      case 'ack': act({ type: 'ack' }); break;
    }
  });

  // Warn the host before closing the tab, since that ends the game for everyone.
  window.addEventListener('beforeunload', e => {
    if (S.role === 'host' && S.lobby && S.lobby.players.length > 1) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ================= boot ================= */

  (function boot() {
    const savedHost = ss.get('sh_host');
    const hostParam = cleanCode(params.get('host'));
    if (savedHost && savedHost.code && (!hostParam || hostParam === savedHost.code)) return resumeHosting(savedHost);
    const savedMember = ss.get('sh_member');
    const room = cleanCode(params.get('room'));
    if (savedMember && savedMember.code && (!room || room === savedMember.code)) {
      return joinRoom(savedMember.code, savedMember.name, savedMember.pid);
    }
    render();
  })();
})();
