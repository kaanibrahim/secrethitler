/*
 * Networking layer.
 *
 * GitHub Pages only serves static files, so there is no game server. Instead the
 * host's browser acts as the server and every other player connects to it
 * directly over WebRTC using PeerJS. PeerJS's free public broker is only used to
 * introduce the browsers to each other; game traffic flows peer to peer.
 *
 * Add ?local=1 to the URL to use a BroadcastChannel transport instead, which lets
 * you play with several tabs of the same browser with no network at all (handy for
 * testing).
 */
(function (global) {
  'use strict';

  // Change this if you fork the project, so your rooms never collide with anyone else's.
  const PEER_PREFIX = 'shweb-x7q2-';

  // STUN/TURN servers. Google's STUN works for most home networks. Some strict
  // networks (certain mobile carriers, corporate Wi-Fi) also need a TURN relay;
  // add one here if players report they can't connect.
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // { urls: 'turn:YOUR_TURN_SERVER:3478', username: 'user', credential: 'pass' },
  ];

  const LOCAL = new URLSearchParams(location.search).has('local');

  function randId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  /* ---------------- PeerJS (real multiplayer) ---------------- */

  function peerOptions() {
    return { debug: 1, config: { iceServers: ICE_SERVERS } };
  }

  function peerHost(code, h) {
    if (typeof Peer === 'undefined') { h.onError('Could not load the networking library.'); return null; }
    const conns = new Map();
    let peer, destroyed = false, attempts = 0;

    function open() {
      peer = new Peer(PEER_PREFIX + code, peerOptions());
      peer.on('open', () => { attempts = 0; h.onReady(); });
      peer.on('connection', conn => {
        const cid = randId();
        conn.on('open', () => conns.set(cid, conn));
        conn.on('data', data => h.onMessage(cid, data));
        const closed = () => { if (conns.delete(cid)) h.onClose(cid); };
        conn.on('close', closed);
        conn.on('error', closed);
      });
      peer.on('disconnected', () => { if (!destroyed) setTimeout(() => !destroyed && !peer.destroyed && peer.reconnect(), 1500); });
      peer.on('error', err => {
        if (err.type === 'unavailable-id') {
          // The ID can stay reserved for a few seconds after a page reload.
          peer.destroy();
          if (++attempts <= 12) { h.onStatus && h.onStatus('Reclaiming room ' + code + '…'); setTimeout(open, 2500); }
          else h.onError('That room code is already in use.', 'taken');
        } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
          h.onStatus && h.onStatus('Connection to matchmaking server lost. Retrying…');
        } else if (err.type !== 'peer-unavailable') {
          console.warn('Peer error', err.type, err);
        }
      });
    }
    open();

    return {
      send(cid, msg) { const c = conns.get(cid); if (c && c.open) c.send(msg); },
      drop(cid) { const c = conns.get(cid); conns.delete(cid); if (c) setTimeout(() => c.close(), 300); },
      close() { destroyed = true; peer && peer.destroy(); },
    };
  }

  function peerJoin(code, h) {
    if (typeof Peer === 'undefined') { h.onError('Could not load the networking library.'); return null; }
    let peer = null, conn = null, closed = false, opened = false;

    peer = new Peer(peerOptions());
    peer.on('open', () => {
      conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      const timer = setTimeout(() => { if (!opened) { h.onError('Could not reach the host. Check the code and try again.', 'unreachable'); } }, 15000);
      conn.on('open', () => { opened = true; clearTimeout(timer); h.onOpen(); });
      conn.on('data', d => h.onMessage(d));
      conn.on('close', () => { if (!closed) h.onClose(); });
      conn.on('error', () => { if (!closed) h.onClose(); });
    });
    peer.on('error', err => {
      if (err.type === 'peer-unavailable') h.onError('No game found with code ' + code + '.', 'notfound');
      else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') h.onError('Network problem. Retrying…', 'network');
      else console.warn('Peer error', err.type, err);
    });

    return {
      send(msg) { if (conn && conn.open) conn.send(msg); },
      close() { closed = true; try { conn && conn.close(); } catch (e) { /* ignore */ } peer && peer.destroy(); },
    };
  }

  /* ------------- BroadcastChannel (same-browser testing) ------------- */

  function localHost(code, h) {
    const ch = new BroadcastChannel('sh-local-' + code);
    const conns = new Set();
    ch.onmessage = e => {
      const m = e.data;
      if (m.to !== 'host') return;
      if (m.kind === 'connect') { conns.add(m.from); ch.postMessage({ to: m.from, kind: 'accept' }); }
      else if (m.kind === 'data' && conns.has(m.from)) h.onMessage(m.from, m.data);
      else if (m.kind === 'data') ch.postMessage({ to: m.from, kind: 'close' }); // unknown sender: make it reconnect
      else if (m.kind === 'close' && conns.delete(m.from)) h.onClose(m.from);
    };
    addEventListener('pagehide', () => conns.forEach(cid => ch.postMessage({ to: cid, kind: 'close' })));
    setTimeout(() => h.onReady(), 0);
    return {
      send(cid, msg) { if (conns.has(cid)) ch.postMessage({ to: cid, kind: 'data', data: msg }); },
      drop(cid) { conns.delete(cid); ch.postMessage({ to: cid, kind: 'close' }); },
      close() { ch.close(); },
    };
  }

  function localJoin(code, h) {
    const ch = new BroadcastChannel('sh-local-' + code);
    const me = randId();
    let opened = false, closed = false;
    ch.onmessage = e => {
      const m = e.data;
      if (m.to !== me) return;
      if (m.kind === 'accept' && !opened) { opened = true; h.onOpen(); }
      else if (m.kind === 'data') h.onMessage(m.data);
      else if (m.kind === 'close' && !closed) h.onClose();
    };
    ch.postMessage({ to: 'host', from: me, kind: 'connect' });
    setTimeout(() => { if (!opened && !closed) h.onError('No game found with code ' + code + '.', 'notfound'); }, 3000);
    const bye = () => ch.postMessage({ to: 'host', from: me, kind: 'close' });
    addEventListener('pagehide', bye);
    return {
      send(msg) { ch.postMessage({ to: 'host', from: me, kind: 'data', data: msg }); },
      close() { closed = true; bye(); removeEventListener('pagehide', bye); ch.close(); },
    };
  }

  global.SHNet = {
    LOCAL,
    host: LOCAL ? localHost : peerHost,
    join: LOCAL ? localJoin : peerJoin,
  };
})(window);
