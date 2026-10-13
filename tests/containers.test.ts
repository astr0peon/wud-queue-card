import { describe, expect, it } from "vitest";

import { START_TIMEOUT, VERSION_GRACE } from "../src/const";
import { containerOf, follow, projectsOf, selectedEntities, servicesDone } from "../src/containers";
import type { Install } from "../src/containers";
import type { Container, Unit } from "../src/types";
import { entity, hass, sample } from "./fixtures";

function containers(list = sample()): Container[] {
    return list.map((e) => containerOf(e)).filter((c): c is Container => c !== undefined);
}

describe("which entities are shown", () => {
    it("finds every WUD update entity, without the self-update helper", () => {
        const ids = selectedEntities(hass(), { type: "custom:wud-queue-card" });
        expect(ids).toContain("update.web_site_a");
        expect(ids).toContain("update.cache");
        expect(ids).not.toContain("update.wud_helper");
    });

    it("keeps to one device's entities", () => {
        const ids = selectedEntities(hass(), { type: "custom:wud-queue-card", device: "other" });
        expect(ids).toEqual(["update.cache"]);
    });

    it("takes a list instead, and leaves out the excluded ones", () => {
        const ids = selectedEntities(hass(), {
            type: "custom:wud-queue-card",
            entities: ["update.media_player", "update.media_db", "update.not_there"],
            exclude: ["update.media_db"],
        });
        expect(ids).toEqual(["update.media_player"]);
    });

    it("ignores update entities that are not from WUD", () => {
        const state = hass();
        state.states["update.router"] = {
            entity_id: "update.router",
            state: "on",
            last_changed: "",
            attributes: { installed_version: "1", latest_version: "2" },
        };
        expect(selectedEntities(state, { type: "custom:wud-queue-card" })).not.toContain("update.router");
    });

    it("skips an unavailable entity", () => {
        const gone = entity("update.gone", { image: "x/y", installed: "1", state: "unavailable" });
        expect(containerOf(gone)).toBeUndefined();
    });
});

describe("projects and rows", () => {
    const projects = projectsOf(containers());

    it("are in install order: by name, WUD last", () => {
        expect(projects.map((p) => p.name)).toEqual(["alpha", "cache", "media", "web", "wud"]);
    });

    it("sort a project of one row by the name the row shows", () => {
        const list = containers([
            entity("update.mail", { stack: "zmail", service: "bridge", image: "x/bridge", installed: "1" }),
            entity("update.mailer", { stack: "mail", service: "mailer", image: "x/mail", installed: "1" }),
        ]);
        expect(projectsOf(list).map((p) => p.units[0].name)).toEqual(["bridge", "mailer"]);
    });

    it("make services of one image a single row, named after the project", () => {
        const web = projects.find((p) => p.name === "web");
        expect(web?.units).toHaveLength(1);
        expect(web?.units[0].name).toBe("web");
        expect(web?.units[0].containers.map((c) => c.name)).toEqual(["site_a", "site_b", "site_c"]);
    });

    it("keep different images of one project as rows of their own", () => {
        const media = projects.find((p) => p.name === "media");
        expect(media?.units.map((u) => u.name)).toEqual(["db", "player"]);
        expect(media?.units.map((u) => u.pending)).toEqual([false, true]);
    });

    it("put WUD's own row last within its project too", () => {
        // Without the self-update helper, which the card leaves out before grouping.
        const list = containers([
            ...sample().filter((e) => e.entity_id !== "update.wud_helper"),
            entity("update.wud_proxy", {
                stack: "wud",
                service: "zz_proxy",
                image: "library/caddy",
                installed: "2",
            }),
        ]);
        const wud = projectsOf(list).find((p) => p.name === "wud");
        expect(wud?.units.map((u) => u.wud)).toEqual([false, true]);
    });
});

describe("grouping across hosts and tags", () => {
    it("keeps each watcher's projects apart, and names the watcher when there are several", () => {
        const list = containers([
            entity("update.a_grafana", {
                stack: "monitoring",
                service: "grafana",
                image: "grafana/grafana",
                installed: "1",
                watcher: "alpha",
            }),
            entity("update.b_grafana", {
                stack: "monitoring",
                service: "grafana",
                image: "grafana/grafana",
                installed: "1",
                watcher: "beta",
            }),
            entity("update.b_proxy", { service: "proxy", image: "library/caddy", installed: "2", watcher: "beta" }),
        ]);
        const projects = projectsOf(list);
        expect(projects.map((p) => p.units[0].name)).toEqual(["grafana (alpha)", "grafana (beta)", "proxy (beta)"]);
        expect(new Set(projects.map((p) => p.key)).size).toBe(3);
    });

    it("names no watcher when all containers share one", () => {
        expect(projectsOf(containers()).some((p) => p.name.includes("(local)"))).toBe(false);
    });

    it("makes one image on two tags two rows, and keeps services headed for one version together", () => {
        const list = containers([
            entity("update.old_db", { stack: "app", service: "old_db", image: "library/postgres", installed: "15.8", latest: "15.9" }),
            entity("update.new_db", { stack: "app", service: "new_db", image: "library/postgres", installed: "16.4", latest: "16.5" }),
            entity("update.w1", { stack: "app", service: "w1", image: "library/node", installed: "24.1", latest: "24.2" }),
            entity("update.w2", { stack: "app", service: "w2", image: "library/node", installed: "24.2", latest: "24.2" }),
        ]);
        const [app] = projectsOf(list);
        expect(app.units.map((u) => [u.name, u.containers.length])).toEqual([
            ["new_db", 1],
            ["node", 2],
            ["old_db", 1],
        ]);
    });

    it("hides only WUD's own self-update helper", () => {
        const list = [
            entity("update.helper", { image: "getwud/wud", installed: "1", name: "wud-wud-self-update-1791730329826" }),
            entity("update.updater", { image: "example/updater", installed: "1", name: "my-self-updater" }),
        ];
        expect(selectedEntities(hass(list), { type: "custom:wud-queue-card" })).toEqual(["update.updater"]);
    });
});

describe("following an install", () => {
    const T = 1_000_000;

    function unit(installed: string, installing = false): Unit {
        const c = containerOf(
            entity("update.app", {
                stack: "s",
                service: "app",
                image: "x/app",
                installed,
                latest: "2.0",
                installing,
            }),
        ) as Container;
        return { key: "s/x/app", name: "app", containers: [c], pending: c.pending, installing, wud: false };
    }

    const install: Install = {
        at: T,
        from: { "update.app": "1.0" },
        targets: { "update.app": "2.0" },
        started: false,
    };

    it("runs while WUD has not started yet, and fails after a minute without it", () => {
        expect(follow(unit("1.0"), install, T + 1000).status).toBe("running");
        const late = follow(unit("1.0"), install, T + START_TIMEOUT + 1);
        expect(late).toMatchObject({ status: "failed", reason: "start" });
    });

    it("is done once the new version shows", () => {
        expect(follow(unit("2.0"), install, T + 5000).status).toBe("done");
    });

    it("gives a finished install time for its version, then calls it failed", () => {
        const running = follow(unit("1.0", true), install, T + 1000);
        expect(running.status).toBe("running");
        const ended = follow(unit("1.0"), running.install, T + 2000);
        expect(ended.status).toBe("running");
        expect(ended.install.ended).toBe(T + 2000);
        // Later checks keep the moment it ended, not their own.
        expect(follow(unit("1.0"), ended.install, T + 2000 + VERSION_GRACE).status).toBe("running");
        const failed = follow(unit("1.0"), ended.install, T + 2001 + VERSION_GRACE);
        expect(failed).toMatchObject({ status: "failed", reason: "version" });
    });

    it("fails at once when Home Assistant refused to send it", () => {
        const refused = follow(unit("1.0"), { ...install, error: "Service not found" }, T + 1000);
        expect(refused.status).toBe("failed");
        expect(refused.reason).toBe("service");
    });

    it("notes when it was done, so the card can forget it later", () => {
        expect(follow(unit("2.0"), install, T + 5000).install.ended).toBe(T + 5000);
    });

    it("counts the services already on the new version", () => {
        const [web] = projectsOf(containers()).filter((p) => p.name === "web");
        const targets = Object.fromEntries(web.units[0].containers.map((c) => [c.entity_id, "26.1.0"]));
        targets["update.web_site_c"] = "26.2.0";
        expect(servicesDone(web.units[0], { at: 0, from: {}, targets, started: true })).toBe(2);
    });
});
