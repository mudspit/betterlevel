const fs = require('fs');
const path = require('path');

// On Railway, mount a volume at /data for persistence. Locally uses project root.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const DEFAULT = {
  tracked_emails: [],
  scheduled_emails: [],
  snoozed: [],
  templates: [],
  signatures: {},
  contacts: [],
  reminders: [],
  auto_replies: {},
  settings: { publicUrl: 'http://localhost:3000', notifyInterval: 120 },
  campaigns: [],
  lists: []
};

let _data = null;

function load() {
  if (_data) return _data;
  try {
    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      _data = { ...DEFAULT, ...saved };
    } else {
      _data = JSON.parse(JSON.stringify(DEFAULT));
    }
  } catch (e) {
    _data = JSON.parse(JSON.stringify(DEFAULT));
  }
  return _data;
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(_data, null, 2));
}

function get() { return load(); }

function uuid() {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

module.exports = { get, save, load, uuid };
