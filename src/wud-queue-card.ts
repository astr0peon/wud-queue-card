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
import { containerOf, follow, projectsOf, selectedEntities, servicesDone } from "./containers";
import type { Followed, Install } from "./containers";
import "./editor";
import type { HomeAssistant } from "./hass";
import { browserLanguage, translate } from "./localize/localize";
import type { Container, Project, Unit, WudQueueCardConfig } from "./types";

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
    /** How each remembered install is going, worked out once per update. */
    private followed = new Map<string, Followed>();

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
        // Redraw when a WUD update entity has changed, or one has come or gone.
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
        const units = new Map(this.projects().flatMap((p) => p.units.map((u) => [u.key, u] as const)));
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
        const projects = this.projects();
        const title = this.config.title ?? this.text("common.title");
        if (projects.length === 0) {
            return html`<ha-card>
                <div class="hd"><div class="hd-title">${title}</div></div>
                <div class="message">${this.text("common.no_entities")}</div>
            </ha-card>`;
        }

        const followed = this.followed;
        const active = (unit: Unit) => unit.pending || unit.installing || followed.has(unit.key);
        const pendingProjects = projects.filter((p) => p.units.some(active));
        const currentProjects = projects.filter((p) => !p.units.some(active));
        const pendingUnits = pendingProjects.flatMap((p) => p.units).filter(active);
        const currentCount = currentProjects.reduce((n, p) => n + p.units.length, 0);
        // With updates waiting, one of the two sections is always open. Without, the up-to-date one opens and shuts.
        const open: Section | "none" = this.open === "current" ? "current" : pendingUnits.length > 0 ? "pending" : "none";
        const busy = pendingUnits.some((u) => u.installing || followed.get(u.key)?.status === "running");
        const height = this.config.height ? `height:${this.config.height}px` : "";

        return html`
            <ha-card style=${height}>
                <div class="hd"><div class="hd-title">${title}</div></div>
                ${this.statusLine(pendingUnits, followed)}
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
    private statusLine(units: Unit[], followed: Map<string, Followed>): TemplateResult {
        const running = units.filter((u) => u.installing || followed.get(u.key)?.status === "running");
        if (running.length > 0) {
            const names = running.map((u) => u.name).join(", ");
            return html`<div class="hd-sub running">${this.text("common.updating", { name: names })}</div>`;
        }
        const failed = units.filter((u) => followed.get(u.key)?.status === "failed");
        if (failed.length > 0) {
            const names = failed.map((u) => u.name).join(", ");
            return html`<div class="hd-sub failed">${this.text("common.failed", { name: names })}</div>`;
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
            const unit = project.units[0];
            return html`<div class="row muted" role="button" tabindex="0" @click=${() => this.moreInfo(unit)} @keydown=${this.onKey(unit)}>
                <ha-icon class="ico" icon="mdi:docker"></ha-icon>
                <div class="info"><div class="name">${unit.name}${this.serviceCount(unit)}</div></div>
                <div class="end"><span class="ver">${unit.containers[0].installed}</span></div>
            </div>`;
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
                        status === "pending" || status === "failed"
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

    /** An up-to-date row in a project's group: a thin line with its version. */
    private siblingRow(unit: Unit): TemplateResult {
        return html`<div class="row sib muted" role="button" tabindex="0" @click=${() => this.moreInfo(unit)} @keydown=${this.onKey(unit)}>
            <ha-icon class="ico" icon="mdi:docker"></ha-icon>
            <div class="info"><div class="name">${unit.name}${this.serviceCount(unit)}</div></div>
            <div class="end"><span class="ver">${unit.containers[0].installed}</span></div>
        </div>`;
    }

    private statusIcon(status: string): TemplateResult {
        const icons: Record<string, string> = {
            pending: "mdi:docker",
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
            @click=${() => (this.open = target)}
        >
            <span>${label} ${pill}</span>
            <span>${this.text(target === "none" ? "common.hide" : "common.show")}</span>
        </button>`;
    }

    /** Content that slides open and shut. A shut one stays in the page, so the change can be animated. */
    private fold(isOpen: boolean, content: TemplateResult): TemplateResult {
        return html`<div class="fold ${isOpen ? "open" : ""}" ?inert=${!isOpen}><div class="fold-in">${content}</div></div>`;
    }

    /** On the closed row of waiting updates: whether something is installing or has failed. */
    private sectionPill(units: Unit[], followed: Map<string, Followed>): TemplateResult | typeof nothing {
        if (units.some((u) => u.installing || followed.get(u.key)?.status === "running")) {
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
        const targets = Object.fromEntries(unit.containers.map((c) => [c.entity_id, c.pending ? c.latest : c.installed]));
        const installs = new Map(this.installs);
        const from = Object.fromEntries(unit.containers.map((c) => [c.entity_id, c.installed]));
        const install: Install = { at: Date.now(), from, targets, started: false };
        installs.set(unit.key, install);
        this.installs = installs;
        this.now = Date.now();
        // Services of one compose project can all be sent at once. WUD installs them one after another.
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
        const containers = selectedEntities(hass, this.config)
            .map((id) => containerOf(hass.states[id]!))
            .filter((c): c is Container => c !== undefined);
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

            .hd-title {
                flex: 1 1 auto;
                min-width: 0;
                font-size: var(--ha-card-header-font-size, 18px);
                line-height: 1.4;
            }

            .hd-sub,
            .message {
                padding: 0 16px;
                font-size: 12px;
                color: var(--secondary-text-color);
            }

            .message {
                padding: 4px 16px 14px;
            }

            .hd-sub.running {
                color: var(--primary-color);
            }

            .hd-sub.failed {
                color: var(--error-color, #db4437);
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

            .end {
                flex: 0 1 auto;
                min-width: 0;
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
                background: var(--wq-soft);
                color: var(--primary-color);
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
