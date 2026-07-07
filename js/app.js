/* betsson·bindus — sportsbook.
   Allt innehåll renderas från data/matches.json + data/bets.json.
   Saldo och lagda spel är fiktiva och bor i localStorage. */

const LS = {
  balance: 'bb-balance',
  placed: 'bb-placed',
  seenOdds: 'bb-odds-seen',
};
const START_BALANCE = 5000;
const LIVE_WINDOW_MIN = 150; // ~matchlängd inkl. paus: spelstopp-fönster efter avspark

const FLAGS = {
  SUI: '🇨🇭', COL: '🇨🇴', FRA: '🇫🇷', MAR: '🇲🇦', ESP: '🇪🇸',
  BEL: '🇧🇪', NOR: '🇳🇴', ENG: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', ARG: '🇦🇷',
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = window.matchMedia('(pointer: fine)');

/* ---------- Format ---------- */
const krFmt = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 });
const krFmtExact = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtKr = (n) => (Number.isInteger(Math.round(n * 100) / 100) || Math.abs(n % 1) < 0.005
  ? krFmt.format(Math.round(n))
  : krFmtExact.format(n)) + ' kr';
const fmtOdds = (n) => n.toFixed(2);
const dayFmt = new Intl.DateTimeFormat('sv-SE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Stockholm' });
const shortDayFmt = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', timeZone: 'Europe/Stockholm' });
const timeFmt = new Intl.DateTimeFormat('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' });
const longDateFmt = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Stockholm' });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtDay = (d) => cap(dayFmt.format(d)).replace('.', '');
const fmtKickoff = (m) => {
  const d = new Date(m.kickoff);
  return m.timeTbd ? `${fmtDay(d)} · tid ej fastställd` : `${fmtDay(d)} · ${timeFmt.format(d)}`;
};

/* ---------- El-hjälpare ---------- */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const $ = (id) => document.getElementById(id);

/* ---------- Count-up (rAF, ease-out-expo) ---------- */
const countTimers = new WeakMap();
function animateCount(node, to, { formatter = fmtKr, ms = 450 } = {}) {
  const from = Number(node.dataset.countVal ?? NaN);
  node.dataset.countVal = String(to);
  if (reducedMotion.matches || !Number.isFinite(from) || from === to) {
    node.textContent = formatter(to);
    return;
  }
  cancelAnimationFrame(countTimers.get(node));
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / ms);
    const eased = 1 - Math.pow(2, -10 * p);
    node.textContent = formatter(from + (to - from) * (p >= 1 ? 1 : eased));
    if (p < 1) countTimers.set(node, requestAnimationFrame(step));
  };
  countTimers.set(node, requestAnimationFrame(step));
}

/* ---------- Odometer-flip ---------- */
function flipTo(valueEl, newText, up) {
  if (reducedMotion.matches) { valueEl.textContent = newText; return; }
  const oldText = valueEl.textContent;
  if (oldText === newText) return;
  const dir = up ? 'roll-up' : 'roll-down';
  valueEl.classList.add('odds-flip');
  valueEl.innerHTML = '';
  valueEl.append(
    el('span', { class: `ov ov-old ${dir}`, text: oldText }),
    el('span', { class: `ov ov-new ${dir}`, text: newText }),
  );
  setTimeout(() => {
    valueEl.classList.remove('odds-flip');
    valueEl.textContent = newText;
  }, 450);
}

/* ---------- Scroll-reveal ---------- */
const revealObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          revealObserver.unobserve(e.target);
        }
      }
    }, { threshold: 0.15, rootMargin: '0px 0px -12% 0px' })
  : null;

function revealify(nodes) {
  if (reducedMotion.matches || !revealObserver) {
    nodes.forEach((n) => n.classList.add('in'));
    return;
  }
  nodes.forEach((n, i) => {
    n.classList.add('reveal');
    n.style.setProperty('--ri', String(Math.min(i, 8)));
    revealObserver.observe(n);
  });
}

/* ---------- State ---------- */
const state = {
  matchesData: null,
  betsData: null,
  selections: new Map(),   // selId -> {selId, matchId, matchLabel, marketName, pickName}
  mode: 'single',
  currentOdds: new Map(),  // selId -> aktuellt odds
  baseOdds: new Map(),     // selId -> odds enligt datafilen (drift-ankare)
  selMeta: new Map(),      // selId -> {matchId, matchLabel, marketName, pickName, bettable}
  balance: START_BALANCE,
  arrowTimers: new Map(),
  startedSeen: new Set(),
  sheetOpener: null,
};

function loadBalance() {
  const raw = localStorage.getItem(LS.balance);
  const n = raw == null ? NaN : Number(raw);
  state.balance = Number.isFinite(n) && n >= 0 ? n : START_BALANCE;
}
function saveBalance() { localStorage.setItem(LS.balance, String(state.balance)); }
function renderBalance() {
  animateCount($('balance-value'), state.balance);
}

/* ---------- Skeletons (måtten speglar riktiga kort → ingen layout-shift) ---------- */
function renderSkeletons() {
  const list = $('match-list');
  list.innerHTML = '';
  for (let i = 0; i < 3; i++) list.append(el('div', { class: 'skeleton skeleton-card', 'aria-hidden': 'true' }));
  const lb = $('leaderboard');
  lb.innerHTML = '';
  lb.append(el('div', { class: 'skeleton skeleton-leaderboard', 'aria-hidden': 'true' }));
}

/* ---------- Init ---------- */
async function init() {
  loadBalance();
  $('balance-value').textContent = fmtKr(state.balance);
  $('balance-value').dataset.countVal = String(state.balance);
  renderSkeletons();

  try {
    const [matchesRes, betsRes] = await Promise.all([
      fetch('data/matches.json'), fetch('data/bets.json'),
    ]);
    if (!matchesRes.ok || !betsRes.ok) throw new Error('http');
    state.matchesData = await matchesRes.json();
    state.betsData = await betsRes.json();
  } catch {
    $('match-list').innerHTML = '';
    $('match-list').append(el('p', { class: 'match-note', text: 'Odds kunde inte laddas just nu. Ladda om sidan, eller kontrollera att data/matches.json finns.' }));
    $('leaderboard').innerHTML = '';
    $('leaderboard').append(el('p', { class: 'match-note', text: 'Ställningen kunde inte laddas.' }));
    return;
  }

  indexSelections();
  renderHero();
  renderBracket();
  renderMatches();
  renderUpcoming();
  renderOutrightBlocks();
  renderLeaderboard();
  renderFooterMeta();
  renderSlip();
  initSlipUI();
  initSheet();
  initMagneticPress();
  startCountdown();
  flashFileChanges();
  startDrift();
}

function matchLabel(m) {
  return `${m.home.name} – ${m.away.name}`;
}
function venueLine(m) {
  const cityWord = (m.city || '').split(/[ /]/)[0].toLowerCase();
  if (cityWord && m.venue.toLowerCase().includes(cityWord)) return m.venue;
  return m.city ? `${m.venue}, ${m.city}` : m.venue;
}
function matchStarted(m) {
  return !m.timeTbd && Date.now() >= new Date(m.kickoff).getTime();
}
function matchLiveNow(m) {
  if (m.status !== 'open' || m.timeTbd) return false;
  const ko = new Date(m.kickoff).getTime();
  return Date.now() >= ko && Date.now() < ko + LIVE_WINDOW_MIN * 60000;
}
function matchBettable(m) {
  return m.status === 'open' && !matchStarted(m);
}

function indexSelections() {
  for (const m of state.matchesData.matches) {
    if (matchStarted(m)) state.startedSeen.add(m.id);
    const bettable = matchBettable(m);
    for (const mk of m.markets || []) {
      for (const s of mk.selections) {
        state.currentOdds.set(s.id, s.odds);
        state.baseOdds.set(s.id, s.odds);
        state.selMeta.set(s.id, {
          selId: s.id, matchId: m.id, matchLabel: matchLabel(m),
          marketName: mk.name, pickName: s.name, bettable,
        });
      }
    }
  }
  for (const o of state.matchesData.outrights || []) {
    for (const s of o.selections) {
      state.currentOdds.set(s.id, s.odds);
      state.baseOdds.set(s.id, s.odds);
      state.selMeta.set(s.id, {
        selId: s.id, matchId: o.id, matchLabel: 'VM 2026',
        marketName: o.name, pickName: s.name, bettable: true,
      });
    }
  }
}

/* Spelstopp-vakt: när en öppen match passerar avspark medan sidan är öppen
   låses dess odds, valen lyfts ur kupongen och kortet re-renderas. */
function checkStartedTransitions() {
  let changed = false;
  for (const m of state.matchesData.matches) {
    if (m.status !== 'open' || state.startedSeen.has(m.id) || !matchStarted(m)) continue;
    state.startedSeen.add(m.id);
    changed = true;
    let removed = false;
    for (const meta of state.selMeta.values()) {
      if (meta.matchId === m.id) {
        meta.bettable = false;
        if (state.selections.delete(meta.selId)) removed = true;
      }
    }
    if (removed) showToast(`Spelstopp — ${matchLabel(m)} har startat. Valet togs bort ur kupongen.`);
  }
  if (changed) {
    renderMatches();
    syncButtons();
    renderSlip();
  }
}

/* ---------- Hero ---------- */
function renderHero() {
  const comp = state.matchesData.meta.competition;
  $('hero-eyebrow-text').textContent = `${comp.name} · ${comp.phase}`;

  const chips = $('hero-chips');
  chips.innerHTML = '';
  const qfs = state.matchesData.matches.filter((m) => m.stage === 'Kvartsfinal');
  for (const m of qfs) {
    const codes = `${m.home.code || '?'}–${m.away.code || (m.away.tbd ? 'TBD' : '?')}`;
    const li = el('li', { class: 'hero-chip' },
      el('button', {
        type: 'button',
        'aria-label': `Gå till ${matchLabel(m)}`,
        onclick: () => {
          const card = document.querySelector(`[data-match="${m.id}"]`);
          if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        },
      },
        el('span', { text: codes }),
        el('span', { class: 'chip-time tnum', text: fmtKickoff(m) }),
      ));
    chips.append(li);
  }

  const final = state.matchesData.matches.find((m) => m.stage === 'Final');
  if (final) {
    const d = new Date(final.kickoff);
    $('hero-final-teaser').textContent = `Final · ${fmtDay(d)} · ${final.venue}, ${final.city}`;
  }
}

/* ---------- Slutspelsträd ---------- */
function bracketTeamRow(team) {
  if (team.tbd) {
    return el('span', { class: 'bracket-team tbd' },
      el('span', { class: 'bracket-flag', 'aria-hidden': 'true', text: '·' }),
      el('span', { text: '–' }));
  }
  return el('span', { class: 'bracket-team' },
    el('span', { class: 'bracket-flag', 'aria-hidden': 'true', text: FLAGS[team.code] || team.code || '?' }),
    el('span', { text: team.name }));
}

function renderBracket() {
  const wrap = $('bracket');
  wrap.innerHTML = '';
  const byStage = (stage) => state.matchesData.matches.filter((m) => m.stage === stage);
  const cols = [
    ['Kvartsfinaler', byStage('Kvartsfinal')],
    ['Semifinaler', byStage('Semifinal')],
    ['Final', byStage('Final')],
  ];
  const label = [];
  for (const [title, matches] of cols) {
    if (!matches.length) continue;
    const col = el('div', { class: 'bracket-col' }, el('span', { class: 'bracket-col-label', text: title }));
    for (const m of matches) {
      const node = el('div', {
        class: `bracket-node${m.home.tbd && m.away.tbd ? ' tbd' : ''}${m.stage === 'Final' ? ' final-node' : ''}`,
      },
        bracketTeamRow(m.home),
        bracketTeamRow(m.away),
        el('span', { class: 'bracket-meta tnum', text: m.timeTbd ? cap(shortDayFmt.format(new Date(m.kickoff))).replace('.', '') : `${cap(shortDayFmt.format(new Date(m.kickoff))).replace('.', '')} ${timeFmt.format(new Date(m.kickoff))}` }),
      );
      col.append(node);
      label.push(`${m.stage}: ${matchLabel(m)}`);
    }
    wrap.append(col);
  }
  wrap.setAttribute('aria-label', `Slutspelsträdet: ${label.join('; ')}`);
}

/* ---------- Countdown ---------- */
function countdownTarget() {
  const candidates = state.matchesData.matches
    .filter((m) => (m.status === 'open' || m.status === 'awaiting') && !m.timeTbd)
    .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  const live = candidates.find(matchLiveNow);
  if (live) return { m: live, live: true };
  const next = candidates.find((m) => new Date(m.kickoff).getTime() > Date.now());
  return next ? { m: next, live: false } : null;
}

function startCountdown() {
  const cd = $('countdown');
  let liveEl = cd.querySelector('.cd-live-text');
  if (!liveEl) {
    liveEl = el('span', { class: 'cd-live-text' },
      el('span', { class: 'live-dot', 'aria-hidden': 'true' }), el('span', { text: 'Spelas nu' }));
    cd.append(liveEl);
  }
  const tick = () => {
    checkStartedTransitions();
    const t = countdownTarget();
    if (!t) {
      $('countdown-label').textContent = 'Slutspelet rullar vidare';
      cd.classList.add('is-live');
      liveEl.lastChild.textContent = 'Nya matcher publiceras löpande';
      return;
    }
    if (t.live) {
      $('countdown-label').textContent = `${t.m.stage} · pågår just nu`;
      liveEl.lastChild.textContent = matchLabel(t.m);
      cd.classList.add('is-live');
      return;
    }
    cd.classList.remove('is-live');
    $('countdown-label').textContent = `Härnäst: ${matchLabel(t.m)} · ${t.m.stage}`;
    const ms = new Date(t.m.kickoff).getTime() - Date.now();
    const h = Math.floor(ms / 3600000);
    const mi = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    $('cd-h').textContent = String(h).padStart(2, '0');
    $('cd-m').textContent = String(mi).padStart(2, '0');
    $('cd-s').textContent = String(s).padStart(2, '0');
  };
  tick();
  setInterval(tick, 1000);
}

/* ---------- Matchkort ---------- */
function teamFlagEl(team) {
  if (team.tbd) return el('span', { class: 'team-flag tbd', 'aria-hidden': 'true', text: '?' });
  const flag = FLAGS[team.code];
  return el('span', { class: 'team-flag', 'aria-hidden': 'true', text: flag || (team.code || '?') });
}

function oddsButton(m, mk, s, labelText) {
  const meta = state.selMeta.get(s.id);
  const btn = el('button', {
    type: 'button',
    class: 'odds-btn',
    'data-sel': s.id,
    'aria-pressed': 'false',
    'aria-label': `${meta.marketName}: ${s.name}, odds ${fmtOdds(state.currentOdds.get(s.id))}`,
    onclick: () => toggleSelection(s.id),
  },
    el('span', { class: 'odds-label', text: labelText }),
    el('span', { class: 'odds-value-wrap' },
      el('span', { class: 'odds-value tnum', text: fmtOdds(state.currentOdds.get(s.id)) }),
      el('span', { class: 'odds-arrow', 'aria-hidden': 'true' }),
    ),
  );
  // Rörelse sedan öppning (statisk indikator från datafilen)
  if (typeof s.openingOdds === 'number' && Math.abs(s.openingOdds - s.odds) >= 0.01) {
    const arrow = btn.querySelector('.odds-arrow');
    const up = s.odds > s.openingOdds;
    arrow.textContent = up ? '▲' : '▼';
    arrow.classList.add(up ? 'show-up' : 'show-down');
    scheduleArrowHide(s.id, arrow, 6000);
  }
  return btn;
}

function marketBlock(m, mk) {
  const wrap = el('div', { class: 'market-block' });
  const label = el('div', { class: 'market-label' },
    el('span', { text: mk.name }),
    mk.note ? el('span', { class: 'market-note', text: mk.note }) : null);
  const row = el('div', { class: `odds-row${mk.selections.length === 2 ? ' cols-2' : ''}` });
  for (const s of mk.selections) {
    row.append(oddsButton(m, mk, s, s.label));
  }
  wrap.append(label, row);
  return wrap;
}

function renderMatches() {
  const list = $('match-list');
  list.innerHTML = '';
  const cards = state.matchesData.matches.filter((m) => m.status !== 'scheduled');

  for (const m of cards) {
    const card = el('article', { class: 'match-card', 'data-match': m.id });
    const live = matchLiveNow(m);
    const started = matchStarted(m);

    const meta = el('div', { class: 'match-meta' });
    meta.append(el('span', { text: m.stage }));
    meta.append(el('span', { class: 'meta-sep', 'aria-hidden': 'true', text: '·' }));
    if (m.status === 'finished') {
      meta.append(el('span', { text: 'Slut' }));
    } else if (live) {
      meta.append(el('span', { class: 'match-live-tag' },
        el('span', { class: 'live-dot', 'aria-hidden': 'true' }),
        el('span', { text: 'Pågår' })));
    } else if (started && m.status === 'open') {
      meta.append(el('span', { text: 'Väntar på resultat' }));
    } else {
      meta.append(el('span', { class: 'tnum', text: fmtKickoff(m) }));
    }
    meta.append(el('span', { class: 'meta-sep', 'aria-hidden': 'true', text: '·' }));
    meta.append(el('span', { text: venueLine(m) }));

    const teams = el('div', { class: 'match-teams' });
    for (const [team, scoreKey] of [[m.home, 'homeScore'], [m.away, 'awayScore']]) {
      const row = el('div', { class: 'team-row' },
        teamFlagEl(team),
        el('span', { class: `team-name${team.tbd ? ' tbd' : ''}`, text: team.name }));
      if (m.status === 'finished' && m.result) {
        row.append(el('span', { class: 'team-score tnum', text: String(m.result[scoreKey]) }));
      }
      teams.append(row);
    }

    card.append(meta, teams);

    if (m.status === 'awaiting') {
      card.append(el('p', { class: 'match-note', text: m.statusNote || 'Odds kommer.' }));
    } else if (m.status === 'finished') {
      card.classList.add('finished');
    } else if (started) {
      // Spelstopp: matchen har startat — visa inget bettbart
      card.append(el('p', { class: 'match-note', text: live ? 'Spelstopp — matchen pågår.' : 'Spelstopp. Uppdatera data/matches.json med resultatet när matchen är klar.' }));
    } else {
      const markets = m.markets || [];
      if (markets.length > 0) card.append(marketBlock(m, markets[0]));
      if (markets.length > 1) {
        const moreWrap = el('div', { class: 'more-markets', id: `more-${m.id}` }, el('div'));
        const inner = moreWrap.firstChild;
        for (const mk of markets.slice(1)) inner.append(marketBlock(m, mk));
        const toggle = el('button', {
          type: 'button', class: 'more-toggle',
          'aria-expanded': 'false', 'aria-controls': `more-${m.id}`,
          onclick: () => {
            const open = moreWrap.classList.toggle('open');
            toggle.setAttribute('aria-expanded', String(open));
            toggle.firstChild.textContent = open ? 'Färre marknader' : `Fler marknader (${markets.length - 1})`;
          },
        },
          el('span', { text: `Fler marknader (${markets.length - 1})` }),
          el('svg', {}),
        );
        toggle.lastChild.outerHTML = '<svg class="chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 6 L8 11 L13 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        card.append(toggle, moreWrap);
      }
    }
    list.append(card);
  }
  revealify([...list.children]);
}

/* ---------- Senare i slutspelet ---------- */
function renderUpcoming() {
  const scheduled = state.matchesData.matches.filter((m) => m.status === 'scheduled');
  if (!scheduled.length) return;
  $('senare').hidden = false;
  const list = $('upcoming-list');
  list.innerHTML = '';
  for (const m of scheduled) {
    list.append(el('div', { class: 'upcoming-row' },
      el('span', { class: 'upcoming-stage', text: m.stage }),
      el('span', { class: 'upcoming-info', text: venueLine(m) }),
      el('span', { class: 'upcoming-date tnum', text: fmtKickoff(m) }),
    ));
  }
}

/* ---------- Turneringsodds (alla outright-marknader) ---------- */
function renderOutrightBlocks() {
  const outrights = state.matchesData.outrights || [];
  if (!outrights.length) return;
  $('vinnare').hidden = false;
  const container = $('outright-blocks');
  container.innerHTML = '';
  for (const market of outrights) {
    const block = el('div', { class: 'outright-block' });
    block.append(el('div', { class: 'outright-block-title' },
      el('span', { text: market.name }),
      market.note ? el('span', { class: 'outright-block-note', text: market.note }) : null));
    const grid = el('div', { class: 'outright-grid' });
    for (const s of market.selections) {
      const btn = el('button', {
        type: 'button', class: 'outright-btn', 'data-sel': s.id,
        'aria-pressed': 'false',
        'aria-label': `${market.name}: ${s.name}, odds ${fmtOdds(state.currentOdds.get(s.id))}`,
        onclick: () => toggleSelection(s.id),
      },
        teamFlagEl({ code: s.code, tbd: s.tbd }),
        el('span', { class: 'outright-name', text: s.name }),
        el('span', { class: 'odds-value-wrap' },
          el('span', { class: 'odds-value tnum', text: fmtOdds(state.currentOdds.get(s.id)) }),
          el('span', { class: 'odds-arrow', 'aria-hidden': 'true' }),
        ),
      );
      grid.append(btn);
    }
    block.append(grid);
    container.append(block);
    revealify([...grid.children]);
  }
}

/* ---------- Leaderboard: Jasmine vs Erika ---------- */
function betTotalOdds(bet) {
  return bet.selections.reduce((acc, s) => acc * s.odds, 1);
}
function betProfit(bet) {
  if (bet.result === 'won') return bet.stake * betTotalOdds(bet) - bet.stake;
  if (bet.result === 'lost') return -bet.stake;
  return 0;
}

function memberStats(memberId) {
  const bets = state.betsData.bets
    .filter((b) => b.member === memberId)
    .sort((a, b) => a.placedAt.localeCompare(b.placedAt) || a.id.localeCompare(b.id));
  const settled = bets.filter((b) => b.result === 'won' || b.result === 'lost');
  const wins = settled.filter((b) => b.result === 'won').length;
  const net = settled.reduce((acc, b) => acc + betProfit(b), 0);
  let streak = 0;
  for (let i = settled.length - 1; i >= 0; i--) {
    if (settled[i].result === 'won') streak++; else break;
  }
  return {
    bets, settled, wins,
    losses: settled.length - wins,
    open: bets.filter((b) => b.result === 'open').length,
    accuracy: settled.length ? Math.round((wins / settled.length) * 100) : null,
    net, streak,
    form: settled.slice(-8).map((b) => (b.result === 'won' ? 1 : 0)),
  };
}

function sparklineEl(form) {
  if (form.length < 2) return null;
  const w = 72, h = 20, pad = 3;
  const step = (w - pad * 2) / (form.length - 1);
  const pts = form.map((v, i) => `${(pad + i * step).toFixed(1)},${v ? 4 : 16}`).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', w); svg.setAttribute('height', h);
  svg.setAttribute('class', 'sparkline');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', pts);
  svg.append(line);
  return svg;
}

function statColEl(member, st) {
  const col = el('div', { class: 'stat-col' });
  col.append(el('div', { class: 'stat-col-head' },
    el('span', { class: 'stat-col-avatar', 'aria-hidden': 'true', text: member.initial || member.name[0] }),
    el('span', { class: 'stat-col-name', text: member.name })));
  const cells = [
    ['Träffsäkerhet', st.accuracy == null ? '–' : `${st.accuracy} %`],
    ['Spel (avgjorda)', `${st.bets.length} (${st.settled.length})`],
    ['Aktuell svit', st.streak > 0 ? `${st.streak} raka vinster` : '–'],
  ];
  for (const [label, value] of cells) {
    col.append(el('div', { class: 'stat-cell' },
      el('span', { class: 'stat-label', text: label }),
      el('span', { class: 'stat-value tnum', text: value })));
  }
  const netCell = el('div', { class: 'stat-cell' },
    el('span', { class: 'stat-label', text: 'Netto' }),
    el('span', {
      class: `stat-value tnum ${st.net > 0 ? 'pos' : st.net < 0 ? 'neg' : ''}`,
      text: `${st.net > 0 ? '+' : ''}${fmtKr(st.net)}`,
    }));
  col.append(netCell);
  const spark = sparklineEl(st.form);
  if (spark) {
    col.append(el('div', { class: 'spark-row' },
      el('span', { class: 'spark-label', text: 'Form' }), spark));
  }
  return col;
}

function renderLeaderboard() {
  const box = $('leaderboard');
  box.innerHTML = '';
  const { meta, members } = state.betsData;
  if (meta && meta.exampleData) $('example-badge').hidden = false;

  const [m1, m2] = members;
  const s1 = memberStats(m1.id);
  const s2 = memberStats(m2.id);
  const leader = s1.net === s2.net ? null : (s1.net > s2.net ? m1.id : m2.id);

  const playerEl = (m, st) => {
    const p = el('div', { class: `h2h-player${leader === m.id ? ' leader' : ''}` },
      el('span', { class: 'h2h-avatar', 'aria-hidden': 'true', text: m.initial || m.name[0] }),
      el('span', { class: 'h2h-name', text: m.name }));
    if (leader === m.id) p.append(el('span', { class: 'leader-pill', text: 'Leder' }));
    return p;
  };

  const scoreWrap = el('div', { class: 'h2h-score-wrap' },
    el('div', { class: 'h2h-score tnum', 'aria-label': `Vunna spel: ${m1.name} ${s1.wins}, ${m2.name} ${s2.wins}` },
      el('span', { text: String(s1.wins) }),
      el('span', { class: 'score-sep', text: '–' }),
      el('span', { text: String(s2.wins) })),
    el('div', { class: 'h2h-score-label', text: 'Vunna spel' }));

  box.append(el('div', { class: 'h2h' }, playerEl(m1, s1), scoreWrap, playerEl(m2, s2)));

  // Win-share-mätare (glider till sitt värde)
  const totalWins = s1.wins + s2.wins;
  if (totalWins > 0) {
    const share = Math.round((s1.wins / totalWins) * 100);
    const fill = el('div', { class: 'winshare-fill', style: 'width:50%' });
    box.append(el('div', { class: 'winshare' },
      el('div', { class: 'winshare-track', role: 'img', 'aria-label': `${m1.name} har ${share} procent av vinsterna` }, fill),
      el('div', { class: 'winshare-labels' },
        el('span', { text: m1.name }), el('span', { text: m2.name }))));
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${share}%`; }));
  }

  box.append(el('div', { class: 'stat-grid' }, statColEl(m1, s1), statColEl(m2, s2)));

  // Historik
  const memberName = new Map(members.map((m) => [m.id, m.name]));
  const allBets = [...state.betsData.bets].sort((a, b) => b.placedAt.localeCompare(a.placedAt) || b.id.localeCompare(a.id));
  if (allBets.length) {
    const table = el('table', { class: 'history-table' });
    table.append(el('thead', {}, el('tr', {},
      ...['Datum', 'Spelare', 'Spel', 'Odds', 'Insats', 'Utfall'].map((t) => el('th', { scope: 'col', text: t })))));
    const tbody = el('tbody');
    for (const b of allBets) {
      const total = betTotalOdds(b);
      const pickText = b.type === 'kombi'
        ? `Kombi: ${b.selections.map((s) => s.pick).join(' + ')}`
        : `${b.selections[0].pick} · ${b.selections[0].match}`;
      const profit = betProfit(b);
      const outcome = b.result === 'open' ? 'Öppet'
        : b.result === 'won' ? `+${fmtKr(profit)}`
        : `−${fmtKr(b.stake)}`;
      const outcomeClass = b.result === 'open' ? 'open' : (b.result === 'won' ? 'pos' : 'neg');
      tbody.append(el('tr', {},
        el('td', { class: 'tnum', text: b.placedAt.slice(5).replace('-', '/') }),
        el('td', { text: memberName.get(b.member) || b.member }),
        el('td', { class: 'pick' },
          el('span', { class: `result-dot ${b.result}`, 'aria-hidden': 'true' }),
          document.createTextNode(pickText)),
        el('td', { class: 'tnum', text: fmtOdds(total) }),
        el('td', { class: 'tnum', text: fmtKr(b.stake) }),
        el('td', { class: `outcome tnum ${outcomeClass}` , text: outcome }),
      ));
    }
    table.append(tbody);
    box.append(el('div', { class: 'history' },
      el('h3', { class: 'history-title', text: 'Historik' }),
      el('div', { class: 'history-scroll' }, table)));
  }
  revealify([...box.children]);
}

/* ---------- Footer-meta ---------- */
function renderFooterMeta() {
  const v = state.matchesData.meta.dataVersion;
  if (v) $('data-version').textContent = `Odds uppdaterade ${longDateFmt.format(new Date(v + 'T12:00:00'))}`;
}

/* ---------- Kupong ---------- */
function distinctMatches() {
  return new Set([...state.selections.values()].map((s) => s.matchId)).size;
}
function kombiPossible() {
  const n = state.selections.size;
  return n >= 2 && distinctMatches() === n;
}

function toggleSelection(selId) {
  const meta = state.selMeta.get(selId);
  if (!meta || !meta.bettable) return;

  if (state.selections.has(selId)) {
    state.selections.delete(selId);
  } else {
    if (state.mode === 'kombi') {
      const clash = [...state.selections.values()].some((s) => s.matchId === meta.matchId);
      if (clash) {
        showToast('Två val från samma match kan inte kombineras. Byt till Singel eller ta bort det andra valet.');
        return;
      }
    }
    const wasEmpty = state.selections.size === 0;
    state.selections.set(selId, meta);
    popBadges();
    if (wasEmpty && isMobile()) openSheet();
  }
  if (state.mode === 'kombi' && !kombiPossible()) setMode('single');
  syncButtons();
  renderSlip();
}

function syncButtons() {
  document.querySelectorAll('[data-sel]').forEach((btn) => {
    const on = state.selections.has(btn.dataset.sel);
    btn.classList.toggle('selected', on);
    btn.setAttribute('aria-pressed', String(on));
  });
  document.querySelectorAll('.match-card').forEach((card) => {
    const any = [...state.selections.values()].some((s) => s.matchId === card.dataset.match);
    card.classList.toggle('has-selection', any);
  });
}

function popBadges() {
  for (const id of ['slip-badge', 'slip-badge-bar']) {
    const b = $(id);
    b.classList.remove('pop');
    void b.offsetWidth; // starta om animationen
    b.classList.add('pop');
  }
}

function setMode(mode) {
  state.mode = mode;
  $('mode-single').classList.toggle('active', mode === 'single');
  $('mode-single').setAttribute('aria-pressed', String(mode === 'single'));
  $('mode-kombi').classList.toggle('active', mode === 'kombi');
  $('mode-kombi').setAttribute('aria-pressed', String(mode === 'kombi'));
  renderSlip();
}

function getStake() {
  const raw = $('stake-input').value.replace(/[^\d]/g, '');
  return raw ? parseInt(raw, 10) : 0;
}

function slipTotals() {
  const stake = getStake();
  const sels = [...state.selections.values()];
  if (state.mode === 'kombi') {
    const totalOdds = sels.reduce((acc, s) => acc * state.currentOdds.get(s.selId), 1);
    return { stake, totalStake: stake, totalOdds, payout: stake * totalOdds };
  }
  const payout = sels.reduce((acc, s) => acc + stake * state.currentOdds.get(s.selId), 0);
  return { stake, totalStake: stake * sels.length, totalOdds: null, payout };
}

function renderSlip() {
  const n = state.selections.size;
  $('slip-badge').textContent = String(n);
  $('slip-badge-bar').textContent = String(n);
  $('betslip').classList.toggle('empty', n === 0);
  $('slip-empty').hidden = n > 0;
  $('slip-body').hidden = n === 0;
  $('slip-clear').hidden = n === 0;

  if (n === 0) {
    $('slip-bar-payout').textContent = '';
    if (isMobile()) closeSheet();
    return;
  }

  // Kombi-läge möjligt?
  const kombiOk = kombiPossible();
  $('mode-kombi').disabled = !kombiOk;
  $('kombi-hint').hidden = kombiOk || state.mode === 'kombi';

  // Rader
  const rows = $('slip-rows');
  rows.innerHTML = '';
  for (const s of state.selections.values()) {
    rows.append(el('li', { class: 'slip-row' },
      el('div', { class: 'slip-row-info' },
        el('div', { class: 'slip-row-pick', text: s.pickName }),
        el('div', { class: 'slip-row-match', text: `${s.marketName} · ${s.matchLabel}` })),
      el('span', { class: 'slip-row-odds tnum', 'data-slip-odds': s.selId, text: fmtOdds(state.currentOdds.get(s.selId)) }),
      el('button', {
        type: 'button', class: 'slip-row-remove',
        'aria-label': `Ta bort ${s.pickName} från kupongen`,
        onclick: () => { state.selections.delete(s.selId); if (state.mode === 'kombi' && !kombiPossible()) setMode('single'); syncButtons(); renderSlip(); },
        html: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4 L12 12 M12 4 L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      }),
    ));
  }

  updateSlipNumbers();
}

function updateSlipNumbers() {
  const n = state.selections.size;
  if (n === 0) return;
  const t = slipTotals();

  $('slip-total-odds').hidden = state.mode !== 'kombi';
  if (state.mode === 'kombi') $('total-odds-value').textContent = fmtOdds(t.totalOdds);

  $('stake-label').textContent = state.mode === 'single' && n > 1 ? 'Insats per spel' : 'Insats';
  const showTotal = state.mode === 'single' && n > 1;
  $('total-stake-row').hidden = !showTotal;
  if (showTotal) $('total-stake-value').textContent = fmtKr(t.totalStake);

  animateCount($('payout-value'), t.payout);
  $('slip-bar-payout').textContent = t.payout > 0 ? `Möjlig utbetalning ${fmtKr(t.payout)}` : '';

  const hint = $('stake-hint');
  const overBalance = t.totalStake > state.balance;
  if (t.stake <= 0) {
    hint.hidden = false;
    hint.classList.add('info');
    hint.textContent = 'Ange en insats för att lägga spelet.';
  } else if (overBalance) {
    hint.hidden = false;
    hint.classList.remove('info');
    hint.textContent = `Otillräckligt saldo — du har ${fmtKr(state.balance)}.`;
  } else {
    hint.hidden = true;
  }
  $('place-btn').disabled = t.stake <= 0 || overBalance;
}

function initSlipUI() {
  $('mode-single').addEventListener('click', () => setMode('single'));
  $('mode-kombi').addEventListener('click', () => { if (!$('mode-kombi').disabled) setMode('kombi'); });
  $('slip-clear').addEventListener('click', () => {
    state.selections.clear(); syncButtons(); renderSlip();
  });
  $('stake-input').addEventListener('input', () => {
    const clean = $('stake-input').value.replace(/[^\d]/g, '');
    if ($('stake-input').value !== clean) $('stake-input').value = clean;
    updateSlipNumbers();
  });
  document.querySelectorAll('.stake-quick .quick-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.stake;
      if (v === 'all') {
        const n = state.selections.size || 1;
        const amount = state.mode === 'single' ? Math.floor(state.balance / n) : Math.floor(state.balance);
        $('stake-input').value = String(Math.max(amount, 0));
      } else {
        $('stake-input').value = v;
      }
      updateSlipNumbers();
    });
  });
  $('place-btn').addEventListener('click', placeBet);
  $('receipt-done').addEventListener('click', () => {
    $('receipt-view').hidden = true;
    $('slip-view').hidden = false;
    state.selections.clear();
    syncButtons();
    renderSlip();
  });
  $('reset-balance').addEventListener('click', () => {
    state.balance = START_BALANCE;
    saveBalance(); renderBalance(); updateSlipNumbers();
    showToast('Det fiktiva saldot är återställt till 5 000 kr.');
  });
}

/* ---------- Lägg spel → kvitto ---------- */
function receiptId() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `BB-${dd}${mm}-${hex}`;
}

let lastReceipt = null;

function placeBet() {
  const t = slipTotals();
  if (t.stake <= 0 || t.totalStake > state.balance) return;
  const sels = [...state.selections.values()].map((s) => ({
    match: s.matchLabel, market: s.marketName, pick: s.pickName,
    odds: state.currentOdds.get(s.selId),
  }));
  const id = receiptId();
  const placedAt = new Date();
  const bet = {
    id, placedAt: placedAt.toISOString(),
    type: state.mode === 'kombi' ? 'kombi' : 'single',
    stake: t.stake, totalStake: t.totalStake, payout: t.payout, selections: sels,
  };
  try {
    const placed = JSON.parse(localStorage.getItem(LS.placed) || '[]');
    placed.push(bet);
    localStorage.setItem(LS.placed, JSON.stringify(placed));
  } catch { /* localStorage otillgänglig — kvittot visas ändå */ }

  state.balance -= t.totalStake;
  saveBalance();
  renderBalance();
  lastReceipt = bet;
  renderReceipt(bet, placedAt);
  $('slip-view').hidden = true;
  $('receipt-view').hidden = false;
  $('slip-bar-payout').textContent = 'Spel lagt';
  const panel = $('slip-panel');
  panel.scrollTop = 0;
}

function renderReceipt(bet, placedAt) {
  const r = $('receipt');
  r.innerHTML = '';
  r.append(el('div', { class: 'receipt-head' },
    el('span', { html: document.querySelector('.brand .cat-glyph').outerHTML }),
    el('span', { class: 'receipt-title', text: 'Spel lagt' }),
    el('span', { class: 'receipt-check', html: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 8.5 L6.5 12 L13 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' }),
  ));

  const rows = el('div', { class: 'receipt-rows' });
  rows.append(el('div', { class: 'receipt-row' },
    el('span', { text: 'Speltyp' }),
    el('span', { class: 'r-value', text: bet.type === 'kombi' ? `Kombi (${bet.selections.length})` : (bet.selections.length > 1 ? `${bet.selections.length} singlar` : 'Singel') })));
  for (const s of bet.selections) {
    rows.append(el('div', { class: 'receipt-row' },
      el('span', { text: `${s.pick} · ${s.match}` }),
      el('span', { class: 'r-value tnum', text: fmtOdds(s.odds) })));
  }
  if (bet.type === 'kombi') {
    rows.append(el('div', { class: 'receipt-row divider' },
      el('span', { text: 'Totalodds' }),
      el('span', { class: 'r-value tnum', text: fmtOdds(bet.selections.reduce((a, s) => a * s.odds, 1)) })));
  }
  rows.append(el('div', { class: 'receipt-row divider' },
    el('span', { text: bet.type === 'single' && bet.selections.length > 1 ? 'Total insats' : 'Insats' }),
    el('span', { class: 'r-value tnum', text: fmtKr(bet.totalStake) })));
  rows.append(el('div', { class: 'receipt-row payout-line' },
    el('span', { text: 'Möjlig utbetalning' }),
    el('span', { class: 'r-value tnum', text: fmtKr(bet.payout) })));
  r.append(rows);

  r.append(el('div', { class: 'receipt-foot' },
    el('span', { class: 'receipt-id tnum', text: bet.id }),
    el('span', { class: 'tnum', text: `${fmtDay(placedAt)} ${timeFmt.format(placedAt)} · Lycka till` }),
    el('span', { text: 'Privat plattform · inga riktiga pengar' }),
  ));
}

async function shareReceipt() {
  if (!lastReceipt) return;
  const b = lastReceipt;
  const lines = [
    'betsson·bindus — spelkvitto',
    b.type === 'kombi' ? `Kombi @ ${fmtOdds(b.selections.reduce((a, s) => a * s.odds, 1))}` : 'Singel',
    ...b.selections.map((s) => `• ${s.pick} (${fmtOdds(s.odds)}) — ${s.match}`),
    `Insats ${fmtKr(b.totalStake)} → Möjlig utbetalning ${fmtKr(b.payout)}`,
    b.id,
  ];
  const text = lines.join('\n');
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch { /* avbrutet */ }
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('Kvittot är kopierat — klistra in i valfri chatt.');
  } catch {
    showToast('Kunde inte kopiera automatiskt.');
  }
}

/* ---------- Botten-sheet (mobil) ---------- */
const mqMobile = window.matchMedia('(max-width: 1023px)');
const isMobile = () => mqMobile.matches;

function openSheet() {
  if (!isMobile()) return;
  state.sheetOpener = document.activeElement;
  const slip = $('betslip');
  slip.classList.add('open');
  $('slip-bar').setAttribute('aria-expanded', 'true');
  $('slip-panel').setAttribute('aria-modal', 'true');
  const bd = $('backdrop');
  bd.hidden = false;
  requestAnimationFrame(() => bd.classList.add('show'));
  document.body.style.overflow = 'hidden';
  $('slip-heading').focus({ preventScroll: true });
}

function closeSheet() {
  const slip = $('betslip');
  if (!slip.classList.contains('open')) return;
  slip.classList.remove('open');
  $('slip-bar').setAttribute('aria-expanded', 'false');
  $('slip-panel').setAttribute('aria-modal', 'false');
  const bd = $('backdrop');
  bd.classList.remove('show');
  setTimeout(() => { bd.hidden = true; }, 300);
  document.body.style.overflow = '';
  // Återlämna fokus till öppnaren (eller kupong-baren om öppnaren försvunnit)
  const opener = state.sheetOpener;
  state.sheetOpener = null;
  if (opener && document.contains(opener) && opener.offsetParent !== null) {
    opener.focus({ preventScroll: true });
  } else if (!$('betslip').classList.contains('empty')) {
    $('slip-bar').focus({ preventScroll: true });
  }
}

function trapFocus(e, container) {
  const focusables = [...container.querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]), summary')]
    .filter((n) => n.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !container.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function initSheet() {
  $('slip-bar').addEventListener('click', () => {
    $('betslip').classList.contains('open') ? closeSheet() : openSheet();
  });
  $('backdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheet();
    if (e.key === 'Tab' && isMobile() && $('betslip').classList.contains('open')) trapFocus(e, $('slip-panel'));
  });
  $('sheet-handle').addEventListener('click', closeSheet);
  $('receipt-share').addEventListener('click', shareReceipt);

  // Dra-att-stänga på handtaget
  const slip = $('betslip');
  const handle = $('sheet-handle');
  let startY = null;
  handle.addEventListener('pointerdown', (e) => {
    if (!isMobile()) return;
    startY = e.clientY;
    slip.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (startY == null) return;
    const dy = Math.max(0, e.clientY - startY);
    slip.style.transform = `translateY(${dy}px)`;
  });
  const endDrag = (e) => {
    if (startY == null) return;
    const dy = Math.max(0, e.clientY - startY);
    slip.classList.remove('dragging');
    slip.style.transform = '';
    if (dy > 90) closeSheet();
    startY = null;
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  mqMobile.addEventListener('change', () => {
    document.body.style.overflow = '';
    $('backdrop').hidden = true;
    $('backdrop').classList.remove('show');
    $('betslip').classList.remove('open');
    $('slip-bar').setAttribute('aria-expanded', 'false');
  });
}

/* ---------- Toast ---------- */
let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

/* ---------- Odds-flash ---------- */
function scheduleArrowHide(selId, arrow, ms) {
  clearTimeout(state.arrowTimers.get(selId));
  state.arrowTimers.set(selId, setTimeout(() => {
    arrow.classList.remove('show-up', 'show-down');
  }, ms));
}

function applyOddsChange(selId, newOdds) {
  const old = state.currentOdds.get(selId);
  if (old == null || Math.abs(newOdds - old) < 0.005) return;
  const up = newOdds > old;
  state.currentOdds.set(selId, newOdds);

  document.querySelectorAll(`[data-sel="${selId}"]`).forEach((btn) => {
    const value = btn.querySelector('.odds-value');
    const arrow = btn.querySelector('.odds-arrow');
    btn.classList.remove('flash-up', 'flash-down');
    void btn.offsetWidth;
    btn.classList.add(up ? 'flash-up' : 'flash-down');
    flipTo(value, fmtOdds(newOdds), up);
    arrow.textContent = up ? '▲' : '▼';
    arrow.classList.remove('show-up', 'show-down');
    arrow.classList.add(up ? 'show-up' : 'show-down');
    scheduleArrowHide(selId, arrow, 3000);
    const meta = state.selMeta.get(selId);
    if (meta) btn.setAttribute('aria-label', `${meta.marketName}: ${meta.pickName}, odds ${fmtOdds(newOdds)}`);
  });

  // Uppdatera kupongen om valet ligger där
  const slipOdds = document.querySelector(`[data-slip-odds="${selId}"]`);
  if (slipOdds) {
    flipTo(slipOdds, fmtOdds(newOdds), up);
    updateSlipNumbers();
  }
}

/* Flash för odds som ändrats i datafilen sedan senaste besöket */
function flashFileChanges() {
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(LS.seenOdds) || '{}'); } catch { seen = {}; }
  const current = {};
  for (const [selId, odds] of state.baseOdds) current[selId] = odds;
  const changed = Object.entries(current).filter(([selId, odds]) =>
    typeof seen[selId] === 'number' && Math.abs(seen[selId] - odds) >= 0.005);
  localStorage.setItem(LS.seenOdds, JSON.stringify(current));
  if (!changed.length) return;
  setTimeout(() => {
    for (const [selId, odds] of changed) {
      // Rör inte odds som driften redan hunnit ändra
      if (state.currentOdds.get(selId) !== state.baseOdds.get(selId)) continue;
      state.currentOdds.set(selId, seen[selId]); // flasha från gammalt → nytt
      applyOddsChange(selId, odds);
    }
  }, 1200);
}

/* Marknadsdrift — presentationslager.
   Oddsen nudgas i små steg, förankrade kring värdet i data/matches.json
   (±6 %), med dragning tillbaka mot ankaret. Ingen persistens. */
function driftTick() {
  if (document.hidden) return;
  if (Math.random() > 0.55) return;
  const pool = [...state.selMeta.values()].filter((m) => m.bettable);
  if (!pool.length) return;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const base = state.baseOdds.get(pick.selId);
  const cur = state.currentOdds.get(pick.selId);
  const tickSize = cur < 2 ? 0.03 : cur < 3 ? 0.05 : cur < 10 ? 0.10 : 0.50;
  const pDown = cur > base ? 0.65 : cur < base ? 0.35 : 0.5;
  const dir = Math.random() < pDown ? -1 : 1;
  let next = Math.round((cur + dir * tickSize) * 100) / 100;
  next = Math.min(base * 1.06, Math.max(base * 0.94, next));
  next = Math.max(1.01, Math.round(next * 100) / 100);
  applyOddsChange(pick.selId, next);
}

function startDrift() {
  // Startar efter fil-ändrings-flashen (1,2 s) så de inte kolliderar
  setTimeout(() => setInterval(driftTick, 9000), 3000);
}

/* ---------- Magnetisk press (endast primär-CTA, pointer:fine) ---------- */
function initMagneticPress() {
  if (!finePointer.matches || reducedMotion.matches) return;
  for (const btn of [$('place-btn')]) {
    if (!btn) continue;
    btn.addEventListener('pointermove', (e) => {
      const r = btn.getBoundingClientRect();
      const dx = ((e.clientX - r.left) / r.width - 0.5) * 8;
      const dy = ((e.clientY - r.top) / r.height - 0.5) * 8;
      btn.style.setProperty('--press-x', `${Math.max(-4, Math.min(4, dx)).toFixed(1)}px`);
      btn.style.setProperty('--press-y', `${Math.max(-4, Math.min(4, dy)).toFixed(1)}px`);
    });
    btn.addEventListener('pointerleave', () => {
      btn.style.setProperty('--press-x', '0px');
      btn.style.setProperty('--press-y', '0px');
    });
  }
}

init();
