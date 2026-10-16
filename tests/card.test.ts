import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DONE_KEEP, START_TIMEOUT } from "../src/const";
import "../src/wud-queue-card";
import type { WudQueueCard } from "../src/wud-queue-card";
import type { HassEntity, HomeAssistant } from "../src/hass";
import type { Queue, QueueItem, WudQueueCardConfig } from "../src/types";
import { entity, hass, sample } from "./fixtures";

async function card(state: HomeAssistant, config: Partial<WudQueueCardConfig> = {}): Promise<WudQueueCard> {
    const element = document.createElement("wud-queue-card") as WudQueueCard;
    element.setConfig({ type: "custom:wud-queue-card", ...config });
    element.hass = state;
    document.body.append(element);
    await element.updateComplete;
    return element;
}

function shadow(element: WudQueueCard): ShadowRoot {
    const root = element.shadowRoot;
    if (!root) {
        throw new Error("the card rendered nothing");
    }
    return root;
}

/** What a viewer sees: the elements that aren't inside a shut section. */
function visible<E extends Element = Element>(root: ShadowRoot, selector: string): E[] {
    return [...root.querySelectorAll<E>(selector)].filter((e) => !e.closest(".fold:not(.open)"));
}

function names(root: ShadowRoot, selector: string): string[] {
    return visible(root, `${selector} .name`).map((n) => n.textContent?.replace(/\s+/g, " ").trim() ?? "");
}

function lines(root: ShadowRoot): string[] {
    return visible(root, ".switch").map((r) => r.textContent?.replace(/\s+/g, " ").trim() ?? "");
}

beforeEach(() => {
    document.body.innerHTML = "";
});

afterEach(() => {
    vi.useRealTimers();
});

/** The row of the waiting list whose name starts with the given text. */
function row(root: ShadowRoot, name: string): HTMLElement | undefined {
    return visible<HTMLElement>(root, ".scroll.pending .row:not(.sib, .proj-head)").find((r) =>
        r.querySelector(".name")?.textContent?.trim().startsWith(name),
    );
}

/** The player's install button pressed, and the card updated after it. */
async function pressPlayer(element: WudQueueCard): Promise<void> {
    row(shadow(element), "player")?.querySelector<HTMLButtonElement>("button.install")?.click();
    await element.updateComplete;
}

function withPlayer(installed: string, latest: string, installing = false): HassEntity[] {
    return sample().map((e) =>
        e.entity_id === "update.media_player"
            ? {
                  ...e,
                  state: installed === latest ? "off" : "on",
                  attributes: { ...e.attributes, installed_version: installed, latest_version: latest, in_progress: installing },
              }
            : e,
    );
}

describe("the waiting updates", () => {
    it("are listed in install order, with old and new version, WUD last", async () => {
        const root = shadow(await card(hass()));
        const rows = [...root.querySelectorAll(".scroll.pending .row:not(.sib, .proj-head)")];
        // The name without the service count that may follow it.
        const own = (row: Element) => row.querySelector(".name")?.childNodes[1]?.textContent?.trim();
        expect(rows.map(own)).toEqual(["app", "player", "web", "wud"]);
        expect(rows[0].querySelector(".sub")?.textContent?.replace(/\s+/g, " ").trim()).toBe("2.0.0 → 2.1.0");
        expect(root.querySelector(".hd-sub")?.textContent).toBe("Päivityksiä saatavilla");
    });

    it("show a row of several services with their count, and up-to-date services of the project thinly", async () => {
        const root = shadow(await card(hass()));
        expect(names(root, ".scroll.pending .row:not(.sib, .proj-head)")).toContain("web3 palvelua");
        expect(names(root, ".row.sib")).toEqual(["db"]);
        expect(root.querySelector(".proj-head")?.textContent?.replace(/\s+/g, " ").trim()).toBe("media2 palvelua");
    });

    it("install a row with one call for all its services", async () => {
        const calls: unknown[][] = [];
        const root = shadow(await card(hass(sample(), calls)));
        const web = [...root.querySelectorAll(".scroll.pending .row")].find((r) => r.textContent?.includes("3 palvelua"));
        (web?.querySelector("button.install") as HTMLButtonElement).click();
        expect(calls).toEqual([["update", "install", {}, { entity_id: ["update.web_site_a", "update.web_site_b", "update.web_site_c"] }]]);
    });

    it("lock the install buttons while something installs", async () => {
        const list = sample().map((e) =>
            e.entity_id === "update.media_player" ? { ...e, attributes: { ...e.attributes, in_progress: true } } : e,
        );
        const root = shadow(await card(hass(list)));
        const buttons = [...root.querySelectorAll<HTMLButtonElement>("button.install")];
        expect(buttons.length).toBe(3);
        expect(buttons.every((b) => b.disabled)).toBe(true);
        expect(root.querySelector(".hd-sub")?.textContent).toBe("Päivitetään player");
    });
});

describe("the two sections", () => {
    it("switch: opening the up-to-date list folds the waiting updates under their line", async () => {
        const element = await card(hass());
        const root = shadow(element);
        expect(lines(root)).toEqual(["4 odottaa päivitystä", "1 ajan tasalla Näytä"]);
        visible<HTMLButtonElement>(root, "button.switch")[0].click();
        await element.updateComplete;
        // The open section's line has no button. Only the other one opens anything.
        expect(lines(root)).toEqual(["4 odottaa päivitystä Näytä", "1 ajan tasalla"]);
        expect(names(root, ".current")).toEqual(["cache"]);
        expect(names(root, ".scroll.pending")).toEqual([]);
        visible<HTMLButtonElement>(root, "button.switch")[0].click();
        await element.updateComplete;
        expect(lines(root)).toEqual(["4 odottaa päivitystä", "1 ajan tasalla Näytä"]);
        expect(names(root, ".current")).toEqual([]);
    });

    it("open the waiting list when the first update comes in, but not for later ones", async () => {
        const current = sample().map((e) =>
            e.state === "on" ? { ...e, state: "off", attributes: { ...e.attributes, latest_version: e.attributes.installed_version } } : e,
        );
        const element = await card(hass(current));
        visible<HTMLButtonElement>(shadow(element), "button.switch")[0].click();
        await element.updateComplete;
        expect(names(shadow(element), ".current").length).toBeGreaterThan(0);

        element.hass = hass(sample());
        await element.updateComplete;
        expect(names(shadow(element), ".scroll.pending").length).toBeGreaterThan(0);
        expect(names(shadow(element), ".current")).toEqual([]);

        // Back to the up-to-date list by hand: a further update doesn't take it away again.
        visible<HTMLButtonElement>(shadow(element), "button.switch.current")[0].click();
        await element.updateComplete;
        element.hass = hass(withPlayer("1.4.0", "1.6.0"));
        await element.updateComplete;
        expect(names(shadow(element), ".scroll.pending")).toEqual([]);
    });

    it("show only the up-to-date line when nothing is waiting, and it opens and shuts", async () => {
        const list: HassEntity[] = [entity("update.cache", { image: "library/redis", installed: "8.0.1", service: "cache" })];
        const element = await card(hass(list));
        const root = shadow(element);
        expect(root.querySelector(".hd-sub")?.textContent).toBe("Kaikki ajan tasalla");
        expect(names(root, ".current")).toEqual([]);
        visible<HTMLButtonElement>(root, "button.switch")[0].click();
        await element.updateComplete;
        expect(lines(root)).toEqual(["1 ajan tasalla Piilota"]);
        expect(names(root, ".current")).toEqual(["cache"]);
        visible<HTMLButtonElement>(root, "button.switch")[0].click();
        await element.updateComplete;
        expect(names(root, ".current")).toEqual([]);
    });

    it("take a fixed height from the options", async () => {
        const root = shadow(await card(hass(), { height: 300 }));
        expect(root.querySelector<HTMLElement>("ha-card")?.getAttribute("style")).toBe("height:300px");
    });
});

it("says so when there are no WUD updates", async () => {
    const root = shadow(await card(hass([])));
    expect(root.querySelector(".message")?.textContent).toBe("What's Up Dockerin päivitysentiteettejä ei löytynyt");
});

describe("installs over time", () => {
    it("fail when WUD never starts, and can be tried again", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
        const calls: unknown[][] = [];
        const element = await card(hass(sample(), calls));
        await pressPlayer(element);
        expect(row(shadow(element), "player")?.querySelector(".pill")?.textContent).toBe("Päivitetään");

        vi.advanceTimersByTime(START_TIMEOUT + 5000);
        await element.updateComplete;
        const failed = row(shadow(element), "player");
        expect(failed?.querySelector(".ico")?.classList.contains("failed")).toBe(true);
        expect(shadow(element).querySelector(".errline")?.textContent).toContain("minuutissa");

        failed?.querySelector<HTMLButtonElement>("button.install")?.click();
        await element.updateComplete;
        expect(calls.length).toBe(2);
        expect(row(shadow(element), "player")?.querySelector(".pill")?.textContent).toBe("Päivitetään");
    });

    it("catch up on the clock when the card comes back to the page", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
        const element = await card(hass());
        await pressPlayer(element);
        element.remove();
        vi.setSystemTime(Date.now() + START_TIMEOUT + 5000);
        document.body.append(element);
        await element.updateComplete;
        expect(row(shadow(element), "player")?.querySelector(".ico")?.classList.contains("failed")).toBe(true);
    });

    it("show Home Assistant's error when it refuses the install", async () => {
        const state = hass();
        state.callService = async () => {
            throw new Error("Action update.install not found");
        };
        const element = await card(state);
        await pressPlayer(element);
        await new Promise((resolve) => setTimeout(resolve));
        await element.updateComplete;
        expect(shadow(element).querySelector(".errline")?.textContent).toContain("Action update.install not found");
    });

    it("drop a refusal once the row has been installed some other way", async () => {
        const state = hass();
        state.callService = async () => {
            throw new Error("Update is already in progress");
        };
        const element = await card(state);
        await pressPlayer(element);
        await new Promise((resolve) => setTimeout(resolve));
        await element.updateComplete;
        element.hass = hass(withPlayer("1.5.0", "1.5.0"));
        await element.updateComplete;
        expect(row(shadow(element), "player")?.querySelector(".pill")?.textContent).toBe("Päivitetty");
        expect(shadow(element).querySelector(".errline")).toBeNull();
    });

    it("show a finished row as updated, then as waiting again when an even newer version comes out", async () => {
        const element = await card(hass());
        await pressPlayer(element);
        element.hass = hass(withPlayer("1.5.0", "1.5.0"));
        await element.updateComplete;
        expect(row(shadow(element), "player")?.querySelector(".pill")?.textContent).toBe("Päivitetty");

        element.hass = hass(withPlayer("1.5.0", "1.6.0"));
        await element.updateComplete;
        const again = row(shadow(element), "player");
        expect(again?.querySelector(".sub")?.textContent?.replace(/\s+/g, " ").trim()).toBe("1.5.0 → 1.6.0");
        expect(again?.querySelector("button.install")).not.toBeNull();
    });

    it("forget a finished row after a while", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
        const element = await card(hass());
        await pressPlayer(element);
        element.hass = hass(withPlayer("1.5.0", "1.5.0"));
        await element.updateComplete;
        expect(row(shadow(element), "player")).toBeDefined();
        vi.advanceTimersByTime(DONE_KEEP + 10_000);
        await element.updateComplete;
        expect(row(shadow(element), "player")).toBeUndefined();
    });
});

describe("while WUD recreates a container", () => {
    it("keeps the row and its install while the entity is briefly unusable", async () => {
        const element = await card(hass());
        await pressPlayer(element);
        element.hass = hass(
            sample().map((e) => (e.entity_id === "update.media_player" ? { ...e, state: "unavailable", attributes: {} } : e)),
        );
        await element.updateComplete;
        expect(row(shadow(element), "player")?.querySelector(".pill")?.textContent).toBe("Päivitetään");

        element.hass = hass(withPlayer("1.5.0", "1.5.0"));
        await element.updateComplete;
        expect(row(shadow(element), "player")?.querySelector(".pill")?.textContent).toBe("Päivitetty");
    });
});

describe("the configuration", () => {
    it("takes one entity written without a list", async () => {
        const root = shadow(await card(hass(), { exclude: "update.media_player" as unknown as string[] }));
        expect(row(root, "player")).toBeUndefined();
    });

    it("opens a row from the keyboard", async () => {
        const element = await card(hass());
        const opened: unknown[] = [];
        element.addEventListener("hass-more-info", (event) => opened.push((event as CustomEvent).detail));
        row(shadow(element), "player")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(opened).toEqual([{ entityId: "update.media_player" }]);
    });
});

describe("with the WUD Queue integration", () => {
    function withQueue(state: HomeAssistant, queue: Partial<Queue> & Pick<Queue, "items">): HomeAssistant {
        const id = "sensor.wud_queue";
        return {
            ...state,
            states: {
                ...state.states,
                [id]: {
                    entity_id: id,
                    state: queue.state ?? "idle",
                    last_changed: "2026-10-13T08:00:00Z",
                    attributes: { items: queue.items, stopping: queue.stopping ?? false },
                },
            },
            entities: { ...state.entities, [id]: { entity_id: id, platform: "wud_queue" } },
        };
    }

    function item(name: string, status: QueueItem["status"], ids: string[], extra: Partial<QueueItem> = {}): QueueItem {
        return {
            name,
            status,
            reason: null,
            error: null,
            entities: ids.map((id) => ({ entity_id: id, from: "1", to: "2", status })),
            ...extra,
        };
    }

    function action(root: ShadowRoot): HTMLButtonElement | null {
        return root.querySelector<HTMLButtonElement>("button.action");
    }

    it("queues a row, and the whole list from the header", async () => {
        const calls: unknown[][] = [];
        const element = await card(withQueue(hass(sample(), calls), { items: [] }));
        const root = shadow(element);
        row(root, "player")?.querySelector<HTMLButtonElement>("button.install")?.click();
        expect(calls[0]).toEqual(["wud_queue", "enqueue", { entity_id: ["update.media_player"] }]);

        expect(action(root)?.textContent).toBe("Päivitä kaikki");
        action(root)?.click();
        expect(calls[1][1]).toBe("enqueue");
        expect((calls[1][2] as { entity_id: string[] }).entity_id).toEqual([
            "update.alpha_app",
            "update.media_player",
            "update.web_site_a",
            "update.web_site_b",
            "update.web_site_c",
            "update.wud_wud",
        ]);
    });

    it("shows the queue's statuses, keeps the buttons usable and stops the run", async () => {
        const calls: unknown[][] = [];
        const queue = {
            state: "running" as const,
            items: [
                item("app", "done", ["update.alpha_app"]),
                item("player", "running", ["update.media_player"]),
                item("wud", "queued", ["update.wud_wud"]),
            ],
        };
        const root = shadow(await card(withQueue(hass(sample(), calls), queue)));
        expect(row(root, "player")?.querySelector(".pill")?.textContent).toBe("Päivitetään");
        expect(row(root, "wud")?.querySelector(".pill")?.textContent).toBe("Jonossa");
        expect(row(root, "app")?.querySelector(".pill")?.textContent).toBe("Päivitetty");
        expect(row(root, "web")?.querySelector<HTMLButtonElement>("button.install")?.disabled).toBe(false);
        expect([...root.querySelectorAll(".seg")].map((s) => s.className)).toEqual(["seg done", "seg running", "seg queued"]);

        expect(action(root)?.textContent).toBe("Pysäytä jono");
        action(root)?.click();
        expect(calls).toEqual([["wud_queue", "stop", {}]]);
    });

    it("offers to clear a finished run when nothing else is waiting", async () => {
        const calls: unknown[][] = [];
        const done = sample().map((e) =>
            e.state === "on" ? { ...e, state: "off", attributes: { ...e.attributes, installed_version: e.attributes.latest_version } } : e,
        );
        const root = shadow(await card(withQueue(hass(done, calls), { items: [item("player", "done", ["update.media_player"])] })));
        expect(row(root, "player")?.querySelector(".pill")?.textContent).toBe("Päivitetty");
        expect(action(root)?.textContent).toBe("Kuittaa");
        action(root)?.click();
        expect(calls).toEqual([["wud_queue", "clear", {}]]);
    });

    it("redraws when only the queue has changed", async () => {
        const element = await card(withQueue(hass(), { state: "running", items: [item("player", "running", ["update.media_player"])] }));
        const done = withQueue(hass(withPlayer("1.5.0", "1.5.0")), { items: [item("player", "done", ["update.media_player"])] });
        element.hass = done;
        await element.updateComplete;
        expect(row(shadow(element), "player")?.querySelector(".pill")?.textContent).toBe("Päivitetty");
        // The queue cleared, and nothing else changed.
        element.hass = {
            ...done,
            states: { ...done.states, "sensor.wud_queue": { ...done.states["sensor.wud_queue"]!, attributes: { items: [] } } },
        };
        await element.updateComplete;
        expect(row(shadow(element), "player")).toBeUndefined();
    });

    it("leaves a refused queuing to Home Assistant's notice, and the row to what the queue says", async () => {
        const state = withQueue(hass(), {
            state: "failed",
            items: [item("player", "failed", ["update.media_player"], { reason: "version" })],
        });
        state.callService = async () => {
            throw new Error("The queue is stopping");
        };
        const element = await card(state);
        row(shadow(element), "player")?.querySelector<HTMLButtonElement>("button.install")?.click();
        await new Promise((resolve) => setTimeout(resolve));
        await element.updateComplete;
        const error = shadow(element).querySelector(".errline")?.textContent ?? "";
        expect(error).not.toContain("The queue is stopping");
        expect(error).toContain("yhä versiossa 1.4.0");
    });

    it("locks the row buttons until Home Assistant has answered a queuing, so a double click sends one", async () => {
        const calls: unknown[][] = [];
        let answer: () => void = () => undefined;
        const state = withQueue(hass(), { items: [] });
        state.callService = (...args: unknown[]) => {
            calls.push(args);
            return new Promise<undefined>((resolve) => (answer = () => resolve(undefined)));
        };
        const element = await card(state);
        await pressPlayer(element);
        await pressPlayer(element);
        expect(calls).toHaveLength(1);
        expect(row(shadow(element), "app")?.querySelector<HTMLButtonElement>("button.install")?.disabled).toBe(true);
        answer();
        await new Promise((resolve) => setTimeout(resolve));
        await element.updateComplete;
        expect(row(shadow(element), "app")?.querySelector<HTMLButtonElement>("button.install")?.disabled).toBe(false);
    });

    it("installs nothing while the queue's sensor is away, rather than going around the queue", async () => {
        const calls: unknown[][] = [];
        const state = withQueue(hass(sample(), calls), { items: [] });
        state.states["sensor.wud_queue"] = { entity_id: "sensor.wud_queue", state: "unavailable", last_changed: "", attributes: {} };
        const element = await card(state);
        expect(row(shadow(element), "player")?.querySelector<HTMLButtonElement>("button.install")?.disabled).toBe(true);
        expect(action(shadow(element))).toBeNull();
    });

    it("shows a failed row as updated once it has its version, and offers to clear a run with nothing left to retry", async () => {
        const calls: unknown[][] = [];
        const updated = sample().map((e) =>
            e.entity_id === "update.media_player"
                ? entity("update.media_player", { stack: "media", service: "player", image: "example/player", installed: "1.5.0" })
                : e,
        );
        const failed = item("player", "failed", ["update.media_player"], {
            reason: "version",
            entities: [{ entity_id: "update.media_player", from: "1.4.0", to: "1.5.0", status: "failed" }],
        });
        const root = shadow(await card(withQueue(hass(updated, calls), { state: "failed", items: [failed] })));
        expect(row(root, "player")?.querySelector(".pill")?.textContent).toBe("Päivitetty");
        expect(root.querySelector(".errline")).toBeNull();
        expect(action(root)?.textContent).toBe("Kuittaa");
        action(root)?.click();
        expect(calls).toEqual([["wud_queue", "clear", {}]]);
    });

    it("locks the row buttons while the queue stops", async () => {
        const root = shadow(
            await card(withQueue(hass(), { state: "running", stopping: true, items: [item("app", "running", ["update.alpha_app"])] })),
        );
        expect(row(root, "player")?.querySelector<HTMLButtonElement>("button.install")?.disabled).toBe(true);
        expect(action(root)?.textContent).toBe("Pysähtyy");
    });

    it("disables its button until Home Assistant has answered", async () => {
        let answer: () => void = () => undefined;
        const state = withQueue(hass(), { items: [] });
        state.callService = () => new Promise<undefined>((resolve) => (answer = () => resolve(undefined)));
        const element = await card(state);
        action(shadow(element))?.click();
        await element.updateComplete;
        expect(action(shadow(element))?.disabled).toBe(true);
        answer();
        await new Promise((resolve) => setTimeout(resolve));
        await element.updateComplete;
        expect(action(shadow(element))?.disabled).toBe(false);
    });

    it("shows a failure with its reason, and offers a retry", async () => {
        const calls: unknown[][] = [];
        const queue = {
            state: "failed" as const,
            items: [item("player", "failed", ["update.media_player"], { reason: "timeout" }), item("wud", "not_run", ["update.wud_wud"])],
        };
        const root = shadow(await card(withQueue(hass(sample(), calls), queue)));
        expect(root.querySelector(".hd-sub")?.textContent).toBe("player ei päivittynyt");
        expect(root.querySelector(".errline")?.textContent).toContain("puolessa tunnissa");
        expect(row(root, "wud")?.querySelector("button.install")).not.toBeNull();
        expect(action(root)?.textContent).toBe("Yritä uudelleen");
        action(root)?.click();
        expect(calls).toEqual([["wud_queue", "retry", {}]]);
    });
});
