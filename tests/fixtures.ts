import type { HassEntity, HomeAssistant } from "../src/hass";

/** An update entity shaped like the ones What's Up Docker publishes, with made-up containers. */
export function entity(
    id: string,
    options: {
        stack?: string;
        service?: string;
        image: string;
        installed: string;
        latest?: string;
        installing?: boolean;
        name?: string;
        watcher?: string;
        state?: string;
    },
): HassEntity {
    const latest = options.latest ?? options.installed;
    return {
        entity_id: id,
        state: options.state ?? (latest === options.installed ? "off" : "on"),
        last_changed: "2026-10-13T08:00:00Z",
        attributes: {
            installed_version: options.installed,
            latest_version: latest,
            in_progress: options.installing ?? false,
            watcher: options.watcher ?? "local",
            stack: options.stack ?? "",
            name: options.name ?? `${options.stack ?? "solo"}-${options.service ?? "app"}-1`,
            display_name: options.service ?? "app",
            image_name: options.image,
            ...(options.service ? { labels_com_docker_compose_service: options.service } : {}),
        },
    };
}

export function states(list: HassEntity[]): Record<string, HassEntity> {
    return Object.fromEntries(list.map((e) => [e.entity_id, e]));
}

/** Four compose projects and one container without compose. */
export function sample(): HassEntity[] {
    return [
        entity("update.web_site_a", {
            stack: "web",
            service: "site_a",
            image: "library/node",
            installed: "26.1.0",
            latest: "26.2.0",
        }),
        entity("update.web_site_b", {
            stack: "web",
            service: "site_b",
            image: "library/node",
            installed: "26.1.0",
            latest: "26.2.0",
        }),
        entity("update.web_site_c", {
            stack: "web",
            service: "site_c",
            image: "library/node",
            installed: "26.1.0",
            latest: "26.2.0",
        }),
        entity("update.media_player", {
            stack: "media",
            service: "player",
            image: "example/player",
            installed: "1.4.0",
            latest: "1.5.0",
        }),
        entity("update.media_db", {
            stack: "media",
            service: "db",
            image: "library/mariadb",
            installed: "11.4.2",
        }),
        entity("update.wud_wud", {
            stack: "wud",
            service: "wud",
            image: "getwud/wud",
            installed: "9.4.1",
            latest: "9.5.0",
        }),
        entity("update.alpha_app", {
            stack: "alpha",
            service: "app",
            image: "example/alpha",
            installed: "2.0.0",
            latest: "2.1.0",
        }),
        entity("update.cache", { image: "library/redis", installed: "8.0.1", name: "cache", service: "cache" }),
        entity("update.wud_helper", {
            stack: "wud",
            image: "getwud/wud",
            installed: "9.4.1",
            name: "wud-self-update-1791730329826",
        }),
    ];
}

export function hass(list: HassEntity[] = sample(), calls: unknown[][] = []): HomeAssistant {
    return {
        locale: { language: "fi" },
        states: states(list),
        entities: Object.fromEntries(
            list.map((e) => [e.entity_id, { entity_id: e.entity_id, device_id: e.entity_id === "update.cache" ? "other" : "wud1" }]),
        ),
        callService: async (...args: unknown[]) => {
            calls.push(args);
            return undefined;
        },
    };
}
