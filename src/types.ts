import type { LovelaceCardConfig } from "./hass";

export interface WudQueueCardConfig extends LovelaceCardConfig {
    /** Shown at the top of the card. Without one the card is titled in the viewer's language. */
    title?: string;
    /** Every WUD update entity of this device. Without `device` or `entities`, every WUD update entity there is. */
    device?: string;
    /** The update entities to show, instead of finding them. */
    entities?: string[];
    /** Update entities left out, in either mode. */
    exclude?: string[];
    /** The card's height in pixels. The open section scrolls in what the title and section lines leave. */
    height?: number;
}

/** A container as the card shows it, read from WUD's update entity. */
export interface Container {
    entity_id: string;
    /** The WUD watcher, one per Docker host. */
    watcher: string;
    /** The compose project, or empty for a container started without compose. */
    stack: string;
    /** The compose service, or the container's name without compose. */
    name: string;
    /** The image without its tag, such as `library/node`. */
    image: string;
    installed: string;
    latest: string;
    pending: boolean;
    installing: boolean;
}

/**
 * What one row of the card stands for: a container, or several services of one compose project that
 * run the same image. Those are installed together, so their lines in the compose file stay in step.
 */
export interface Unit {
    key: string;
    name: string;
    containers: Container[];
    pending: boolean;
    installing: boolean;
    /** WUD's own container, which always goes last. */
    wud: boolean;
}

/** The units of one compose project. A container without compose is a project of its own. */
export interface Project {
    key: string;
    name: string;
    units: Unit[];
}

export type RowStatus = "pending" | "running" | "done" | "failed";
