import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DONE_KEEP, START_TIMEOUT } from "../src/const";
import "../src/wud-queue-card";
import type { WudQueueCard } from "../src/wud-queue-card";
import type { HassEntity, HomeAssistant } from "../src/hass";
import type { WudQueueCardConfig } from "../src/types";
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
    expect(root.querySelector(".message")?.textContent).toBe("What's Up Dockerin päivityksiä ei löytynyt");
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
