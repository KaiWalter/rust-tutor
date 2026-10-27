// Single-user progress in SQLite (node:sqlite): attempts, passes, XP, streak,
// last code per challenge, spaced-repetition review cards, judge cache.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DAY_MS = 86_400_000;
export const GRADES = { again: 0, hard: 1, good: 2, easy: 3 };
export const REVIEW_XP = 2;

/**
 * SM-2 lite. grade: 0 again, 1 hard, 2 good, 3 easy.
 * "again" resets the card and re-shows it in 10 minutes.
 */
export function scheduleCard(card, grade, now) {
  if (![0, 1, 2, 3].includes(grade)) throw new RangeError("grade must be 0..3");
  let ease = card.ease ?? 2.5;
  let reps = card.reps ?? 0;
  let interval = card.intervalDays ?? 0;
  let lapses = card.lapses ?? 0;
  if (grade === 0) {
    reps = 0;
    interval = 0;
    lapses += 1;
    ease = Math.max(1.3, ease - 0.2);
    return { ease, reps, intervalDays: 0, lapses, dueAt: new Date(now + 10 * 60_000).toISOString() };
  }
  reps += 1;
  if (reps === 1) interval = grade === 1 ? 0.5 : grade === 3 ? 2 : 1;
  else if (reps === 2) interval = grade === 1 ? 2 : grade === 3 ? 5 : 3;
  else interval = interval * ease * (grade === 1 ? 0.6 : grade === 3 ? 1.3 : 1);
  ease = Math.max(1.3, ease + (grade === 3 ? 0.15 : grade === 1 ? -0.15 : 0));
  interval = Math.min(Math.round(interval * 10) / 10, 365);
  return { ease, reps, intervalDays: interval, lapses, dueAt: new Date(now + interval * DAY_MS).toISOString() };
}

/** Calendar day key in the learner's time zone. */
export function dayKey(ms, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** Consecutive active days ending today (or yesterday, if today is still open). */
export function streakFrom(days, todayKey) {
  const set = new Set(days);
  const prev = (k) => {
    const d = new Date(`${k}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  let k = set.has(todayKey) ? todayKey : prev(todayKey);
  let n = 0;
  while (set.has(k)) {
    n += 1;
    k = prev(k);
  }
  return n;
}

export function openStore(file, { timeZone = "Europe/Berlin", now = () => Date.now() } = {}) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS challenge_state (
      challenge_id TEXT PRIMARY KEY,
      level_id TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      passes INTEGER NOT NULL DEFAULT 0,
      first_passed_at TEXT,
      last_code TEXT,
      last_answer TEXT,
      hints_used INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenge_id TEXT NOT NULL,
      passed INTEGER NOT NULL,
      code_hash TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS xp_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      ref TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS xp_first_pass ON xp_events(ref) WHERE reason = 'first-pass';
    CREATE TABLE IF NOT EXISTS activity (day TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS cards (
      card_id TEXT PRIMARY KEY,
      level_id TEXT NOT NULL,
      ease REAL NOT NULL DEFAULT 2.5,
      interval_days REAL NOT NULL DEFAULT 0,
      reps INTEGER NOT NULL DEFAULT 0,
      lapses INTEGER NOT NULL DEFAULT 0,
      due_at TEXT NOT NULL,
      last_grade INTEGER,
      reviewed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_cache (
      key TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const iso = () => new Date(now()).toISOString();
  const touchDay = () => db.prepare("INSERT OR IGNORE INTO activity(day) VALUES (?)").run(dayKey(now(), timeZone));

  function ensureState(challengeId, levelId) {
    db.prepare("INSERT OR IGNORE INTO challenge_state(challenge_id, level_id, updated_at) VALUES (?, ?, ?)").run(challengeId, levelId, iso());
  }

  function state(challengeId) {
    return db.prepare("SELECT * FROM challenge_state WHERE challenge_id = ?").get(challengeId) || null;
  }

  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Record a verify attempt; first pass awards XP and unlocks review cards. */
  function recordVerify(ch, { passed, code, answer, codeHash }, catalog) {
    return tx(() => {
      ensureState(ch.id, ch.levelId);
      const before = state(ch.id);
      db.prepare(
        `UPDATE challenge_state SET attempts = attempts + 1, passes = passes + ?, last_code = COALESCE(?, last_code),
           last_answer = COALESCE(?, last_answer), first_passed_at = COALESCE(first_passed_at, ?), updated_at = ? WHERE challenge_id = ?`,
      ).run(passed ? 1 : 0, code ?? null, answer ?? null, passed ? iso() : null, iso(), ch.id);
      db.prepare("INSERT INTO attempts(challenge_id, passed, code_hash, created_at) VALUES (?, ?, ?, ?)").run(ch.id, passed ? 1 : 0, codeHash ?? null, iso());
      const firstPass = passed && !before.first_passed_at;
      let xpAwarded = 0;
      const unlockedCards = [];
      if (firstPass) {
        xpAwarded = ch.xp;
        db.prepare("INSERT INTO xp_events(amount, reason, ref, created_at) VALUES (?, 'first-pass', ?, ?)").run(ch.xp, ch.id, iso());
        for (const card of catalog.cards().filter((c) => c.unlockAfter === ch.id)) {
          const r = db.prepare("INSERT OR IGNORE INTO cards(card_id, level_id, due_at, created_at) VALUES (?, ?, ?, ?)").run(card.id, card.levelId, iso(), iso());
          if (r.changes) unlockedCards.push(card.id);
        }
      }
      if (passed) touchDay();
      return { firstPass, xpAwarded, unlockedCards };
    });
  }

  function saveCode(ch, { code, answer }) {
    ensureState(ch.id, ch.levelId);
    db.prepare("UPDATE challenge_state SET last_code = COALESCE(?, last_code), last_answer = COALESCE(?, last_answer), updated_at = ? WHERE challenge_id = ?").run(
      code ?? null,
      answer ?? null,
      iso(),
      ch.id,
    );
  }

  function resetCode(ch) {
    ensureState(ch.id, ch.levelId);
    db.prepare("UPDATE challenge_state SET last_code = NULL, last_answer = NULL, updated_at = ? WHERE challenge_id = ?").run(iso(), ch.id);
  }

  function useHint(ch) {
    ensureState(ch.id, ch.levelId);
    db.prepare("UPDATE challenge_state SET hints_used = hints_used + 1, updated_at = ? WHERE challenge_id = ?").run(iso(), ch.id);
    return state(ch.id).hints_used;
  }

  function xpTotal() {
    return db.prepare("SELECT COALESCE(SUM(amount), 0) AS xp FROM xp_events").get().xp;
  }

  function progress(catalog) {
    const rows = new Map(db.prepare("SELECT * FROM challenge_state").all().map((r) => [r.challenge_id, r]));
    const days = db.prepare("SELECT day FROM activity").all().map((r) => r.day);
    const levels = [];
    let prevBossPassed = true;
    for (const l of catalog.levels) {
      const challenges = l.challenges.map((c) => {
        const r = rows.get(c.id);
        return {
          id: c.id,
          passed: Boolean(r?.first_passed_at),
          attempts: r?.attempts ?? 0,
          hintsUsed: r?.hints_used ?? 0,
          hasCode: r?.last_code != null || r?.last_answer != null,
        };
      });
      const passedCount = challenges.filter((c) => c.passed).length;
      // A level with any saved state stays open even if levels were later
      // inserted before it (e.g. the prelude): progress never gets locked away.
      const started = l.challenges.some((c) => rows.has(c.id));
      levels.push({ id: l.id, unlocked: prevBossPassed || started, passed: passedCount, total: challenges.length, complete: passedCount === challenges.length, challenges });
      prevBossPassed = challenges.at(-1).passed;
    }
    return {
      xp: xpTotal(),
      streak: streakFrom(days, dayKey(now(), timeZone)),
      activeToday: days.includes(dayKey(now(), timeZone)),
      reviewDue: db.prepare("SELECT COUNT(*) AS n FROM cards WHERE due_at <= ?").get(iso()).n,
      cardsTotal: db.prepare("SELECT COUNT(*) AS n FROM cards").get().n,
      levels,
    };
  }

  function dueCards(limit = 50) {
    return db.prepare("SELECT * FROM cards WHERE due_at <= ? ORDER BY due_at LIMIT ?").all(iso(), limit);
  }

  function reviewCard(cardId, grade) {
    return tx(() => {
      const row = db.prepare("SELECT * FROM cards WHERE card_id = ?").get(cardId);
      if (!row) return null;
      const next = scheduleCard({ ease: row.ease, reps: row.reps, intervalDays: row.interval_days, lapses: row.lapses }, grade, now());
      db.prepare("UPDATE cards SET ease = ?, reps = ?, interval_days = ?, lapses = ?, due_at = ?, last_grade = ?, reviewed_at = ? WHERE card_id = ?").run(
        next.ease,
        next.reps,
        next.intervalDays,
        next.lapses,
        next.dueAt,
        grade,
        iso(),
        cardId,
      );
      db.prepare("INSERT INTO xp_events(amount, reason, ref, created_at) VALUES (?, 'review', ?, ?)").run(REVIEW_XP, cardId, iso());
      touchDay();
      return { cardId, ...next, xpAwarded: REVIEW_XP };
    });
  }

  function cacheGet(key) {
    const row = db.prepare("SELECT result_json FROM agent_cache WHERE key = ?").get(key);
    return row ? JSON.parse(row.result_json) : null;
  }

  function cachePut(key, tier, result) {
    db.prepare("INSERT OR REPLACE INTO agent_cache(key, tier, result_json, created_at) VALUES (?, ?, ?, ?)").run(key, tier, JSON.stringify(result), iso());
  }

  function ping() {
    return db.prepare("SELECT 1 AS ok").get().ok === 1;
  }

  return { recordVerify, saveCode, resetCode, useHint, state, progress, dueCards, reviewCard, cacheGet, cachePut, xpTotal, ping, close: () => db.close() };
}
