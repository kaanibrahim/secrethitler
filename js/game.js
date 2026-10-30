/*
 * Secret Hitler rules engine.
 * Pure logic with no DOM or network code. The host runs this and sends each
 * player a filtered view (getView) so nobody receives information they
 * shouldn't have.
 */
(function (global) {
  'use strict';

  // [liberals, fascists (not counting Hitler)]
  const ROLE_COUNTS = { 5: [3, 1], 6: [4, 1], 7: [4, 2], 8: [5, 2], 9: [5, 3], 10: [6, 3] };

  // Presidential power granted when the Nth fascist policy (index N-1) is enacted.
  const POWER_TABLES = {
    small: [null, null, 'peek', 'execute', 'execute'],            // 5–6 players
    medium: [null, 'investigate', 'special', 'execute', 'execute'], // 7–8 players
    large: ['investigate', 'investigate', 'special', 'execute', 'execute'], // 9–10 players
  };

  const MIN_PLAYERS = 5;
  const MAX_PLAYERS = 10;

  function powerTable(n) {
    if (n <= 6) return POWER_TABLES.small;
    if (n <= 8) return POWER_TABLES.medium;
    return POWER_TABLES.large;
  }

  function shuffle(arr, rng) {
    rng = rng || Math.random;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function fail(msg) {
    const e = new Error(msg);
    e.userFacing = true;
    throw e;
  }

  function byId(s, id) { return s.players.find(p => p.id === id); }
  function idxOf(s, id) { return s.players.findIndex(p => p.id === id); }
  function nameOf(s, id) { const p = byId(s, id); return p ? p.name : '?'; }
  function president(s) { return s.players[s.presidentIdx]; }
  function alivePlayers(s) { return s.players.filter(p => p.alive); }
  function partyOf(role) { return role === 'liberal' ? 'liberal' : 'fascist'; }

  function log(s, text, kind) {
    s.log.push({ text, kind: kind || 'info', round: s.round });
    if (s.log.length > 250) s.log.splice(0, s.log.length - 250);
  }

  function nextAliveIdx(s, fromIdx) {
    const n = s.players.length;
    for (let k = 1; k <= n; k++) {
      const i = (fromIdx + k) % n;
      if (s.players[i].alive) return i;
    }
    return fromIdx;
  }

  // Reshuffle the discard pile into the deck when fewer than 3 cards remain.
  function ensureDeck(s) {
    if (s.deck.length < 3) {
      s.deck = shuffle(s.deck.concat(s.discard));
      s.discard = [];
      log(s, 'The draw pile ran low, so the discard pile was shuffled back in.', 'system');
    }
  }

  function eligibleChancellors(s) {
    const pres = president(s);
    const strict = alivePlayers(s).length > 5;
    return s.players
      .filter(p => p.alive && p.id !== pres.id && p.id !== s.lastChancellorId &&
        !(strict && p.id === s.lastPresidentId))
      .map(p => p.id);
  }

  function powerTargets(s) {
    const pres = president(s);
    const alive = s.players.filter(p => p.alive && p.id !== pres.id);
    if (s.phase === 'power_investigate') return alive.filter(p => !s.investigated.includes(p.id)).map(p => p.id);
    if (s.phase === 'power_special' || s.phase === 'power_execute') return alive.map(p => p.id);
    return [];
  }

  function createGame(players, rng) {
    const n = players.length;
    if (!ROLE_COUNTS[n]) fail(`Secret Hitler needs ${MIN_PLAYERS}–${MAX_PLAYERS} players.`);
    const [libs, fas] = ROLE_COUNTS[n];
    const roles = shuffle(['hitler'].concat(Array(fas).fill('fascist'), Array(libs).fill('liberal')), rng);
    const deck = shuffle(Array(6).fill('L').concat(Array(11).fill('F')), rng);
    const s = {
      n,
      players: players.map((p, i) => ({ id: p.id, name: p.name, role: roles[i], alive: true })),
      phase: 'nominate',
      round: 1,
      presidentIdx: Math.floor((rng || Math.random)() * n),
      specialReturnIdx: null,
      nomineeId: null,
      chancellorId: null,
      lastPresidentId: null,
      lastChancellorId: null,
      votes: {},
      lastVote: null,
      deck,
      discard: [],
      hand: [],
      liberal: 0,
      fascist: 0,
      tracker: 0,
      vetoRejected: false,
      investigated: [],
      investigations: {},
      lastInvestigation: null,
      lastEnacted: null,
      winner: null,
      winReason: null,
      log: [],
    };
    log(s, `The game has begun with ${n} players. ${president(s).name} is the first presidential candidate.`, 'system');
    return s;
  }

  function endGame(s, winner, reason) {
    s.phase = 'gameover';
    s.winner = winner;
    s.winReason = reason;
    s.hand = [];
    log(s, `${winner === 'liberal' ? 'Liberals' : 'Fascists'} win! ${reason}`, winner);
  }

  function nextNomination(s, advance) {
    s.nomineeId = null;
    s.chancellorId = null;
    s.votes = {};
    s.hand = [];
    s.vetoRejected = false;
    ensureDeck(s);
    if (advance !== false) {
      if (s.specialReturnIdx !== null) {
        s.presidentIdx = nextAliveIdx(s, s.specialReturnIdx);
        s.specialReturnIdx = null;
      } else {
        s.presidentIdx = nextAliveIdx(s, s.presidentIdx);
      }
    }
    s.round++;
    s.phase = 'nominate';
    log(s, `${president(s).name} is the presidential candidate.`, 'system');
  }

  function enactPolicy(s, card, chaos) {
    s.lastEnacted = card;
    if (card === 'L') s.liberal++; else s.fascist++;
    log(s, `A ${card === 'L' ? 'Liberal' : 'Fascist'} policy was enacted${chaos ? ' by the frustrated populace' : ''}.`,
      card === 'L' ? 'liberal' : 'fascist');
    if (s.liberal >= 5) return endGame(s, 'liberal', 'Five Liberal policies were enacted.');
    if (s.fascist >= 6) return endGame(s, 'fascist', 'Six Fascist policies were enacted.');
    if (s.fascist === 5 && card === 'F') log(s, 'Veto power is now unlocked.', 'system');

    if (card === 'F' && !chaos) {
      const power = powerTable(s.n)[s.fascist - 1];
      if (power) {
        const pres = president(s).name;
        if (power === 'peek') {
          ensureDeck(s);
          s.phase = 'power_peek';
          log(s, `Presidential power: ${pres} examines the top three policies.`, 'power');
          return;
        }
        s.phase = 'power_' + power;
        if (powerTargets(s).length === 0) return nextNomination(s);
        const label = { investigate: 'investigate a player\'s loyalty', special: 'call a special election', execute: 'execute a player' }[power];
        log(s, `Presidential power: ${pres} must ${label}.`, 'power');
        return;
      }
    }
    nextNomination(s);
  }

  function chaos(s) {
    ensureDeck(s);
    const card = s.deck.shift();
    s.tracker = 0;
    s.lastPresidentId = null;
    s.lastChancellorId = null;
    log(s, 'Three governments failed in a row. The country is thrown into chaos and the top policy is enacted. Term limits are reset.', 'system');
    enactPolicy(s, card, true);
  }

  function advanceTracker(s) {
    s.tracker++;
    if (s.tracker >= 3) return chaos(s);
    nextNomination(s);
  }

  function resolveVote(s) {
    const alive = alivePlayers(s);
    const ja = alive.filter(p => s.votes[p.id]).length;
    const nein = alive.length - ja;
    const passed = ja > nein;
    const presId = president(s).id;
    s.lastVote = { round: s.round, presidentId: presId, chancellorId: s.nomineeId, votes: Object.assign({}, s.votes), ja, nein, passed };
    log(s, `The vote ${passed ? 'passed' : 'failed'} (${ja} Ja! / ${nein} Nein!).`, passed ? 'good' : 'bad');

    if (!passed) {
      s.nomineeId = null;
      return advanceTracker(s);
    }

    s.chancellorId = s.nomineeId;
    s.nomineeId = null;
    s.lastPresidentId = presId;
    s.lastChancellorId = s.chancellorId;
    s.tracker = 0;
    log(s, `${nameOf(s, presId)} and ${nameOf(s, s.chancellorId)} form a government.`, 'info');

    const chancellor = byId(s, s.chancellorId);
    if (s.fascist >= 3 && chancellor.role === 'hitler') {
      return endGame(s, 'fascist', `Hitler (${chancellor.name}) was elected Chancellor after three Fascist policies.`);
    }
    if (s.fascist >= 3) log(s, `${chancellor.name} is not Hitler.`, 'system');

    ensureDeck(s);
    s.hand = s.deck.splice(0, 3);
    s.phase = 'president_legislate';
  }

  function validIndex(i, len) {
    return Number.isInteger(i) && i >= 0 && i < len;
  }

  function applyAction(s, pid, a) {
    if (!a || typeof a.type !== 'string') fail('Invalid action.');
    if (s.phase === 'gameover') fail('The game is over.');
    const me = byId(s, pid);
    if (!me) fail('You are not in this game.');
    if (!me.alive) fail('Executed players cannot act.');
    const isPres = president(s).id === pid;
    const requirePres = () => { if (!isPres) fail('Only the President can do that.'); };

    switch (s.phase) {
      case 'nominate': {
        requirePres();
        if (a.type !== 'nominate') fail('Nominate a Chancellor.');
        if (!eligibleChancellors(s).includes(a.target)) fail('That player is not eligible to be Chancellor.');
        s.nomineeId = a.target;
        s.votes = {};
        s.phase = 'vote';
        log(s, `${me.name} nominated ${nameOf(s, a.target)} for Chancellor.`, 'info');
        return;
      }
      case 'vote': {
        if (a.type !== 'vote') fail('Cast your vote.');
        s.votes[pid] = !!a.ja;
        if (alivePlayers(s).every(p => p.id in s.votes)) resolveVote(s);
        return;
      }
      case 'president_legislate': {
        requirePres();
        if (a.type !== 'discard' || !validIndex(a.index, s.hand.length)) fail('Choose a policy to discard.');
        s.discard.push(s.hand.splice(a.index, 1)[0]);
        s.phase = 'chancellor_legislate';
        log(s, `${me.name} passed two policies to the Chancellor.`, 'info');
        return;
      }
      case 'chancellor_legislate': {
        if (pid !== s.chancellorId) fail('Only the Chancellor can do that.');
        if (a.type === 'veto') {
          if (s.fascist < 5) fail('Veto power is not unlocked yet.');
          if (s.vetoRejected) fail('The President already refused a veto this session.');
          s.phase = 'veto_response';
          log(s, `${me.name} proposes to veto this agenda.`, 'power');
          return;
        }
        if (a.type !== 'enact' || !validIndex(a.index, s.hand.length)) fail('Choose a policy to enact.');
        const card = s.hand.splice(a.index, 1)[0];
        s.discard.push(...s.hand);
        s.hand = [];
        return enactPolicy(s, card, false);
      }
      case 'veto_response': {
        requirePres();
        if (a.type !== 'veto_response') fail('Accept or reject the veto.');
        if (a.accept) {
          s.discard.push(...s.hand);
          s.hand = [];
          log(s, `${me.name} agreed to the veto. Both policies were discarded.`, 'power');
          return advanceTracker(s);
        }
        s.vetoRejected = true;
        s.phase = 'chancellor_legislate';
        log(s, `${me.name} refused the veto. The Chancellor must enact a policy.`, 'power');
        return;
      }
      case 'power_peek': {
        requirePres();
        if (a.type !== 'ack') fail('Finish examining the policies.');
        return nextNomination(s);
      }
      case 'power_investigate': {
        requirePres();
        if (a.type !== 'investigate' || !powerTargets(s).includes(a.target)) fail('Choose a valid player to investigate.');
        const target = byId(s, a.target);
        s.investigated.push(target.id);
        const result = { targetId: target.id, party: partyOf(target.role) };
        (s.investigations[pid] = s.investigations[pid] || []).push(result);
        s.lastInvestigation = result;
        s.phase = 'investigate_result';
        log(s, `${me.name} investigated ${target.name}'s party membership.`, 'power');
        return;
      }
      case 'investigate_result': {
        requirePres();
        if (a.type !== 'ack') fail('Finish reviewing the investigation.');
        s.lastInvestigation = null;
        return nextNomination(s);
      }
      case 'power_special': {
        requirePres();
        if (a.type !== 'special' || !powerTargets(s).includes(a.target)) fail('Choose a valid player.');
        s.specialReturnIdx = s.presidentIdx;
        s.presidentIdx = idxOf(s, a.target);
        log(s, `${me.name} called a special election. ${nameOf(s, a.target)} will be the next presidential candidate.`, 'power');
        return nextNomination(s, false);
      }
      case 'power_execute': {
        requirePres();
        if (a.type !== 'execute' || !powerTargets(s).includes(a.target)) fail('Choose a valid player.');
        const target = byId(s, a.target);
        target.alive = false;
        log(s, `${me.name} executed ${target.name}.`, 'bad');
        if (target.role === 'hitler') return endGame(s, 'liberal', `Hitler (${target.name}) was executed.`);
        return nextNomination(s);
      }
      default:
        fail('Unknown game phase.');
    }
  }

  // Everything a specific player is allowed to see.
  function getView(s, pid) {
    const pres = president(s);
    const over = s.phase === 'gameover';
    const pub = {
      phase: s.phase,
      round: s.round,
      n: s.n,
      players: s.players.map(p => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        role: over ? p.role : null,
        hasVoted: s.phase === 'vote' ? (p.id in s.votes) : false,
      })),
      presidentId: pres.id,
      nomineeId: s.nomineeId,
      chancellorId: s.chancellorId,
      lastPresidentId: s.lastPresidentId,
      lastChancellorId: s.lastChancellorId,
      eligibleChancellors: s.phase === 'nominate' ? eligibleChancellors(s) : [],
      targets: powerTargets(s),
      liberal: s.liberal,
      fascist: s.fascist,
      tracker: s.tracker,
      deckCount: s.deck.length,
      discardCount: s.discard.length,
      lastVote: s.lastVote,
      lastEnacted: s.lastEnacted,
      vetoUnlocked: s.fascist >= 5,
      vetoRejected: s.vetoRejected,
      powers: powerTable(s.n),
      investigated: s.investigated.slice(),
      termLimitPresident: alivePlayers(s).length > 5,
      winner: s.winner,
      winReason: s.winReason,
      log: s.log.slice(-80),
    };

    const me = byId(s, pid);
    let priv = null;
    if (me) {
      priv = { role: me.role, party: partyOf(me.role), known: [], investigations: s.investigations[pid] || [] };
      const seesTeam = me.role === 'fascist' || (me.role === 'hitler' && s.n <= 6);
      if (seesTeam) {
        priv.known = s.players
          .filter(p => p.id !== pid && p.role !== 'liberal')
          .map(p => ({ id: p.id, role: p.role }));
      }
      if (s.phase === 'vote' && pid in s.votes) priv.myVote = s.votes[pid];
      const amPres = pres.id === pid;
      if ((s.phase === 'president_legislate' || s.phase === 'veto_response') && amPres) priv.hand = s.hand.slice();
      if (s.phase === 'chancellor_legislate' && s.chancellorId === pid) priv.hand = s.hand.slice();
      if (s.phase === 'power_peek' && amPres) priv.peek = s.deck.slice(0, 3);
      if (s.phase === 'investigate_result' && amPres) priv.investigationResult = s.lastInvestigation;
    }
    return { pub, priv };
  }

  const api = { createGame, applyAction, getView, powerTable, MIN_PLAYERS, MAX_PLAYERS, ROLE_COUNTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.SHGame = api;
})(typeof window !== 'undefined' ? window : globalThis);
