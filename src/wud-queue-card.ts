/**
 * A dashboard card for What's Up Docker's container updates. The containers are grouped by compose
 * project, and services of one project that run the same image are one row, installed together.
 *
 * Two sections share the card: the updates waiting, and the containers already up to date. Only one is
 * open at a time; the other is a single row that opens it. Rows are listed in the order they should be
 * installed, with WUD's own container last.
 *
 * Installing calls `update.install` on the row's entities. The card keeps an eye on what it started, so
 * an install that fails shows on its row while the card is open; WUD itself reports no failures.
 */
import { LitElement, css, html, nothing } from "lit";
import type { CSSResultGroup, PropertyValues, TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { CARD_VERSION, DONE_KEEP } from "./const";
import {
    containerOf,
    follow,
    followQueue,
    isWud,
    projectsOf,
    queueEntityId,
    queueOf,
    retryable,
    selectedEntities,
    servicesDone,
} from "./containers";
import type { Followed, Install } from "./containers";
import "./editor";
import type { HomeAssistant } from "./hass";
import { browserLanguage, translate } from "./localize/localize";
import type { Container, Project, Queue, Unit, WudQueueCardConfig } from "./types";

console.info(
    `%c  WUD-QUEUE-CARD \n%c  ${CARD_VERSION}    `,
    "color: orange; font-weight: bold; background: black",
    "color: white; font-weight: bold; background: dimgray",
);

interface CardRegistration {
    type: string;
    name: string;
    description: string;
    documentationURL?: string;
    preview?: boolean;
}

const registry = window as unknown as { customCards?: CardRegistration[] };
registry.customCards = registry.customCards ?? [];
registry.customCards.push({
    type: "wud-queue-card",
    name: translate(browserLanguage(), "common.name"),
    description: translate(browserLanguage(), "common.description"),
    documentationURL: "https://github.com/jesmak/wud-queue-card",
    preview: true,
});

type Section = "pending" | "current";

/** Whether a row is installing, by WUD's word or by the install the card or the queue follows. */
function running(unit: Unit, followed: Map<string, Followed>): boolean {
    return unit.installing || followed.get(unit.key)?.status === "running";
}

@customElement("wud-queue-card")
export class WudQueueCard extends LitElement {
    @property({ attribute: false }) public hass?: HomeAssistant;
    @state() private config?: WudQueueCardConfig;
    /** The open section. Until one is chosen, the waiting updates are open when there are any. */
    @state() private open?: Section | "none";
    /** The installs this card started, by row, until the page is reloaded. */
    @state() private installs = new Map<string, Install>();
    @state() private now = Date.now();
    private timer?: number;
    /** Each container as last seen with a usable entity, for while WUD recreates it. */
    private known = new Map<string, Container>();
    /** Whether anything was waiting at the last update, to notice when the first update comes in. */
    private hadPending?: boolean;
    /** A queue action sent and not yet answered. Its button stays disabled meanwhile, so the press shows. */
    @state() private acting = false;
    /** While the sections slide, the lists don't scroll, so no scrollbar flashes as one grows. */
    @state() private sliding = false;
    private slideTimer?: number;
    /** How each remembered install is going, worked out once per update. */
    private followed = new Map<string, Followed>();
    /** The projects to show, worked out once per update. */
    private projectList: Project[] = [];

    public static getConfigElement(): HTMLElement {
        return document.createElement("wud-queue-card-editor");
    }

    public static getStubConfig(): Record<string, unknown> {
        return {};
    }

    public setConfig(config: WudQueueCardConfig): void {
        // One entity may be written without a list around it.
        const list = (value: unknown): string[] | undefined => {
            if (value === undefined || (Array.isArray(value) && value.every((v) => typeof v === "string"))) {
                return value as string[] | undefined;
            }
            if (typeof value === "string") {
                return [value];
            }
            throw new Error(translate(browserLanguage(), "common.invalid_configuration"));
        };
        if (!config) {
            throw new Error(translate(browserLanguage(), "common.invalid_configuration"));
        }
        this.config = { ...config, entities: list(config.entities), exclude: list(config.exclude) };
    }

    public getCardSize(): number {
        return (
            2 +
            Math.min(
                this.projects()
                    .flatMap((p) => p.units)
                    .filter((u) => u.pending).length,
                6,
            )
        );
    }

    // No max_columns: a long version or digest has room to stay on one line in a wide card.
    public getGridOptions(): Record<string, unknown> {
        return { columns: 12, min_columns: 6, rows: "auto" };
    }

    public connectedCallback(): void {
        super.connectedCallback();
        // The clock stops while the card is away, such as on another view. Catch up and restart it.
        this.now = Date.now();
    }

    public disconnectedCallback(): void {
        super.disconnectedCallback();
        window.clearInterval(this.timer);
        this.timer = undefined;
        window.clearTimeout(this.slideTimer);
    }

    protected shouldUpdate(changed: PropertyValues): boolean {
        if (!this.config || !changed.has("hass") || changed.size > 1) {
            return true;
        }
        const previous = changed.get("hass") as HomeAssistant | undefined;
        if (!previous || !this.hass) {
            return true;
        }
        if ((previous.locale?.language ?? previous.language) !== (this.hass.locale?.language ?? this.hass.language)) {
            return true;
        }
        // The registry can arrive after the states, and it tells which entities are WUD's and which is the queue.
        if (previous.entities !== this.hass.entities) {
            return true;
        }
        // Redraw when the queue has changed, when a WUD update entity has, or when one has come or gone.
        const queue = queueEntityId(this.hass);
        if (queue && previous.states[queue] !== this.hass.states[queue]) {
            return true;
        }
        const before = selectedEntities(previous, this.config);
        const after = selectedEntities(this.hass, this.config);
        return before.length !== after.length || after.some((id) => previous.states[id] !== this.hass?.states[id]);
    }

    /**
     * Brings what the card remembers of its installs up to date, and keeps a clock running while one is going.
     * An install is forgotten when its row is gone, which is also what happens when an even newer version
     * comes out, and a finished one after `DONE_KEEP`.
     */
    protected willUpdate(): void {
        this.projectList = this.projects();
        const units = new Map(this.projectList.flatMap((p) => p.units.map((u) => [u.key, u] as const)));
        // The first update to come in opens the waiting list, whichever section was open. Later ones leave it be.
        const pending = [...units.values()].some((u) => u.pending);
        if (this.hadPending === false && pending) {
            this.open = undefined;
        }
        this.hadPending = pending;
        const installs = new Map<string, Install>();
        this.followed = new Map();
        for (const [key, install] of this.installs) {
            const unit = units.get(key);
            if (!unit) {
                continue;
            }
            const followed = follow(unit, install, this.now);
            if (followed.status === "done" && this.now - (followed.install.ended ?? this.now) > DONE_KEEP) {
                continue;
            }
            installs.set(key, followed.install);
            this.followed.set(key, followed);
        }
        // Only a new Map is a change to the state, and the old one may be what an update is rendering.
        this.installs = installs;
        // With the WUD Queue integration, the queue tells how each row's install is going.
        const queue = this.hass && queueOf(this.hass);
        if (queue) {
            for (const [key, unit] of units) {
                const followed = followQueue(unit, queue);
                if (followed) {
                    this.followed.set(key, followed);
                }
            }
        }
        // The clock also runs while a finished row waits to be forgotten.
        const ticking = [...this.followed.values()].some((f) => f.status === "running" || f.status === "done");
        if (ticking && this.timer === undefined) {
            this.timer = window.setInterval(() => (this.now = Date.now()), 5000);
        } else if (!ticking && this.timer !== undefined) {
            window.clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    protected render(): TemplateResult | typeof nothing {
        if (!this.hass || !this.config) {
            return nothing;
        }
        const projects = this.projectList;
        const title = this.config.title ?? this.text("common.title");
        if (projects.length === 0) {
            return html`<ha-card>
                <div class="hd"><div class="hd-title">${title}</div></div>
                <div class="message">${this.text("common.no_entities")}</div>
            </ha-card>`;
        }

        const followed = this.followed;
        const queue = queueOf(this.hass);
        const active = (unit: Unit) => unit.pending || unit.installing || followed.has(unit.key);
        const pendingProjects = projects.filter((p) => p.units.some(active));
        const currentProjects = projects.filter((p) => !p.units.some(active));
        const pendingUnits = pendingProjects.flatMap((p) => p.units).filter(active);
        const currentCount = currentProjects.reduce((n, p) => n + p.units.length, 0);
        // With updates waiting, one of the two sections is always open. Without, the up-to-date one opens and shuts.
        const open: Section | "none" = this.open === "current" ? "current" : pendingUnits.length > 0 ? "pending" : "none";
        // The queue takes installs at any time, except while it stops, while a call to it is on its way, or while its
        // sensor is away, as the integration starts. Without the integration, one install runs at a time.
        const busy =
            queueEntityId(this.hass) !== undefined
                ? !queue || queue.stopping || this.acting
                : pendingUnits.some((u) => running(u, followed));
        const height = this.config.height ? `height:${this.config.height}px` : "";

        return html`
            <ha-card style=${height} class=${this.sliding ? "sliding" : ""}>
                <div class="hd">
                    <div class="hd-title">${title}</div>
                    ${queue ? this.queueAction(queue, pendingUnits, followed) : nothing}
                </div>
                ${this.statusLine(pendingUnits, followed, queue)} ${queue && queue.items.length > 0 ? this.progress(queue) : nothing}
                <div class="list">
                    ${
                        pendingUnits.length === 0
                            ? nothing
                            : html`${
                                  currentCount === 0
                                      ? nothing
                                      : open === "pending"
                                        ? html`<div class="switch pending">
                                              ${this.text("common.pending_count", { n: pendingUnits.length })}
                                          </div>`
                                        : this.switchRow(
                                              this.text("common.pending_count", { n: pendingUnits.length }),
                                              "pending",
                                              this.sectionPill(pendingUnits, followed),
                                          )
                              }
                              ${this.fold(
                                  open === "pending",
                                  html`<div class="scroll pending">
                                      ${pendingProjects.map((p) => this.pendingProject(p, active, followed, busy))}
                                  </div>`,
                              )}`
                    }
                    ${
                        currentCount === 0
                            ? nothing
                            : html`${
                                  open === "current" && pendingUnits.length > 0
                                      ? html`<div class="switch current">${this.text("common.current_count", { n: currentCount })}</div>`
                                      : this.switchRow(
                                            this.text("common.current_count", { n: currentCount }),
                                            open === "current" ? "none" : "current",
                                        )
                              }
                              ${this.fold(
                                  open === "current",
                                  html`<div class="scroll current">${currentProjects.map((p) => this.currentProject(p))}</div>`,
                              )}`
                    }
                </div>
            </ha-card>
        `;
    }

    /** One line under the title: what is going on, or what is waiting. */
    private statusLine(units: Unit[], followed: Map<string, Followed>, queue: Queue | undefined): TemplateResult {
        const installing = units.filter((u) => running(u, followed));
        if (installing.length > 0) {
            const names = installing.map((u) => u.name).join(", ");
            return html`<div class="hd-sub">${this.text("common.updating", { name: names })}</div>`;
        }
        const failed = units.filter((u) => followed.get(u.key)?.status === "failed");
        if (failed.length > 0) {
            const names = failed.map((u) => u.name).join(", ");
            return html`<div class="hd-sub">${this.text("common.failed", { name: names })}</div>`;
        }
        if (queue?.state === "stopped") {
            return html`<div class="hd-sub">${this.text("common.queue_stopped")}</div>`;
        }
        // The section line below already counts the waiting updates.
        const key = units.some((u) => u.pending) ? "common.available" : "common.all_current";
        return html`<div class="hd-sub">${this.text(key)}</div>`;
    }

    /** A project with something to install: its label when it has several rows, then the rows. */
    private pendingProject(
        project: Project,
        active: (unit: Unit) => boolean,
        followed: Map<string, Followed>,
        busy: boolean,
    ): TemplateResult {
        const rows = project.units.map((unit) => (active(unit) ? this.unitRow(unit, followed.get(unit.key), busy) : this.siblingRow(unit)));
        if (project.units.length === 1) {
            return html`${rows}`;
        }
        return html`<div class="proj">
            ${this.projectLabel(project, !project.units.some((u) => u.pending))}
            <div class="proj-body">${rows}</div>
        </div>`;
    }

    private currentProject(project: Project): TemplateResult {
        if (project.units.length === 1) {
            return this.siblingRow(project.units[0], false);
        }
        return html`<div class="proj">
            ${this.projectLabel(project, true)}
            <div class="proj-body">${project.units.map((unit) => this.siblingRow(unit))}</div>
        </div>`;
    }

    /** A compose project's own row, dimmed like its containers unless one of them has an update. */
    private projectLabel(project: Project, muted: boolean): TemplateResult {
        const services = project.units.reduce((n, u) => n + u.containers.length, 0);
        return html`<div class="row proj-head ${muted ? "muted" : ""}">
            <ha-icon class="ico" icon="mdi:layers-outline"></ha-icon>
            <div class="info">
                <div class="name">${project.name}<span class="count">${this.text("common.services", { n: services })}</span></div>
            </div>
        </div>`;
    }

    /** A row with an update, or one the card has installed since the page was opened. */
    private unitRow(unit: Unit, followed: Followed | undefined, busy: boolean): TemplateResult {
        const status = followed?.status ?? (unit.installing ? "running" : "pending");
        // A finished row shows the version it moved from; the first container that moved stands for all.
        const moved = followed?.install.from ?? {};
        const shown =
            status === "done"
                ? (unit.containers.find((c) => moved[c.entity_id] !== c.installed) ?? unit.containers[0])
                : (unit.containers.find((c) => c.pending) ?? unit.containers[0]);
        const from = status === "done" ? (moved[shown.entity_id] ?? "") : shown.installed;
        const to = status === "done" ? shown.installed : shown.latest;
        return html`
            <div class="row" role="button" tabindex="0" @click=${() => this.moreInfo(unit)} @keydown=${this.onKey(unit)}>
                ${this.statusIcon(status)}
                <div class="info">
                    <div class="name">${unit.name}${this.serviceCount(unit, followed)}</div>
                    <div class="sub ver">${from} → <span class="new">${to}</span></div>
                </div>
                <div class="end">
                    ${
                        // A failed row can be tried again. Its error stays under it until then.
                        status === "pending" || status === "failed" || status === "not_run"
                            ? html`<button
                                  class="install"
                                  ?disabled=${busy}
                                  title=${this.text("common.install", { name: unit.name })}
                                  aria-label=${this.text("common.install", { name: unit.name })}
                                  @click=${(event: Event) => this.install(event, unit)}
                              >
                                  <ha-icon icon="mdi:arrow-up"></ha-icon>
                              </button>`
                            : html`<span class="pill ${status}">${this.text(`status.${status}`)}</span>`
                    }
                </div>
            </div>
            ${
                status === "failed"
                    ? html`<div class="errline">
                          ${this.text(`error.${followed?.reason ?? "version"}`, {
                              version: shown.installed,
                              message: followed?.install.error ?? "",
                          })}
                      </div>`
                    : nothing
            }
        `;
    }

    /** An up-to-date row with its version: a thin line in a project's group, or a project of its own. */
    private siblingRow(unit: Unit, inGroup = true): TemplateResult {
        return html`<div
            class="row ${inGroup ? "sib" : ""} muted"
            role="button"
            tabindex="0"
            @click=${() => this.moreInfo(unit)}
            @keydown=${this.onKey(unit)}
        >
            <ha-icon class="ico" icon="mdi:docker"></ha-icon>
            <div class="info"><div class="name">${unit.name}${this.serviceCount(unit)}</div></div>
            <div class="end"><span class="ver">${unit.containers[0].installed}</span></div>
        </div>`;
    }

    private statusIcon(status: string): TemplateResult {
        const icons: Record<string, string> = {
            pending: "mdi:docker",
            queued: "mdi:timer-sand",
            not_run: "mdi:minus-circle-outline",
            running: "mdi:sync",
            done: "mdi:check",
            failed: "mdi:alert-circle-outline",
        };
        return html`<ha-icon class="ico ${status}" icon=${icons[status]}></ha-icon>`;
    }

    /** "5 services", or "2/5 services" while they install. Nothing for a row of one container. */
    private serviceCount(unit: Unit, followed?: Followed): TemplateResult | typeof nothing {
        const n = unit.containers.length;
        if (n < 2) {
            return nothing;
        }
        const label =
            followed?.status === "running"
                ? this.text("common.services_done", { done: servicesDone(unit, followed.install), n })
                : this.text("common.services", { n });
        return html`<span class="count">${label}</span>`;
    }

    /** A section's line with the button that opens it, or shuts it when nothing else could be opened instead. */
    private switchRow(label: string, target: Section | "none", pill: TemplateResult | typeof nothing = nothing): TemplateResult {
        const section = target === "pending" ? "pending" : "current";
        return html`<button
            class="switch ${section}"
            aria-expanded=${target === "none" ? "true" : "false"}
            @click=${() => this.switchTo(target)}
        >
            <span>${label} ${pill}</span>
            <span>${this.text(target === "none" ? "common.hide" : "common.show")}</span>
        </button>`;
    }

    private switchTo(target: Section | "none"): void {
        this.open = target;
        this.sliding = true;
        window.clearTimeout(this.slideTimer);
        // The slide's end lifts it. Without a slide, as with reduced motion, there is no end to wait for.
        this.slideTimer = window.setTimeout(() => (this.sliding = false), 1000);
    }

    private readonly slid = (event: TransitionEvent): void => {
        if (event.propertyName === "grid-template-rows" && event.target === event.currentTarget) {
            window.clearTimeout(this.slideTimer);
            this.sliding = false;
        }
    };

    /** Content that slides open and shut. A shut one stays in the page, so the change can be animated. */
    private fold(isOpen: boolean, content: TemplateResult): TemplateResult {
        return html`<div class="fold ${isOpen ? "open" : ""}" ?inert=${!isOpen} @transitionend=${this.slid}>
            <div class="fold-in">${content}</div>
        </div>`;
    }

    /** On the closed row of waiting updates: whether something is installing or has failed. */
    private sectionPill(units: Unit[], followed: Map<string, Followed>): TemplateResult | typeof nothing {
        if (units.some((u) => running(u, followed))) {
            return html`<span class="pill running">${this.text("status.running")}</span>`;
        }
        if (units.some((u) => followed.get(u.key)?.status === "failed")) {
            return html`<span class="pill failed">${this.text("status.failed")}</span>`;
        }
        return nothing;
    }

    private async install(event: Event, unit: Unit): Promise<void> {
        // The button is its own thing to click; the row under it opens the entity.
        event.stopPropagation();
        if (!this.hass) {
            return;
        }
        const pending = unit.containers.filter((c) => c.pending);
        // With the integration the queue takes the row, and the card follows the queue. A refusal shows in Home
        // Assistant's own notice, as with the queue's buttons, and the row keeps showing what the queue says.
        if (queueEntityId(this.hass) !== undefined) {
            const installs = new Map(this.installs);
            installs.delete(unit.key);
            this.installs = installs;
            this.call("enqueue", { entity_id: pending.map((c) => c.entity_id) });
            return;
        }
        // Without it, the card sends the install itself and follows it. Services of one compose project can all be sent
        // at once, as WUD installs them one after another.
        const install: Install = {
            at: Date.now(),
            from: Object.fromEntries(unit.containers.map((c) => [c.entity_id, c.installed])),
            targets: Object.fromEntries(unit.containers.map((c) => [c.entity_id, c.pending ? c.latest : c.installed])),
            started: false,
        };
        this.installs = new Map(this.installs).set(unit.key, install);
        this.now = Date.now();
        try {
            await this.hass.callService("update", "install", {}, { entity_id: pending.map((c) => c.entity_id) });
        } catch (error) {
            // Home Assistant refused it, so WUD never got it. Say why on the row.
            const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
            this.installs = new Map(this.installs).set(unit.key, { ...install, error: message });
        }
    }

    /** Opens a row's entity from the keyboard, as a click does. */
    private onKey(unit: Unit): (event: KeyboardEvent) => void {
        return (event) => {
            if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                this.moreInfo(unit);
            }
        };
    }

    /** The queue's one button: update everything waiting, stop the run, try again after a failure, or clear a finished run. */
    private queueAction(queue: Queue, units: Unit[], followed: Map<string, Followed>): TemplateResult | typeof nothing {
        if (queue.state === "running") {
            return this.actionButton(this.text(queue.stopping ? "common.stopping" : "common.stop"), queue.stopping, () =>
                this.call("stop"),
            );
        }
        // A failed run whose containers have all got their updates some other way has nothing to try again, only to put away.
        if (queue.state === "failed") {
            return this.hass && retryable(this.hass, queue)
                ? this.actionButton(this.text("common.retry"), false, () => this.call("retry"))
                : this.actionButton(this.text("common.clear"), false, () => this.call("clear"));
        }
        const waiting = units
            .filter((u) => u.pending && !["queued", "running"].includes(followed.get(u.key)?.status ?? ""))
            .flatMap((u) => u.containers.filter((c) => c.pending).map((c) => c.entity_id));
        if (waiting.length > 0) {
            return this.actionButton(this.text("common.update_all"), false, () => this.call("enqueue", { entity_id: waiting }));
        }
        // Nothing to do but finished rows on show: they can be put away before the queue does it by itself.
        if (queue.items.some((i) => i.status === "done")) {
            return this.actionButton(this.text("common.clear"), false, () => this.call("clear"));
        }
        return nothing;
    }

    private actionButton(label: string, disabled: boolean, action: () => void): TemplateResult {
        return html`<button class="action" ?disabled=${disabled || this.acting} @click=${action}>${label}</button>`;
    }

    private call(service: string, data: Record<string, unknown> = {}): void {
        if (!this.hass) {
            return;
        }
        this.acting = true;
        // A refused call shows in Home Assistant's own notice. The queue's state is unchanged, and so is the card.
        void this.hass
            .callService("wud_queue", service, data)
            .catch(() => undefined)
            .finally(() => (this.acting = false));
    }

    /** A thin bar with a segment per item of the queue, coloured by how it went. */
    private progress(queue: Queue): TemplateResult {
        return html`<div class="bar" role="presentation">
            ${queue.items.map((item) => html`<span class="seg ${item.status}" title=${item.name}></span>`)}
        </div>`;
    }

    private moreInfo(unit: Unit): void {
        this.dispatchEvent(
            new CustomEvent("hass-more-info", {
                detail: { entityId: unit.containers[0].entity_id },
                bubbles: true,
                composed: true,
            }),
        );
    }

    private projects(): Project[] {
        if (!this.hass || !this.config) {
            return [];
        }
        const hass = this.hass;
        const ids = selectedEntities(hass, this.config);
        // While WUD recreates a container, its entity is briefly without a usable state. A container being installed
        // keeps its last known row meanwhile, so the row and its install aren't lost. One that is really gone has no
        // entity at all.
        const installing = new Set([
            ...[...this.installs.values()].flatMap((install) => Object.keys(install.targets)),
            ...(queueOf(hass)?.items ?? []).flatMap((item) => item.entities.map((e) => e.entity_id)),
        ]);
        for (const id of installing) {
            if (!ids.includes(id) && this.known.has(id) && hass.states[id] !== undefined) {
                ids.push(id);
            }
        }
        const containers = ids
            .map((id) => {
                const state = hass.states[id];
                const container = state && isWud(state) ? containerOf(state) : undefined;
                if (container) {
                    this.known.set(id, container);
                }
                return container ?? this.known.get(id);
            })
            .filter((c): c is Container => c !== undefined);
        // A container whose entity is gone altogether is forgotten.
        for (const id of this.known.keys()) {
            if (hass.states[id] === undefined) {
                this.known.delete(id);
            }
        }
        return projectsOf(containers);
    }

    private text(key: string, values: Record<string, string | number> = {}): string {
        return translate(this.language(), key).replace(/\{(\w+)\}/g, (match, name: string) =>
            name in values ? String(values[name]) : match,
        );
    }

    private language(): string {
        return this.hass?.locale?.language ?? this.hass?.language ?? browserLanguage();
    }

    static get styles(): CSSResultGroup {
        return css`
            /*
             * A column, so that with a height of its own, given in the options or by the dashboard's grid, the
             * title and the section lines keep their place and the open section scrolls in what is left.
             */
            ha-card {
                height: 100%;
                box-sizing: border-box;
                display: flex;
                flex-direction: column;
                overflow: hidden;
                container-type: inline-size;
                --wq-soft: rgba(var(--rgb-primary-color, 3, 169, 244), 0.12);
                --wq-track: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.08);
            }

            .hd {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 12px 12px 0 16px;
            }

            /* The card's one call to action, so it looks like one on any theme. */
            .action {
                flex: none;
                font: inherit;
                font-size: 12.5px;
                font-weight: 500;
                color: var(--text-primary-color, #fff);
                background: var(--primary-color);
                border: 0;
                border-radius: 16px;
                padding: 5px 12px;
                cursor: pointer;
            }

            .action:disabled {
                opacity: 0.5;
                cursor: default;
            }

            .action:focus-visible {
                outline: 2px solid var(--primary-color);
                outline-offset: 2px;
            }

            .bar {
                display: flex;
                gap: 3px;
                margin: 8px 16px 0;
            }

            /* Waiting and not run: a grey that shows on light and dark themes alike. */
            .seg {
                flex: 1 1 0;
                height: 4px;
                border-radius: 2px;
                background: color-mix(in srgb, var(--secondary-text-color) 35%, transparent);
            }

            .seg.running {
                background: var(--primary-color);
                opacity: 0.6;
            }

            .seg.done {
                background: var(--success-color, #43a047);
            }

            .seg.failed {
                background: var(--error-color, #db4437);
            }

            .hd-title {
                flex: 1 1 auto;
                min-width: 0;
                font-size: var(--ha-card-header-font-size, 18px);
                line-height: 1.4;
            }

            /* The status line reads the same in every state, in the text colour. The rows show the colours. */
            .hd-sub {
                padding: 0 16px;
                font-size: 12px;
                color: var(--primary-text-color);
            }

            .message {
                padding: 4px 16px 14px;
                font-size: 12px;
                color: var(--secondary-text-color);
            }

            .list {
                flex: 1 1 auto;
                min-height: 0;
                display: flex;
                flex-direction: column;
                padding-top: 6px;
            }

            .list > * {
                flex: none;
            }

            .list > .fold.open {
                flex: 1 1 auto;
                min-height: 0;
            }

            .scroll {
                height: 100%;
                box-sizing: border-box;
                overflow-y: auto;
                overscroll-behavior: contain;
                scrollbar-width: thin;
                padding-bottom: 4px;
            }

            .sliding .scroll {
                overflow-y: hidden;
            }

            .row {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 3px 12px 3px 16px;
                min-height: 40px;
                cursor: pointer;
            }

            .ico {
                flex: 0 0 28px;
                --mdc-icon-size: 20px;
                display: flex;
                justify-content: center;
                color: var(--secondary-text-color);
            }

            .ico.running {
                color: var(--primary-color);
                animation: spin 1.4s linear infinite;
            }

            .ico.done {
                color: var(--success-color, #43a047);
            }

            .ico.failed {
                color: var(--error-color, #db4437);
            }

            @keyframes spin {
                to {
                    transform: rotate(360deg);
                }
            }

            .info {
                flex: 1 1 auto;
                min-width: 0;
            }

            /* Names and versions wrap rather than being cut, digests and long build tags included. */
            .name,
            .sub,
            .ver {
                line-height: 1.3;
                overflow-wrap: anywhere;
            }

            .name {
                font-size: 14px;
            }

            .sub {
                font-size: 11.5px;
                color: var(--secondary-text-color);
            }

            .ver {
                font-family: var(--ha-font-family-code, ui-monospace, monospace);
                font-size: 11.5px;
            }

            .ver .new {
                color: var(--primary-color);
                font-weight: 500;
            }

            /* Never squeezed below its pill or button. A long version wraps within its half of the row instead. */
            .end {
                flex: none;
                max-width: 50%;
                text-align: right;
                display: flex;
                align-items: center;
                color: var(--secondary-text-color);
            }

            .muted {
                opacity: 0.62;
            }

            .count {
                font-size: 11px;
                color: var(--secondary-text-color);
                background: var(--wq-track);
                border-radius: 8px;
                padding: 0 6px;
                margin-left: 6px;
                vertical-align: 1px;
                white-space: nowrap;
            }

            .install {
                flex: none;
                width: 30px;
                height: 30px;
                border-radius: 50%;
                border: 0;
                padding: 0;
                background: color-mix(in srgb, var(--primary-color) 30%, transparent);
                color: var(--primary-text-color);
                display: grid;
                place-items: center;
                cursor: pointer;
                --mdc-icon-size: 17px;
            }

            .install:disabled {
                opacity: 0.35;
                cursor: default;
            }

            .install:focus-visible,
            .switch:focus-visible {
                outline: 2px solid var(--primary-color);
                outline-offset: 2px;
            }

            .pill {
                font-size: 11px;
                font-weight: 500;
                border-radius: 10px;
                padding: 1px 8px;
                white-space: nowrap;
            }

            .pill.running {
                background: var(--wq-soft);
                color: var(--primary-color);
            }

            .pill.queued,
            .pill.not_run {
                background: var(--wq-track);
                color: var(--secondary-text-color);
            }

            .pill.done {
                background: rgba(var(--rgb-success-color, 67, 160, 71), 0.12);
                color: var(--success-color, #43a047);
            }

            .pill.failed {
                background: rgba(var(--rgb-error-color, 219, 68, 55), 0.1);
                color: var(--error-color, #db4437);
            }

            .errline {
                margin: 0 12px 6px 54px;
                padding: 6px 9px;
                border-radius: 8px;
                font-size: 12px;
                color: var(--error-color, #db4437);
                background: rgba(var(--rgb-error-color, 219, 68, 55), 0.1);
            }

            /* A compose project with several rows: a small label, then its rows along a guide line. */
            .proj {
                margin-top: 2px;
            }

            .row.proj-head {
                min-height: 30px;
                cursor: default;
            }

            .proj-body {
                margin-left: 29px;
                border-left: 2px solid var(--divider-color, rgba(0, 0, 0, 0.12));
            }

            .proj-body .row {
                padding-left: 10px;
            }

            .proj-body .errline {
                margin-left: 48px;
            }

            .row.sib,
            .current .row,
            .current .row.proj-head {
                min-height: 26px;
                padding-top: 1px;
                padding-bottom: 1px;
            }

            /* A thin row that can't fit its name and version side by side puts the version under the name. */
            .row.sib,
            .current .row:not(.proj-head) {
                flex-wrap: wrap;
                row-gap: 0;
            }

            .row.sib .info,
            .current .row .info {
                flex: 1 0 auto;
                max-width: 100%;
            }

            .row.sib .end,
            .current .row .end {
                margin-left: auto;
                max-width: 100%;
            }

            .row.sib .ico,
            .current .ico {
                --mdc-icon-size: 16px;
            }

            .row.sib .name,
            .current .name {
                font-size: 13px;
            }

            .fold {
                display: grid;
                grid-template-rows: 0fr;
                transition: grid-template-rows 0.2s ease;
            }

            .fold.open {
                grid-template-rows: 1fr;
            }

            .fold-in {
                min-height: 0;
                overflow: hidden;
            }

            .switch {
                box-sizing: border-box;
                width: 100%;
                font: inherit;
                font-size: 12.5px;
                color: var(--secondary-text-color);
                background: none;
                border: 0;
                border-top: 1px solid var(--divider-color, rgba(0, 0, 0, 0.12));
                padding: 9px 16px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 8px;
                text-align: left;
            }

            /* A narrow card gives the rows the room its indents would take. */
            @container (max-width: 300px) {
                .hd,
                .row {
                    padding-left: 10px;
                    gap: 8px;
                }

                .hd-sub,
                .message,
                .switch {
                    padding-left: 10px;
                    padding-right: 10px;
                }

                .proj-body {
                    margin-left: 22px;
                }

                .proj-body .row {
                    padding-left: 6px;
                }

                .errline,
                .proj-body .errline {
                    margin-left: 10px;
                }
            }

            button.switch {
                cursor: pointer;
            }

            /* A wide card has room for a waiting row's versions beside its name, next to the button. */
            @container (min-width: 600px) {
                .row:not(.sib, .proj-head) .info {
                    display: flex;
                    align-items: baseline;
                    justify-content: space-between;
                    gap: 16px;
                }

                .row:not(.sib, .proj-head) .sub {
                    text-align: right;
                }

                /* Up-to-date siblings line their version up with the waiting rows', left of the buttons. */
                .row.sib .end {
                    margin-right: 40px;
                }
            }

            @media (prefers-reduced-motion: reduce) {
                .ico.running {
                    animation: none;
                }

                .fold {
                    transition: none;
                }
            }
        `;
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "wud-queue-card": WudQueueCard;
    }
}
