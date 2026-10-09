# AutoDJ - Continuous Play (Volumio Plugin)

A [Volumio](https://volumio.org/) plugin that keeps the play queue topped
up automatically: once the queue is about to run out, it appends a track
by an artist similar to what's currently playing (via the
[Last.fm](https://www.last.fm/api/account/create) API), matched against
your local library (and, if the artist isn't found locally, against
TIDAL, Qobuz, HIGHRESAUDIO or Spotify too, whichever you have set up as a
Volumio source - see "Streaming fallback" in the volumio-autodj README) -
a settings page in the
Volumio UI instead of managing cron/systemd and environment variables by
hand.

Developed using AI (Claude code https://claude.ai)

Settings page (**Settings → Plugins → Installed Plugins → AutoDJ -
Continuous Play**):
- **Enabled** - on/off switch.
- **Check interval (seconds)** - how often to check the queue.
- **Last.fm API key** - free, from https://www.last.fm/api/account/create.
- **Artist repeat guard size** - how many recently-used artists to
  remember and avoid repeating right away (the exact same track is
  separately guarded for longer - see the volumio-autodj README).
- **Auto volume normalization** - off by default. When on, turns
  Volumio's volume normalization on once playback actually reaches the
  first AutoDJ-mixed track (not merely once AutoDJ appends it - the
  tail of a curated album/playlist you queued yourself is never affected),
  and back off at the next freshly-started queue - respecting any manual
  change you make in the meantime. See "Volume normalization" in the
  volumio-autodj README for the full behavior.
- **Auto crossfade (seconds)** - empty/off by default. Same on/off
  behavior and timing as Auto volume normalization above, for MPD's
  crossfade instead - enter a number of seconds to enable it. See
  "Crossfade" in the volumio-autodj README for the full behavior.
- **Exclude keywords** - empty by default. Semicolon-separated words/
  phrases (e.g. `Live;Tubular Bells;Ommadawn`) - any candidate track whose
  title OR album contains one of these, case-insensitively, is skipped
  entirely. Handy for keeping live recordings or specific long-form albums
  out of the mix. Plain substring match, not a full filter - a short word
  can have false positives (`Live` also matches an album called `Olive
  Grove`).
- **Use TIDAL / Use Qobuz / Use HIGHRESAUDIO / Use Spotify** - all on by
  default. For an artist that isn't in your local library, also look for
  their tracks on that service; each only has an effect if the service is
  set up in Volumio, and a local match always wins. If several services
  have the artist, the first one in this order is used. Spotify needs
  Volumio's Spotify plugin with search (Spotify Connect alone has none).
  Turn all four off for local library only.

Whenever either of the replay gain/crossfade switch is on, the plugin 
also runs a small background watcher alongside its main timer
 - a separate, much more frequent check
(every few seconds, not every `intervalSeconds`) purely to catch the exact
moment playback reaches the mixed-in content, so replay gain/crossfade
switch on right at that track change instead of landing mid-song on
whichever tick happens to run next. Fully automatic: started/stopped along
with "Enabled", no separate setting. See "Avoiding a mid-song volume jump"
in the volumio-autodj README for how it works.

It still needs SSH access for the one-time install (Volumio has no
"install from a private/local zip" button in the UI), but no SSH - or
terminal at all - for day-to-day use afterwards: the plugin runs its own
internal timer (started/stopped right from its settings page), so no cron
or systemd timer needs to be set up separately.

If you don't have SSH access to Volumio at all, see the standalone
[volumio-autodj](https://github.com/Celindir69/volumio-autodj) scripts
instead - `volumio-autodj.sh` runs on a different device on the same
network and talks to Volumio only over the network.

## How it works

Deliberately a thin wrapper rather than a reimplementation: `index.js`
handles the Volumio plugin lifecycle, the settings page, and scheduling (a
plain `setInterval` started/stopped from the "Enabled" switch), and on
each tick it runs the bundled `volumio-autodj-local.sh` (kept in sync with
the standalone script in the sibling
[volumio-autodj](https://github.com/Celindir69/volumio-autodj) repository)
with the settings passed in as environment variables - the actual AutoDJ
logic itself isn't reimplemented here, so it behaves exactly like the
tested standalone script. See that repository's README for the full
details of how a seed artist is picked, the repeat guard, and known
device quirks.

## Switching it from other frontends

Besides its settings page, the plugin offers a small REST endpoint so other
frontends (for example a web app's repeat button) can show and switch
"Enabled" without touching any other setting:

```bash
# status: {"success":true,"data":{"enabled":false,"ready":true}}
curl -s -X POST -H 'Content-Type: application/json' -d '{"endpoint":"autodj","data":{}}' http://<volumio>/api/v1/pluginEndpoint
# on (off: false)
curl -s -X POST -H 'Content-Type: application/json' -d '{"endpoint":"autodj","data":{"enabled":true}}' http://<volumio>/api/v1/pluginEndpoint
```

`ready` is `false` while no Last.fm API key is set; switching on is ignored
then, just like on the settings page. The settings page shows the new state
the next time it is opened.

## Install (via SSH)

```bash
scp -r autodj-plugin volumio@<volumio-ip>:/home/volumio/
ssh volumio@<volumio-ip>
cd /home/volumio/autodj-plugin
volumio plugin install
```
Then open **Settings → Plugins → Installed Plugins → AutoDJ - Continuous
Play** in the Volumio UI, enter your Last.fm API key, adjust the interval/
repeat-guard size if you like, and switch it on.

### Installing on Volumio 2 / OEM devices

On some Volumio 2 OEM builds (confirmed on a Musical Fidelity MX-Stream),
`volumio plugin install` hangs forever with no error and no log output, for
reasons unrelated to this plugin's own code. See
[`docs/volumio2-mxstream-install.md`](docs/volumio2-mxstream-install.md) for
what's actually happening and a working install script
(`scripts/install-mxstream.sh`) that bypasses it.

## Logs

Plugin logs appear in Volumio's own plugin log (`journalctl -u volumio -f`
while it's running, or via the Volumio UI's log viewer) - each run's
output is prefixed `[volumio_autodj]` - in addition to the bundled
script's own debug log at `/data/volumio_autodj_data/autodj.debug.log`.

## License

Do whatever you want with it.
