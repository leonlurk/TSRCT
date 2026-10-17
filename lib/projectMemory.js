// ─────────────────────────────────────────────────────────────────────────
// lib/projectMemory.js — what this project has BEEN doing, for the voice.
//
// TALK could already read the screen. The screen says what just happened; it
// does not say what any of it is for, what was decided last week, or what the
// last session left open. Measured 2026-09-19: adding just the head of the
// project's vault note moved an answer from "the tests failed" to naming who
// the open item belonged to and when it was due — a fact that was never on
// screen. This file is the rest of that idea, and it is the cheap half of
// "smarter": context costs prompt tokens, not VRAM. Leon's rule after pricing
// qwen3:8b — the card's budget is spent on READING BETTER, not sounding better.
//
// Three sources, in the order they earn their tokens:
//   1. the project's vault note        — what it IS
//   2. its section of the Decisions Log — what was DECIDED, newest first
//   3. its newest session log           — where the last session LEFT it
//
// THE COST CONTROL IS THE POINT. The Decisions Log is ~3 MB and the live
// narrator asks for this every time it speaks. So: every read is cached against
// the file's mtime (a stat, not a read), every extract is capped hard, and a
// missing vault is an absence rather than an error. Nothing here ever runs on a
// timer of its own.
//
// SecretCo: the guard is required STANDALONE (same rule as restrictedGuard itself), the
// project name is refused before a single file is opened, and the assembled
// block is scanned again by the caller. A vault note is exactly the kind of
// document the contract exists for.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const restrictedGuard = require('./dispatcher/restrictedGuard');

const VAULT_ROOT = () => process.env.VAULT_ROOT || paths.VAULT_ROOT;

// Hard caps, in characters. Roughly 4 chars to a token, so the whole block is
// ~450 tokens of an 8192 window — worth it, and bounded whatever the vault does.
const NOTE_CHARS = Number(process.env.TALK_NOTE_CHARS || 900);
const DECISION_CHARS = Number(process.env.TALK_DECISION_CHARS || 320);
const DECISION_COUNT = Number(process.env.TALK_DECISION_COUNT || 2);
const SESSION_CHARS = Number(process.env.TALK_SESSION_CHARS || 500);

// path -> { mtimeMs, value }. Keyed by file, so one edit invalidates one entry.
const cache = new Map();

// Read a file at most once per edit. The stat is what runs on every call; the
// 3 MB read happens only when the file has actually changed.
function cachedRead(file, parse) {
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.value;
    let value = null;
    try { value = parse(fs.readFileSync(file, 'utf8')); } catch { value = null; }
    cache.set(file, { mtimeMs: st.mtimeMs, value });
    return value;
}

function stripFrontmatter(raw) {
    return String(raw || '').replace(/^---[\s\S]*?\n---\n/, '').trim();
}

// Cut on a sentence if there is one nearby, otherwise on a word. A quote that
// stops mid-word reads as a bug when it is spoken out loud.
function clip(s, max) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const dot = cut.lastIndexOf('. ');
    if (dot > max * 0.5) return cut.slice(0, dot + 1);
    return cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)) + '...';
}

// ── 1. the project note ─────────────────────────────────────────────────────
function noteFor(project) {
    const dir = path.join(VAULT_ROOT(), 'projects');
    let hit = null;
    try {
        hit = fs.readdirSync(dir).find(f => f.toLowerCase() === `${project.toLowerCase()}.md`);
    } catch { return ''; }
    if (!hit) return '';
    const v = cachedRead(path.join(dir, hit), raw => stripFrontmatter(raw).slice(0, NOTE_CHARS * 2));
    return v ? clip(v, NOTE_CHARS) : '';
}

// ── 2. the Decisions Log, newest first ──────────────────────────────────────
// Since 2026-09-24 the log is split: wiki/decisions/<project>.md, newest entry at
// the top (the 3 MB single file could not be read whole by anything, and a
// session reading its top got daily-tasks). One small file per project: read it,
// keep its first entries. The old single-file parse below stays as the fallback.
function decisionsFor(project) {
    // Refused here too, not only in forProject(): the split left an SecretCo file
    // in wiki/decisions/, and this function is exported on its own.
    if (restrictedGuard.mentionsRestricted(String(project || ''))) return [];
    const dir = path.join(VAULT_ROOT(), 'wiki', 'decisions');
    let hit = null;
    try { hit = fs.readdirSync(dir).find(f => f.toLowerCase() === `${String(project).toLowerCase()}.md`); } catch { hit = null; }
    if (hit) {
        const top = cachedRead(path.join(dir, hit), raw => stripFrontmatter(raw).slice(0, 60000));
        const entries = [];
        for (const line of String(top || '').split('\n')) {
            if (!/^-\s+\*\*/.test(line)) continue;
            entries.push(clip(line.replace(/^-\s+/, ''), DECISION_CHARS));
            if (entries.length >= DECISION_COUNT) break;
        }
        return entries;
    }
    return decisionsFromSingleLog(project);
}

function decisionsFromSingleLog(project) {
    const file = path.join(VAULT_ROOT(), 'wiki', 'Decisions Log.md');
    const all = cachedRead(file, (raw) => {
        const out = {};
        let current = null;
        let buf = [];
        const flush = () => { if (current) out[current.toLowerCase()] = buf.join('\n'); buf = []; };
        for (const line of raw.split('\n')) {
            const h = /^##\s+(.+?)\s*$/.exec(line);
            if (h) {
                flush();
                // "## leak-scan (The Leak Scan — ...)" keys on the short name.
                current = h[1].replace(/\s*\(.*$/, '').trim();
                continue;
            }
            // Only the first entries are ever used; stop hoarding after a
            // section is comfortably past that, so a 3 MB file does not become
            // 3 MB of cache.
            if (current && buf.length < 400) buf.push(line);
        }
        flush();
        return out;
    });
    if (!all) return [];
    const section = all[String(project).toLowerCase()];
    if (!section) return [];
    const entries = [];
    for (const line of section.split('\n')) {
        if (!/^-\s+\*\*/.test(line)) continue;       // "- **Title (date)** - body"
        entries.push(clip(line.replace(/^-\s+/, ''), DECISION_CHARS));
        if (entries.length >= DECISION_COUNT) break;
    }
    return entries;
}

// ── 3. where the last session left it ───────────────────────────────────────
// vault/sessions/YYYY-MM-DD-<project>-<whatever>.md. Filenames sort by date, so
// the newest match is the last one.
function lastSessionFor(project) {
    const dir = path.join(VAULT_ROOT(), 'sessions');
    const needle = `-${String(project).toLowerCase()}-`;
    let files = [];
    try {
        files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.md') && f.toLowerCase().includes(needle))
            .sort();
    } catch { return null; }
    const newest = files[files.length - 1];
    if (!newest) return null;
    const body = cachedRead(path.join(dir, newest), raw => stripFrontmatter(raw).slice(0, SESSION_CHARS * 3));
    if (!body) return null;
    // The date is the first ten characters of the filename, and saying WHEN
    // matters: "yesterday's session left X open" is a different sentence from
    // "a session in July left X open".
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(newest);
    return { date: date ? date[1] : '', text: clip(body.replace(/^#\s+.*\n/, ''), SESSION_CHARS) };
}

// ── what the caller gets ────────────────────────────────────────────────────
function forProject(project, cwd) {
    const name = String(project || '').trim();
    if (!name) return null;
    // Refuse by name before opening anything. An SecretCo project's note, its
    // decisions and its session logs must never be read into a prompt, and the
    // folder name is enough to know that.
    if (restrictedGuard.mentionsRestricted(name) || (cwd && restrictedGuard.mentionsRestricted(cwd))) return null;
    const out = {
        project: name,
        cwd: cwd || '',
        note: noteFor(name),
        decisions: decisionsFor(name),
        lastSession: lastSessionFor(name),
    };
    // Belt and braces: the FILES may mention it even when the project does not.
    const blob = [out.note, ...(out.decisions || []), out.lastSession && out.lastSession.text]
        .filter(Boolean).join('\n');
    if (blob && restrictedGuard.mentionsRestricted(blob)) {
        return { project: name, cwd: cwd || '', note: '', decisions: [], lastSession: null };
    }
    return out;
}

module.exports = { forProject, noteFor, decisionsFor, lastSessionFor, clip };
