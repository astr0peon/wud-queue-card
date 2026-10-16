# WUD Queue card

Home Assistant dashboard card for What's Up Docker's container updates, grouped by compose project, with an install
button on each row, and a queue that installs them one at a time with the WUD Queue integration.

[![GitHub Release][releases-shield]][releases] [![GitHub Release Date][release-date-shield]][releases] [![HACS][hacs-shield]][hacs] [![License][license-shield]](LICENSE)

<p>
<img src="https://raw.githubusercontent.com/jesmak/wud-queue-card/main/docs/images/waiting-light.png#gh-light-mode-only" width="400" alt="Four containers waiting for an update, a compose project's services grouped under its name with their old and new versions and an install button on each">
<img src="https://raw.githubusercontent.com/jesmak/wud-queue-card/main/docs/images/waiting-dark.png#gh-dark-mode-only" width="400" alt="Four containers waiting for an update, a compose project's services grouped under its name with their old and new versions and an install button on each">
<img src="https://raw.githubusercontent.com/jesmak/wud-queue-card/main/docs/images/queue-light.png#gh-light-mode-only" width="400" alt="A queue running, with a progress bar of four segments, one container updated, a group of services updating two of five, and two containers queued">
<img src="https://raw.githubusercontent.com/jesmak/wud-queue-card/main/docs/images/queue-dark.png#gh-dark-mode-only" width="400" alt="A queue running, with a progress bar of four segments, one container updated, a group of services updating two of five, and two containers queued">
</p>

## What is it?

A custom card for the containers [What's Up Docker](https://github.com/getwud/wud) (WUD) watches. It lists the
updates waiting, each with its installed and new version and a button that installs it, and the containers that are
already up to date. Only one of the two lists is open at a time, and the other folds into a single line that opens it.

Containers are grouped by their compose project. Services of one project that run the same image, such as five
workers built on one Node image, are a single row and are installed together, so their lines in the compose file stay
in step. WUD's own container always comes last, since updating it restarts WUD in the middle of whatever else is
going on.

On its own, the card installs one row at a time and follows each install it starts. WUD itself reports no failures, so
the card works them out. An install that never starts, or one that ends with the container still on its old version,
is shown as failed on its row.

With the [WUD Queue](https://github.com/jesmak/wud_queue) integration, the card becomes the queue's dashboard. Its
buttons add rows to a queue in Home Assistant, which installs them one at a time even with the browser closed, stops
at the first failure, and fires events an automation can act on. "Update all" queues everything waiting, and every
open dashboard shows the same queue. The integration is optional. The card finds it by itself when it is installed.

## Installation

### With HACS

1. Add this repository to HACS custom repositories with type **Dashboard**
2. Search for WUD Queue card in HACS and download it
3. Refresh your browser

### Manual

1. Take `dist/wud-queue-card.js` from the source code of the [latest release][releases] and copy it to the
   `config/www` folder of your Home Assistant installation
2. In Home Assistant settings, open dashboards, click the three dots at the top right and open resources
3. Add a new resource with the path `/local/wud-queue-card.js` and type JavaScript
4. Refresh your browser

For the queue, install the [WUD Queue](https://github.com/jesmak/wud_queue) integration as its README describes. The
card needs no setting for it.

### What WUD needs

The card reads the update entities WUD creates through MQTT discovery, so WUD needs its
[Home Assistant MQTT trigger](https://getwud.github.io/wud/configuration/triggers/homeassistant-mqtt/) with discovery
on, and Home Assistant needs the MQTT integration:

```yaml
environment:
  - WUD_TRIGGER_MQTT_HASS_URL=mqtt://homeassistant.local:1883
  - WUD_TRIGGER_MQTT_HASS_HASS_ENABLED=true
  - WUD_TRIGGER_MQTT_HASS_HASS_DISCOVERY=true
```

Leave `WUD_TRIGGER_MQTT_<name>_HASS_ENTITIES` at its default, `all`. In `summary` mode WUD makes a single sensor
instead of an update entity per container, and the card has nothing to show.

The install buttons work when WUD has a trigger that can update the container, such as its Docker or Docker Compose
trigger. Without one, WUD receives the install and does nothing.

The card tells a finished install from a failed one by the container's new version, which WUD notices right away from
Docker's events. Keep `WUD_WATCHER_<name>_WATCHEVENTS` at its default, `true`. Without the events WUD sees the new
version only at its next scheduled watch, and until then the card shows an install that worked as failed.

## Options

| Name       | Type   | Default                       | Description                                                   |
| ---------- | ------ | ----------------------------- | ------------------------------------------------------------- |
| `type`     | string | required                      | `custom:wud-queue-card`                                       |
| `title`    | string | Docker containers, translated | Shown at the top of the card                                  |
| `device`   | string | every WUD update entity       | The id of a WUD device, whose update entities the card shows  |
| `entities` | list   | found by the card             | The update entities to show, instead of the card finding them |
| `exclude`  | list   |                               | Update entities never shown, whether found or listed          |
| `height`   | number | fits the content              | The card's height in pixels. The open list scrolls inside it  |

Every option is in the visual editor. Without `device` or `entities`, the card shows every update entity WUD has
made, from all its watchers. WUD makes a device per watcher, so `device` limits the card to one Docker host. The
visual editor picks the device by its name and stores its id.

## What it shows

Under the title, one line tells what is going on. It names the container being updated or the one that failed, or
says that updates are available or that everything is up to date. Then come the two lists.

- **Waiting for an update.** One row per container, or per group of services that run the same image and are headed
  for the same version, with its installed and new version and an install button. Services on different tags of
  one image, such as two PostgreSQL versions, are rows of their own. A compose project with several rows shows its name with a guide line down
  its rows, and its up-to-date services as thin rows among them, so the whole project is in view. Rows are in the
  order they would best be installed, WUD's own last.
- **Up to date.** The rest, grouped the same way, with their versions.

Each WUD watcher is a Docker host of its own, and its projects are kept apart from the other hosts' even when they
share a name. When the card shows several watchers, each project's name is followed by its watcher's.

When nothing is waiting, the card is just the title and a line that opens the up-to-date list. When the first update
comes in, the waiting list opens by itself, even if the up-to-date list was open.

<img src="https://raw.githubusercontent.com/jesmak/wud-queue-card/main/docs/images/all-current-light.png#gh-light-mode-only" width="490" alt="A card with all containers up to date, folded into a single line">
<img src="https://raw.githubusercontent.com/jesmak/wud-queue-card/main/docs/images/all-current-dark.png#gh-dark-mode-only" width="490" alt="A card with all containers up to date, folded into a single line">

Clicking a row, or pressing Enter on it, opens its update entity's dialog.

## Installing updates

### Without the integration

The install button calls `update.install` on the row's update entities. A row of several services sends them all in
one call, and WUD installs them one after another. While anything is installing, the other buttons are locked, so
installs never pile up in WUD at once.

The row shows its progress while the card is open:

- **Updating**, from the moment the button is pressed. For a group of services, how many are done.
- **Updated**, with the version it moved from, once every container is on its new version.
- **Failed**, with the reason, when Home Assistant refuses to send the install, when WUD hasn't started it within a
  minute, or when it has finished but the container is still on its old version two minutes later. WUD's own log has
  the details. The install button comes back, so the row can be tried again. A row that gets its new version some
  other way meanwhile shows as updated after all.

An updated row stays in the waiting list for ten minutes, or until an even newer version comes out, and then moves
to the up-to-date list. The card remembers only the installs it started, and only until the page is reloaded. An
install started elsewhere, such as from Home Assistant's own update dialog, shows as updating while WUD runs it, but
its outcome isn't followed.

### With the WUD Queue integration

The install buttons add their rows to the queue instead, and stay usable while it runs. They pause while the queue
stops, while a row is being added, and while the integration starts up, so nothing goes around the queue. When the
queue refuses a row, Home Assistant's own notice says why. A thin bar under the title
has a segment for each row in the queue, and the rows show **Queued**, **Updating**, **Updated**, **Failed** or
**Not installed**. The button in the header does what fits the moment:

- **Update all** queues every row waiting.
- **Stop queue** lets the row being installed finish and leaves the rest.
- **Retry**, after a failure, queues the failed row and the ones that didn't run, and starts again.
- **Clear**, when everything queued is done, puts the finished rows away. The queue does it by itself ten minutes
  after it finishes. It also takes Retry's place when a failed run has nothing left to install, as when its
  containers have got their new versions some other way.

A row whose containers are on the versions the queue was installing shows as updated, even if the queue gave up on
it, as it can when WUD notices a new version late.

<img src="https://raw.githubusercontent.com/jesmak/wud-queue-card/main/docs/images/failed-light.png#gh-light-mode-only" width="490" alt="A queue stopped by a failure, the failed row red with the reason, the rows after it not installed, and Retry in the header">
<img src="https://raw.githubusercontent.com/jesmak/wud-queue-card/main/docs/images/failed-dark.png#gh-dark-mode-only" width="490" alt="A queue stopped by a failure, the failed row red with the reason, the rows after it not installed, and Retry in the header">

The queue's own README tells how it decides an install failed, and what its events carry.

## Sizes

In a sections view the card takes 12 columns by default and at least 6, and grows as tall as its open list. It works
at any width. On a narrow card long versions move under the container's name, and on a wide one a waiting row's
versions sit beside its name, next to the install button.

<img src="https://raw.githubusercontent.com/jesmak/wud-queue-card/main/docs/images/narrow-light.png#gh-light-mode-only" width="250" alt="The queue on a card half a section wide, the long versions of a group of services wrapped under its name beside the Updating pill">
<img src="https://raw.githubusercontent.com/jesmak/wud-queue-card/main/docs/images/narrow-dark.png#gh-dark-mode-only" width="250" alt="The queue on a card half a section wide, the long versions of a group of services wrapped under its name beside the Updating pill">

Set `height` to give the card a height of its own, so that a long list doesn't make it taller than the rest of the
dashboard. The title and the section lines stay where they are, and the open list scrolls in what is left. The same
happens when the card's rows are set in a sections view.

## Examples

### Every container WUD watches

```yaml
type: custom:wud-queue-card
```

### One Docker host, without the database

```yaml
type: custom:wud-queue-card
title: Media server
device: 4f1c0d2e9b7a4c3e8d6f5a1b2c3d4e5f
exclude:
  - update.wud_local_db
height: 400
```

The device's id is easiest to pick in the visual editor.

### A few chosen containers

```yaml
type: custom:wud-queue-card
title: Web
entities:
  - update.wud_local_shop_api
  - update.wud_local_shop_worker
  - update.wud_local_shop_db
```

## Data

The card reads the update entities WUD publishes over MQTT. It takes their installed and latest versions, whether an
install is running, and the attributes WUD adds to them, such as the compose project, service and image. With the
integration it also reads the queue's sensor, which it finds in the entity registry by the integration's name. It
fetches nothing itself, and talks to WUD only through `update.install` or the queue's actions.

## Translating

The card's texts are in `src/localize/languages/`, one JSON file per language, named by its language code, such as
`en.json` and `fi.json`. To add a language, copy `en.json` to the new language's code, such as `sv.json`, and
translate the values. Nothing else needs changing. The card finds the file by itself and uses it when Home Assistant
is set to that language. A text left out falls back to English. Container, project and version names come from WUD
as they are.

## Development

Requires Node 22.13 or newer.

```
npm install
npm run check
```

`npm run check` typechecks, lints, checks formatting, runs the tests and builds `dist/wud-queue-card.js`, which is
the file HACS installs and is committed to the repository.

| Path                       | What it contains                                                     |
| -------------------------- | -------------------------------------------------------------------- |
| `src/wud-queue-card.ts`    | The card itself                                                      |
| `src/editor.ts`            | The visual editor                                                    |
| `src/containers.ts`        | Reading WUD's update entities, grouping them, and following installs |
| `src/types.ts`             | The card's options and the shapes of what it shows                   |
| `src/const.ts`             | The timings for following an install                                 |
| `src/hass.ts`              | The few Home Assistant types the card needs                          |
| `src/localize/localize.ts` | Finding the viewer's language and its texts                          |
| `scripts/build.mjs`        | The esbuild build                                                    |
| `src/localize/languages/`  | The card's texts, one JSON file per language                         |
| `docs/screenshots.json`    | The made-up data the README's screenshots are taken from             |
| `tests/`                   | Tests, run with vitest                                               |

## Support

Hey dude! Help me out for a couple of :beers: or a :coffee:!

[![coffee](https://www.buymeacoffee.com/assets/img/custom_images/black_img.png)](https://www.buymeacoffee.com/jesmak)

## License

MIT, see [LICENSE](LICENSE).

[releases-shield]: https://img.shields.io/github/release/jesmak/wud-queue-card.svg?style=for-the-badge
[release-date-shield]: https://img.shields.io/github/release-date/jesmak/wud-queue-card?style=for-the-badge
[releases]: https://github.com/jesmak/wud-queue-card/releases
[hacs-shield]: https://img.shields.io/badge/HACS-Custom-orange.svg?style=for-the-badge
[hacs]: https://hacs.xyz/docs/faq/custom_repositories/
[license-shield]: https://img.shields.io/github/license/jesmak/wud-queue-card.svg?style=for-the-badge
