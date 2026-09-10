# AutoDJ - Continuous Play (Volumio Plugin)

A [Volumio](https://volumio.org/) plugin that keeps the play queue topped
up automatically: once the queue is about to run out, it appends a track
by an artist similar to what's currently playing (via the
[Last.fm](https://www.last.fm/api/account/create) API), matched against
your local library - a settings page in the Volumio UI instead of
managing cron/systemd and environment variables by hand.

Settings page (**Settings → Plugins → Installed Plugins → AutoDJ -
Continuous Play**):
- **Enabled** - on/off switch.
- **Check interval (seconds)** - how often to check the queue.
- **Last.fm API key** - free, from https://www.last.fm/api/account/create.
- **Artist repeat guard size** - how many recently-used artists to
  remember and avoid repeating right away (the exact same track is
  separately guarded for longer - see the volumio-autodj README).
- **Auto volume normalization** - off by default. When on, turns
  Volumio's volume normalization on once AutoDJ starts mixing artists
  into the queue, and back off at the next freshly-started queue -
  respecting any manual change you make in the meantime. See "Volume
  normalization" in the volumio-autodj README for the full behavior.

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

## Logs

Plugin logs appear in Volumio's own plugin log (`journalctl -u volumio -f`
while it's running, or via the Volumio UI's log viewer) - each run's
output is prefixed `[volumio_autodj]` - in addition to the bundled
script's own debug log at `/data/volumio_autodj_data/autodj.debug.log`.

## License

Do whatever you want with it.
