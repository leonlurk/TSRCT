// lib/paths.js - every folder TSRCT reads or writes outside its own repo, in ONE place.
//
// Each comes from .env and otherwise from a default under your home folder. Nothing
// else in the code may spell out a path on a particular machine: set these instead.
//
//   PROJECTS_ROOT   the folder that holds your projects           (~/PROJECTS)
//   VAULT_ROOT      an Obsidian vault the morning brief reads      (PROJECTS_ROOT/vault)
//   WIN_HOME        your Windows user folder, seen from WSL        (unset: Windows features off)
//   HEADLESS_DIR    where puppeteer-core + chrome-headless-shell   (~/headless-chrome)
//                   live, for the projector and the scrapers
'use strict';

const os = require('os');
const path = require('path');

const HOME = os.homedir();
const PROJECTS_ROOT = process.env.PROJECTS_ROOT || path.join(HOME, 'PROJECTS');
const VAULT_ROOT = process.env.VAULT_ROOT || path.join(PROJECTS_ROOT, 'vault');
const WIN_HOME = process.env.WIN_HOME || '';
const HEADLESS_DIR = process.env.HEADLESS_DIR || path.join(HOME, 'headless-chrome');
// Claude Code names a project's transcript folder after its path: /a/b -> -a-b
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const claudeSlug = (dir) => String(dir).replace(/[\\/]/g, '-');

module.exports = { HOME, PROJECTS_ROOT, VAULT_ROOT, WIN_HOME, HEADLESS_DIR, CLAUDE_PROJECTS, claudeSlug };
