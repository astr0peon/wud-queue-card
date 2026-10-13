/**
 * The card's visual editor: the title, which updates are shown (a WUD device, a list of update entities,
 * or every WUD update), the ones left out, and the card's height.
 */
import { LitElement, html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { wudEntities } from "./containers";
import type { HomeAssistant } from "./hass";
import { browserLanguage, translate } from "./localize/localize";
import type { WudQueueCardConfig } from "./types";

interface SchemaEntry {
    name: string;
}

function schema(hass: HomeAssistant) {
    const entities = wudEntities(hass);
    return [
        { name: "title", selector: { text: {} } },
        // WUD reaches Home Assistant over MQTT; its devices are the ones that own WUD's update entities.
        {
            name: "device",
            selector: { device: { filter: { integration: "mqtt" }, entity: { domain: "update" } } },
        },
        { name: "entities", selector: { entity: { multiple: true, include_entities: entities } } },
        { name: "exclude", selector: { entity: { multiple: true, include_entities: entities } } },
        {
            name: "height",
            selector: { number: { min: 100, max: 1200, step: 10, unit_of_measurement: "px", mode: "box" } },
        },
    ];
}

@customElement("wud-queue-card-editor")
export class WudQueueCardEditor extends LitElement {
    @property({ attribute: false }) public hass?: HomeAssistant;
    @state() private config: WudQueueCardConfig = { type: "custom:wud-queue-card" };

    public setConfig(config: WudQueueCardConfig): void {
        this.config = { ...config };
    }

    protected render(): TemplateResult | typeof nothing {
        if (!this.hass) {
            return nothing;
        }
        return html`
            <ha-form
                .hass=${this.hass}
                .data=${this.config}
                .schema=${schema(this.hass)}
                .computeLabel=${(entry: SchemaEntry) => this.text(`editor.${entry.name}`)}
                .computeHelper=${(entry: SchemaEntry) => this.helper(entry.name)}
                @value-changed=${this.valueChanged}
            ></ha-form>
        `;
    }

    private valueChanged(event: CustomEvent<{ value: WudQueueCardConfig }>): void {
        const config: WudQueueCardConfig = { ...event.detail.value };
        // Whatever is emptied is left out, so the configuration stays short.
        for (const key of ["title", "device", "entities", "exclude", "height"] as const) {
            const value = config[key];
            if (value === undefined || value === null || String(value) === "" || (Array.isArray(value) && value.length === 0)) {
                delete config[key];
            }
        }
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
    }

    private text(key: string): string {
        return translate(this.language(), key);
    }

    private helper(name: string): string | undefined {
        const key = `editor.${name}_helper`;
        const helper = translate(this.language(), key);
        return helper === key ? undefined : helper;
    }

    private language(): string {
        return this.hass?.locale?.language ?? this.hass?.language ?? browserLanguage();
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "wud-queue-card-editor": WudQueueCardEditor;
    }
}
