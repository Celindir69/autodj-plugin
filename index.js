'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var path = require('path');
var execFile = require('child_process').execFile;
var spawn = require('child_process').spawn;

module.exports = ControllerAutoDJ;

function ControllerAutoDJ(context) {
  var self = this;

  self.context = context;
  self.commandRouter = self.context.coreCommand;
  self.logger = self.context.logger;
  self.configManager = self.context.configManager;

  self.timer = null;
  self.watchProcess = null;
  self.watcherIntentionallyStopped = true;
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
  fs.ensureDirSync(path.dirname(configFile));

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

  return libQ.resolve();
};

ControllerAutoDJ.prototype.onStart = function () {
  var self = this;

  if (self.config.get('enabled')) {
    self.startTimer();
  }

  return libQ.resolve();
};

ControllerAutoDJ.prototype.onStop = function () {
  var self = this;

  self.stopTimer();

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

  var uiconf = fs.readJsonSync(__dirname + '/UIConfig.json');

  uiconf.sections[0].content[0].value = self.config.get('enabled');
  uiconf.sections[0].content[1].value = String(self.config.get('intervalSeconds'));
  uiconf.sections[0].content[2].value = self.config.get('lastfmApiKey');
  uiconf.sections[0].content[3].value = String(self.config.get('artistHistorySize'));
  uiconf.sections[0].content[4].value = self.config.get('autoReplayGain');
  uiconf.sections[0].content[5].value = String(self.config.get('autoCrossfadeSeconds'));

  defer.resolve(uiconf);
  return defer.promise;
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

  var enabled = !!data['enabled'];
  var lastfmApiKey = (data['lastfmApiKey'] || '').trim();
  var autoReplayGain = !!data['autoReplayGain'];

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
// persistent background process, separate from the main runTick() interval
// above. Reacting to playback actually reaching an AutoDJ-mixed track
// promptly (to avoid switching replay gain/crossfade on mid-song, well
// after the track started) needs a much shorter poll interval than the
// queue-refill logic needs or should run at - see "Avoiding a mid-song
// volume jump" in the volumio-autodj README. Only spawned when there's
// actually something for it to do.
ControllerAutoDJ.prototype.startWatcher = function () {
  var self = this;

  if (!self.config.get('autoReplayGain') && !self.config.get('autoCrossfadeSeconds')) {
    return;
  }

  self.stopWatcher();

  var scriptPath = __dirname + '/volumio-autodj-local.sh';
  var env = Object.assign({}, process.env, {
    VOLUMIO_HOST: 'localhost',
    AUTO_REPLAYGAIN: self.config.get('autoReplayGain') ? 'on' : 'off',
    AUTO_CROSSFADE: self.config.get('autoCrossfadeSeconds') || 'off'
  });

  self.watcherIntentionallyStopped = false;
  // Captured in a closure and compared by identity in the "exit" handler
  // below, rather than trusting self.watchProcess at the time exit fires:
  // stopWatcher()/startWatcher() clear/replace that reference SYNCHRONOUSLY,
  // but a killed process's own "exit" event only arrives later, ASYNCHRONOUSLY
  // - so a belated exit from an OLDER generation (e.g. this same function
  // called again in quick succession, such as from saveSettings()) would
  // otherwise null out the reference to a NEWER, still-running process, or
  // schedule a bogus "unexpected exit" restart for a process we killed on
  // purpose (confirmed by an isolated test: calling startWatcher() twice in
  // a row orphaned the second, still-running process this way).
  var child = spawn('/bin/bash', [scriptPath, '--watch-boundary'], { env: env });
  self.watchProcess = child;

  child.on('error', function (error) {
    self.logger.error('[volumio_autodj] boundary watcher failed to start: ' + error.message);
  });

  child.stderr.on('data', function (data) {
    String(data).trim().split('\n').forEach(function (line) {
      if (line) self.logger.info('[volumio_autodj] ' + line);
    });
  });

  child.on('exit', function (code, signal) {
    if (self.watchProcess !== child) return;
    self.watchProcess = null;
    if (self.watcherIntentionallyStopped) return;
    // Unexpected exit (crash, killed by something else) rather than our
    // own stopWatcher() - restart it after a short delay rather than
    // leaving replay gain/crossfade timing broken silently until the next
    // plugin restart. The delay avoids hammering a device that's actually
    // in trouble (e.g. MPD itself down) with a tight respawn loop.
    self.logger.warn('[volumio_autodj] boundary watcher exited unexpectedly (code=' + code + ', signal=' + signal + ') - restarting in 10s');
    setTimeout(function () {
      if (!self.watcherIntentionallyStopped) self.startWatcher();
    }, 10000);
  });
};

ControllerAutoDJ.prototype.stopWatcher = function () {
  var self = this;

  self.watcherIntentionallyStopped = true;
  if (self.watchProcess) {
    self.watchProcess.kill();
    self.watchProcess = null;
  }
};

// Runs the bundled volumio-autodj-local.sh once, with settings from this
// plugin's config passed in as environment variables. All the actual
// AutoDJ logic (reading the queue, asking Last.fm for similar artists,
// matching against the local library, the repeat guard, appending to the
// queue) lives in that script - kept in sync with the standalone
// volumio-autodj-local.sh in the sibling Celindir69/volumio-autodj repo -
// rather than being reimplemented here, so it stays exactly as tested
// against a real Volumio instance.
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
    AUTO_CROSSFADE: self.config.get('autoCrossfadeSeconds') || 'off'
  });

  execFile('/bin/bash', [scriptPath], { env: env, timeout: 45000 }, function (error, stdout, stderr) {
    if (stderr) {
      // The script logs its own timestamped lines to stderr (as well as
      // its own debug log file under /data/volumio_autodj_data/) - surface
      // them in Volumio's own plugin log too.
      String(stderr).trim().split('\n').forEach(function (line) {
        if (line) self.logger.info('[volumio_autodj] ' + line);
      });
    }
    if (error) {
      self.logger.error('[volumio_autodj] run failed: ' + error.message);
    }
  });
};
