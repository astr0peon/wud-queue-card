/**
 * Reading What's Up Docker's update entities: which ones the card shows, how they group into compose
 * projects and rows, and how an install the card started is going.
 *
 * WUD writes every container's details into its update entity's attributes (`stack`, `image_name`, the
 * compose labels and so on), so nothing here needs setting up per container.
 */
import { START_TIMEOUT, VERSION_GRACE } from "./const";
import type { HassEntity, HomeAssistant } from "./hass";
import type { Container, Project, Queue, RowStatus, Unit, WudQueueCardConfig } from "./types";

/** WUD's own image, by its current name and the one it had before moving to getwud. */
const WUD_IMAGE = /(^|\/)(getwud\/wud|fmartinou\/whats-up-docker)$/;

/** An update entity WUD made: one with a container's watcher and image in it. */
export function isWud(entity: HassEntity | undefined): boolean {
    return (
        !!entity &&
        entity.entity_id.startsWith("update.") &&
        typeof entity.attributes.watcher === "string" &&
        typeof entity.attributes.image_name === "string"
    );
}

/**
 * The short-lived container WUD starts to replace itself is left behind after a self-update, with an
 * update entity of its own, named like `wud-wud-self-update-1791730329826`. It is never something to install.
 */
function isSelfUpdateHelper(entity: HassEntity): boolean {
    return /-self-update-\d+$/.test(String(entity.attributes.name ?? ""));
}

/** Every WUD update entity, for the editor and for a card set to find them itself. */
export function wudEntities(hass: HomeAssistant, device?: string): string[] {
    return Object.keys(hass.states)
        .filter((id) => isWud(hass.states[id]) && !isSelfUpdateHelper(hass.states[id] as HassEntity))
        .filter((id) => !device || hass.entities?.[id]?.device_id === device)
        .sort();
}

/** The entities the card shows: the listed ones, or the ones it finds, without the excluded ones. */
export function selectedEntities(hass: HomeAssistant, config: WudQueueCardConfig): string[] {
    const exclude = new Set(config.exclude ?? []);
    const ids = config.entities?.length ? config.entities : wudEntities(hass, config.device);
    return ids.filter((id) => {
        const entity = hass.states[id];
        return !exclude.has(id) && isWud(entity) && !isSelfUpdateHelper(entity as HassEntity);
    });
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/** A container from its update entity, or nothing while the entity is unavailable. */
export function containerOf(entity: HassEntity): Container | undefined {
    if (entity.state !== "on" && entity.state !== "off") {
        return undefined;
    }
    const a = entity.attributes;
    return {
        entity_id: entity.entity_id,
        watcher: text(a.watcher),
        stack: text(a.stack) || text(a.labels_com_docker_compose_project),
        // A name given with WUD's own label wins; WUD's default display name is the container's, which
        // compose fills with the project and a number.
        name:
            text(a.labels_wud_display_name) ||
            text(a.labels_com_docker_compose_service) ||
            text(a.display_name) ||
            text(a.name) ||
            entity.entity_id,
        image: text(a.image_name),
        installed: text(a.installed_version),
        latest: text(a.latest_version),
        pending: entity.state === "on",
        // WUD sets this while it installs. Home Assistant turns a percentage into true, and gives the number as
        // update_percentage. After WUD has replaced itself its entity keeps saying so, so only a container still without
        // its update counts.
        installing: entity.state === "on" && a.in_progress === true,
    };
}

function byName<T extends { name: string }>(a: T, b: T): number {
    return a.name.localeCompare(b.name);
}

/**
 * The containers grouped into compose projects, and within a project into units: the services that run
 * the same image and are headed for the same version are one unit. A project's units are sorted by name,
 * and so are the projects, except that the project with WUD's own container goes last and WUD's unit last
 * in it. That is the order the updates should be installed in.
 *
 * Projects are per watcher, as each watcher is a Docker host of its own. When the card shows several, the
 * watcher's name follows the project's.
 */
export function projectsOf(containers: Container[]): Project[] {
    const watchers = new Set(containers.map((c) => c.watcher)).size > 1;
    const projects = new Map<string, Container[]>();
    for (const container of containers) {
        // A container started without compose is a project of its own.
        const key = `${container.watcher}|${container.stack || `:${container.entity_id}`}`;
        projects.set(key, [...(projects.get(key) ?? []), container]);
    }

    const result = [...projects.entries()].map(([key, members]): Project => {
        const host = watchers && members[0].watcher ? ` (${members[0].watcher})` : "";
        const name = (members[0].stack || members[0].name) + host;
        // The version is part of the key, so that one image on two tags makes two rows, and a row the card
        // has installed becomes a new row when an even newer version comes out.
        const images = new Map<string, Container[]>();
        for (const container of members) {
            const image = `${container.image || container.entity_id}@${container.latest}`;
            images.set(image, [...(images.get(image) ?? []), container]);
        }
        const single = images.size === 1;
        const units = [...images.entries()].map(([unitKey, list]): Unit => {
            const sorted = [...list].sort(byName);
            const image = list[0].image || list[0].entity_id;
            return {
                key: `${key}/${unitKey}`,
                // A unit of several services is named after its project when it is all there is in it,
                // otherwise after its image.
                name: sorted.length === 1 ? sorted[0].name : single ? name : (image.split("/").pop() ?? image),
                containers: sorted,
                pending: sorted.some((c) => c.pending),
                installing: sorted.some((c) => c.installing),
                wud: WUD_IMAGE.test(image),
            };
        });
        // A project of one container shows as that container's row, which then carries the watcher.
        if (units.length === 1 && units[0].containers.length === 1) {
            units[0].name += host;
        }
        units.sort((a, b) => Number(a.wud) - Number(b.wud) || byName(a, b));
        return { key, name, units };
    });

    const hasWud = (project: Project) => project.units.some((unit) => unit.wud);
    // A project of one row shows as that row, so it sorts by the row's name.
    const shown = (project: Project) => ({
        name: project.units.length === 1 ? project.units[0].name : project.name,
    });
    return result.sort((a, b) => Number(hasWud(a)) - Number(hasWud(b)) || byName(shown(a), shown(b)));
}

/** What the card remembers of an install it started, until the page is reloaded. */
export interface Install {
    /** When the card asked for it. */
    at: number;
    /** The version each container was on, and the one it should end up on. */
    from: Record<string, string>;
    targets: Record<string, string>;
    /** WUD has said it is installing. */
    started: boolean;
    /** When WUD said it had finished, or the card saw the new versions. */
    ended?: number;
    /** Home Assistant's error, when it refused to send the install. */
    error?: string;
}

export interface Followed {
    install: Install;
    status: RowStatus;
    /**
     * Why it failed: Home Assistant refused, WUD never started, it finished without the new version, or (in the
     * integration's queue only) it ran for too long.
     */
    reason?: "service" | "start" | "version" | "timeout";
}

/**
 * How an install the card started is going.
 *
 * WUD reports no failures. It marks the container as installing when the command arrives and unmarks it
 * when the install ends, whether it worked or not, so a failure shows only as the old version staying.
 * The new version can show a moment after WUD has finished, once it has looked at the new container, so
 * a finished install gets `VERSION_GRACE` to reach it before it counts as failed.
 */
export function follow(unit: Unit, install: Install, now: number): Followed {
    const started = install.started || unit.installing;
    const ended = unit.installing ? undefined : started ? (install.ended ?? now) : undefined;
    const next: Install = { ...install, started, ended };

    // Checked before a refusal, as the row may have been installed some other way since, such as from Home Assistant.
    if (unit.containers.every((c) => c.installed === install.targets[c.entity_id])) {
        // The first time it is seen done stays, so that the card can forget it a while later.
        return { install: { ...next, ended: install.ended ?? ended ?? now }, status: "done" };
    }
    if (install.error !== undefined) {
        return { install: next, status: "failed", reason: "service" };
    }
    if (unit.installing) {
        return { install: next, status: "running" };
    }
    if (started) {
        return now - (ended ?? now) > VERSION_GRACE
            ? { install: next, status: "failed", reason: "version" }
            : { install: next, status: "running" };
    }
    return now - install.at > START_TIMEOUT ? { install: next, status: "failed", reason: "start" } : { install: next, status: "running" };
}

/** How many of a unit's services are on their new version, while it installs. */
export function servicesDone(unit: Unit, install: Install | undefined): number {
    return install ? unit.containers.filter((c) => c.installed === install.targets[c.entity_id]).length : 0;
}

/** The WUD Queue integration's sensor, found by its platform so that a renamed entity is found too. */
export function queueEntityId(hass: HomeAssistant): string | undefined {
    // The registry is keyed by entity id, so the key is read rather than the entry's own copy of it.
    return Object.entries(hass.entities ?? {}).find(([id, e]) => e?.platform === "wud_queue" && id.startsWith("sensor."))?.[0];
}

/** The WUD Queue integration's queue, or nothing while its sensor is unavailable or the integration isn't there. */
export function queueOf(hass: HomeAssistant): Queue | undefined {
    const id = queueEntityId(hass);
    const state = id && hass.states[id];
    if (!state || !Array.isArray(state.attributes.items)) {
        return undefined;
    }
    return {
        state: state.state as Queue["state"],
        stopping: state.attributes.stopping === true,
        items: state.attributes.items as Queue["items"],
    };
}

/**
 * A row's place in the integration's queue, in the shape the card uses for the installs it follows itself. The row's
 * latest item counts, as a container can be queued again after a failure.
 */
export function followQueue(unit: Unit, queue: Queue): Followed | undefined {
    const ids = new Set(unit.containers.map((c) => c.entity_id));
    const item = [...queue.items].reverse().find((i) => i.entities.some((e) => ids.has(e.entity_id)));
    if (!item) {
        return undefined;
    }
    const versions = new Map(item.entities.map((e) => [e.entity_id, e]));
    const install: Install = {
        at: 0,
        from: Object.fromEntries(unit.containers.map((c) => [c.entity_id, versions.get(c.entity_id)?.from ?? c.installed])),
        targets: Object.fromEntries(unit.containers.map((c) => [c.entity_id, versions.get(c.entity_id)?.to ?? c.installed])),
        started: true,
    };
    // The versions win over the queue's word: WUD may tell of a new version only after the queue has given up on it.
    if (unit.containers.every((c) => c.installed === install.targets[c.entity_id])) {
        return { install, status: "done" };
    }
    return {
        install: { ...install, ...(item.error ? { error: item.error } : {}) },
        status: item.status as RowStatus,
        ...(item.reason ? { reason: item.reason } : {}),
    };
}

/** Whether a failed or stopped queue has something left to try again: a container that still has its update. */
export function retryable(hass: HomeAssistant, queue: Queue): boolean {
    return queue.items.some((item) => item.status !== "done" && item.entities.some((e) => hass.states[e.entity_id]?.state === "on"));
}
