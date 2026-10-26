'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var path = require('path');
var execFile = require('child_process').execFile;

module.exports = ControllerAutoDJ;

// Streaming services AutoDJ may fall back to for an artist that isn't in
// the local library: settings key -> Volumio "service" names in search
// results. Each only ever matters if that service is set up in Volumio.
var STREAMS = [
  { key: 'useTidal', services: 'tidal' },
  { key: 'useQobuz', services: 'qobuz' },
  { key: 'useHra', services: 'hi_res_audio hra highresaudio' },
  { key: 'useSpotify', services: 'spop spotify' }
];

// The boundary watcher (see startWatcher) runs as a systemd service of its
// own, as Volumio asks of plugins for anything long-running: install.sh
// writes the unit, the plugin only starts and stops it. Its settings go in
// an EnvironmentFile below /tmp, rewritten on every start.
var WATCH_UNIT = 'volumio-autodj-watch.service';
var WATCH_ENV_DIR = '/tmp/volumio_autodj';
var WATCH_ENV = WATCH_ENV_DIR + '/watch.env';

var REST_ENDPOINT = {
  endpoint: 'autodj',
  type: 'miscellanea',
  name: 'volumio_autodj',
  method: 'restApi'
};

function ControllerAutoDJ(context) {
  var self = this;

  self.context = context;
  self.commandRouter = self.context.coreCommand;
  self.logger = self.context.logger;
  self.configManager = self.context.configManager;

  self.timer = null;
  self.watcherRunning = false;
}

// -----------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------
ControllerAutoDJ.prototype.onVolumioStart = function () {
  var self = this;

  var configFile = self.commandRouter.pluginManager.getConfigurationFile(self.context, 'config.json');

  // v-conf's own save() (fs.writeJson, no callback - see its index.js)
  // fails silently with ENOENT if the config directory doesn't exist yet,
  // and swallows the error rather than throwing - on a brand new install
  // this directory has never been created, so every settings save was a
  // silent no-op: the in-memory value took effect immediately (masking
  // the problem, since behavior for the current session looked correct),
  // but nothing ever reached disk, so a reboot reverted everything to
  // defaults. Ensuring the directory exists up front avoids this
  // regardless of whether v-conf itself gets fixed upstream.
  try {
    fs.ensureDirSync(path.dirname(configFile));
  } catch (e) {
    self.logger.error('[volumio_autodj] cannot create ' + path.dirname(configFile) + ': ' + e.message);
  }

  self.config = new (require('v-conf'))();
  self.config.loadFile(configFile);

  // First-run defaults - explicit rather than relying on v-conf's own
  // missing-file behavior, so a fresh install always has sane values.
  if (self.config.get('enabled') === undefined) self.config.set('enabled', false);
  if (self.config.get('intervalSeconds') === undefined) self.config.set('intervalSeconds', 90);
  if (self.config.get('artistHistorySize') === undefined) self.config.set('artistHistorySize', 4);
  if (self.config.get('lastfmApiKey') === undefined) self.config.set('lastfmApiKey', '');
  if (self.config.get('autoReplayGain') === undefined) self.config.set('autoReplayGain', false);
  if (self.config.get('autoCrossfadeSeconds') === undefined) self.config.set('autoCrossfadeSeconds', '');
  if (self.config.get('excludeKeywords') === undefined) self.config.set('excludeKeywords', '');
  if (self.config.get('maxTrackMinutes') === undefined) self.config.set('maxTrackMinutes', 20);
  STREAMS.forEach(function (s) {
    if (self.config.get(s.key) === undefined) self.config.set(s.key, true);
  });

  return libQ.resolve();
};

ControllerAutoDJ.prototype.onStart = function () {
  var self = this;

  if (self.config.get('enabled')) {
    self.startTimer();
  }

  // REST endpoint for other frontends (POST /api/v1/pluginEndpoint with
  // {"endpoint": "autodj", "data": {...}}), see restApi() below.
  if (typeof self.commandRouter.addPluginRestEndpoint === 'function') {
    self.commandRouter.addPluginRestEndpoint(REST_ENDPOINT);
  }

  return libQ.resolve();
};

ControllerAutoDJ.prototype.onStop = function () {
  var self = this;

  self.stopTimer();
  if (typeof self.commandRouter.removePluginRestEndpoint === 'function') {
    self.commandRouter.removePluginRestEndpoint(REST_ENDPOINT);
  }

  return libQ.resolve();
};

ControllerAutoDJ.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};

// -----------------------------------------------------------------------
// UI configuration page
// -----------------------------------------------------------------------
ControllerAutoDJ.prototype.getUIConfig = function () {
  var self = this;
  var defer = libQ.defer();

  var uiconf;
  try {
    uiconf = fs.readJsonSync(__dirname + '/UIConfig.json');
  } catch (e) {
    self.logger.error('[volumio_autodj] cannot read UIConfig.json: ' + e.message);
    defer.reject(e);
    return defer.promise;
  }

  uiconf.sections[0].content[0].value = self.config.get('enabled');
  uiconf.sections[0].content[1].value = String(self.config.get('intervalSeconds'));
  uiconf.sections[0].content[2].value = self.config.get('lastfmApiKey');
  uiconf.sections[0].content[3].value = String(self.config.get('artistHistorySize'));
  uiconf.sections[0].content[4].value = self.config.get('autoReplayGain');
  uiconf.sections[0].content[5].value = String(self.config.get('autoCrossfadeSeconds'));
  uiconf.sections[0].content[6].value = String(self.config.get('excludeKeywords'));
  uiconf.sections[0].content[7].value = String(self.config.get('maxTrackMinutes'));
  STREAMS.forEach(function (s, i) {
    uiconf.sections[0].content[8 + i].value = self.config.get(s.key) !== false;
  });

  defer.resolve(uiconf);
  return defer.promise;
};

// Stored setting as a whole number of minutes, 0 = no limit; anything
// unreadable falls back to the script's default of 20.
ControllerAutoDJ.prototype.maxTrackMinutes = function () {
  var n = parseInt(this.config.get('maxTrackMinutes'), 10);
  return isNaN(n) || n < 0 ? 20 : n;
};

ControllerAutoDJ.prototype.saveSettings = function (data) {
  var self = this;
  var defer = libQ.defer();

  var intervalSeconds = parseInt(data['intervalSeconds'], 10);
  if (isNaN(intervalSeconds) || intervalSeconds < 30) {
    self.commandRouter.pushToastMessage('error', 'AutoDJ', 'Check interval must be a number of at least 30 seconds.');
    defer.resolve({});
    return defer.promise;
  }

  var artistHistorySize = parseInt(data['artistHistorySize'], 10);
  if (isNaN(artistHistorySize) || artistHistorySize < 1) {
    self.commandRouter.pushToastMessage('error', 'AutoDJ', 'Artist repeat guard size must be a positive number.');
    defer.resolve({});
    return defer.promise;
  }

  // Empty means "off" (default) - only validated as a number when
  // actually set, same off-by-default spirit as autoReplayGain but with
  // a value to carry (the crossfade duration) instead of a plain switch.
  var autoCrossfadeSecondsRaw = (data['autoCrossfadeSeconds'] || '').trim();
  var autoCrossfadeSeconds = '';
  if (autoCrossfadeSecondsRaw !== '') {
    var crossfadeNum = parseInt(autoCrossfadeSecondsRaw, 10);
    if (isNaN(crossfadeNum) || crossfadeNum < 0 || String(crossfadeNum) !== autoCrossfadeSecondsRaw) {
      self.commandRouter.pushToastMessage('error', 'AutoDJ', 'Auto crossfade must be empty (off) or a whole number of seconds.');
      defer.resolve({});
      return defer.promise;
    }
    autoCrossfadeSeconds = String(crossfadeNum);
  }

  // 0 = no limit; empty falls back to the default of 20
  var maxTrackMinutesRaw = String(data['maxTrackMinutes'] === undefined ? '' : data['maxTrackMinutes']).trim();
  var maxTrackMinutes = maxTrackMinutesRaw === '' ? 20 : parseInt(maxTrackMinutesRaw, 10);
  if (isNaN(maxTrackMinutes) || maxTrackMinutes < 0 || (maxTrackMinutesRaw !== '' && String(maxTrackMinutes) !== maxTrackMinutesRaw)) {
    self.commandRouter.pushToastMessage('error', 'AutoDJ', 'Maximum track length must be a whole number of minutes (0 = no limit).');
    defer.resolve({});
    return defer.promise;
  }

  var enabled = !!data['enabled'];
  var lastfmApiKey = (data['lastfmApiKey'] || '').trim();
  var autoReplayGain = !!data['autoReplayGain'];
  var excludeKeywords = (data['excludeKeywords'] || '').trim();

  if (enabled && !lastfmApiKey) {
    self.commandRouter.pushToastMessage('error', 'AutoDJ', 'A Last.fm API key is required to enable AutoDJ.');
    enabled = false;
  }

  self.config.set('enabled', enabled);
  self.config.set('intervalSeconds', intervalSeconds);
  self.config.set('lastfmApiKey', lastfmApiKey);
  self.config.set('artistHistorySize', artistHistorySize);
  self.config.set('autoReplayGain', autoReplayGain);
  self.config.set('autoCrossfadeSeconds', autoCrossfadeSeconds);
  self.config.set('excludeKeywords', excludeKeywords);
  self.config.set('maxTrackMinutes', maxTrackMinutes);
  STREAMS.forEach(function (s) {
    self.config.set(s.key, !!data[s.key]);
  });

  if (enabled) {
    self.startTimer();
    self.commandRouter.pushToastMessage('success', 'AutoDJ', 'Enabled - checking the queue every ' + intervalSeconds + 's.');
  } else {
    self.stopTimer();
    self.commandRouter.pushToastMessage('success', 'AutoDJ', 'Disabled.');
  }

  defer.resolve({});
  return defer.promise;
};

// Status and on/off for other frontends (e.g. a web app's repeat button),
// without touching any other setting:
//   {}                          -> {enabled, ready}
//   {"enabled": true|false}     -> switch, then the same answer
// "ready" is false while no Last.fm API key is set (AutoDJ can't be
// enabled then, same rule as on the settings page).
ControllerAutoDJ.prototype.status = function () {
  var self = this;
  return {
    enabled: !!self.config.get('enabled'),
    ready: !!(self.config.get('lastfmApiKey') || '').trim()
  };
};

ControllerAutoDJ.prototype.setEnabled = function (enabled) {
  var self = this;
  var st = self.status();
  if (enabled && !st.ready) return st;
  if (enabled === st.enabled) return st;
  self.config.set('enabled', enabled);
  if (enabled) self.startTimer();
  else self.stopTimer();
  return self.status();
};

ControllerAutoDJ.prototype.restApi = function (data) {
  var self = this;
  if (data && typeof data.enabled === 'boolean') {
    return libQ.resolve(self.setEnabled(data.enabled));
  }
  return libQ.resolve(self.status());
};

// -----------------------------------------------------------------------
// Scheduling
// -----------------------------------------------------------------------
ControllerAutoDJ.prototype.startTimer = function () {
  var self = this;

  self.stopTimer();
  self.runTick();

  var intervalMs = (parseInt(self.config.get('intervalSeconds'), 10) || 90) * 1000;
  self.timer = setInterval(function () {
    self.runTick();
  }, intervalMs);

  self.startWatcher();
};

ControllerAutoDJ.prototype.stopTimer = function () {
  var self = this;

  if (self.timer) {
    clearInterval(self.timer);
    self.timer = null;
  }

  self.stopWatcher();
};

// Runs the bundled script's lightweight "--watch-boundary" mode as a
// persistent background process (the systemd service volumio-autodj-watch,
// see WATCH_UNIT), separate from the main runTick() interval
// above. Reacting to playback actually reaching an AutoDJ-mixed track
// promptly (to avoid switching replay gain/crossfade on mid-song, well
// after the track started) needs a much shorter poll interval than the
// queue-refill logic needs or should run at - see "Avoiding a mid-song
// volume jump" in the volumio-autodj README. Only started when there's
// actually something for it to do.
ControllerAutoDJ.prototype.startWatcher = function () {
  var self = this;

  if (!self.config.get('autoReplayGain') && !self.config.get('autoCrossfadeSeconds')) {
    self.stopWatcher();
    return;
  }

  var env = [
    'VOLUMIO_HOST=localhost',
    'AUTO_REPLAYGAIN=' + (self.config.get('autoReplayGain') ? 'on' : 'off'),
    'AUTO_CROSSFADE=' + (self.config.get('autoCrossfadeSeconds') || 'off')
  ].join('\n') + '\n';
  try {
    fs.ensureDirSync(WATCH_ENV_DIR);
    fs.writeFileSync(WATCH_ENV, env);
  } catch (e) {
    self.logger.error('[volumio_autodj] cannot write ' + WATCH_ENV + ': ' + e.message);
    return;
  }

  // restart, not start: picks up changed settings when it is already running
  self.systemctl('restart', function (error) {
    if (error) {
      self.logger.error('[volumio_autodj] boundary watcher did not start: ' + error.message);
    } else {
      self.watcherRunning = true;
    }
  });
};

ControllerAutoDJ.prototype.stopWatcher = function () {
  var self = this;

  self.watcherRunning = false;
  self.systemctl('stop', function () {});
};

// As in Volumio's own examples: systemctl via sudo (-n: never wait for a
// password prompt).
ControllerAutoDJ.prototype.systemctl = function (action, cb) {
  execFile('/usr/bin/sudo', ['-n', '/bin/systemctl', action, WATCH_UNIT], { timeout: 15000 }, function (error) {
    cb(error || null);
  });
};

// Runs the bundled volumio-autodj-local.sh once, with settings from this
// plugin's config passed in as environment variables. All the actual
// AutoDJ logic (reading the queue, asking Last.fm for similar artists,
// matching against the local library, the repeat guard, appending to the
// queue) lives in that script - kept in sync with the standalone
// volumio-autodj-local.sh in the sibling Celindir69/volumio-autodj repo -
// rather than being reimplemented here, so it stays exactly as tested
// against a real Volumio instance.
// Volumio "service" names of the streaming services switched on in the
// settings, in priority order - the script's STREAM_SERVICES (empty = local
// library only).
ControllerAutoDJ.prototype.streamServices = function () {
  var self = this;
  return STREAMS.filter(function (s) {
    return self.config.get(s.key) !== false;
  }).map(function (s) {
    return s.services;
  }).join(' ');
};

ControllerAutoDJ.prototype.runTick = function () {
  var self = this;

  var lastfmApiKey = self.config.get('lastfmApiKey');
  if (!lastfmApiKey) {
    self.logger.warn('[volumio_autodj] No Last.fm API key configured - skipping run');
    return;
  }

  var scriptPath = __dirname + '/volumio-autodj-local.sh';
  var env = Object.assign({}, process.env, {
    VOLUMIO_HOST: 'localhost',
    LASTFM_API_KEY: lastfmApiKey,
    ARTIST_HISTORY_SIZE: String(self.config.get('artistHistorySize') || 4),
    AUTO_REPLAYGAIN: self.config.get('autoReplayGain') ? 'on' : 'off',
    AUTO_CROSSFADE: self.config.get('autoCrossfadeSeconds') || 'off',
    EXCLUDE_KEYWORDS: self.config.get('excludeKeywords') || '',
    MAX_TRACK_MINUTES: String(self.maxTrackMinutes()),
    STREAM_SERVICES: self.streamServices()
  });

  // Backstop on top of the script's own SEARCH_DEADLINE_SECONDS budget
  // (25s, bounding the candidate/Tidal-fallback search) - leaves headroom
  // for the rest of the run (initial Last.fm call, MPD queries,
  // addToQueue, history writes, replay gain/crossfade sync), which should
  // normally finish within a few seconds on top of that budget.
  execFile('/bin/bash', [scriptPath], { env: env, timeout: 60000 }, function (error, stdout, stderr) {
    // The script logs every step to its own debug log file
    // (/data/volumio_autodj_data/autodj.debug.log) and to stderr. Volumio's
    // own log only gets something when a run fails - then its last lines,
    // so the cause is visible there too - not the routine output of a run
    // every 90 seconds.
    if (error) {
      self.logger.error('[volumio_autodj] run failed: ' + error.message);
      String(stderr || '').trim().split('\n').slice(-10).forEach(function (line) {
        if (line) self.logger.error('[volumio_autodj] ' + line);
      });
    }
  });
};
