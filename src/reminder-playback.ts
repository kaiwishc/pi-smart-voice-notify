import type { NotificationType } from "./types.js";

export interface ReminderPlaybackCheckpoint {
	reminderKey: string;
	version: number;
	generation: number;
}

export interface ReminderPlaybackHandle extends ReminderPlaybackCheckpoint {
	type: NotificationType;
	followUpCount: number;
	signal: AbortSignal;
}

interface ActiveReminderPlayback extends ReminderPlaybackHandle {
	controller: AbortController;
	startedAt: number;
}

function isFiniteTimestamp(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function normalizeReminderKey(reminderKey: string): string {
	if (typeof reminderKey !== "string") {
		throw new Error("ReminderPlaybackController: reminderKey must be a string");
	}

	const normalized = reminderKey.trim();
	if (normalized.length === 0) {
		throw new Error("ReminderPlaybackController: reminderKey must not be empty");
	}

	return normalized;
}

export class ReminderPlaybackController {
	private generation = 0;
	private active: ActiveReminderPlayback | null = null;
	private readonly versionByKey = new Map<string, number>();

	public captureCheckpoint(reminderKey: string): ReminderPlaybackCheckpoint {
		const normalizedReminderKey = normalizeReminderKey(reminderKey);
		return {
			reminderKey: normalizedReminderKey,
			version: this.versionByKey.get(normalizedReminderKey) ?? 0,
			generation: this.generation,
		};
	}

	public isCurrent(checkpoint: ReminderPlaybackCheckpoint, scheduledAt: number, lastUserActivityAt: number): boolean {
		if (!Number.isInteger(checkpoint.version) || checkpoint.version < 0) {
			return false;
		}
		if (!Number.isInteger(checkpoint.generation) || checkpoint.generation < 0) {
			return false;
		}
		if (!isFiniteTimestamp(scheduledAt) || !isFiniteTimestamp(lastUserActivityAt)) {
			return false;
		}

		let normalizedReminderKey: string;
		try {
			normalizedReminderKey = normalizeReminderKey(checkpoint.reminderKey);
		} catch {
			return false;
		}
		return (
			checkpoint.generation === this.generation &&
			checkpoint.version === (this.versionByKey.get(normalizedReminderKey) ?? 0) &&
			lastUserActivityAt <= scheduledAt
		);
	}

	public start(
		checkpoint: ReminderPlaybackCheckpoint,
		type: NotificationType,
		followUpCount: number,
	): ReminderPlaybackHandle {
		const normalizedReminderKey = normalizeReminderKey(checkpoint.reminderKey);
		if (this.active) {
			this.active.controller.abort();
		}

		const controller = new AbortController();
		const next: ActiveReminderPlayback = {
			reminderKey: normalizedReminderKey,
			version: checkpoint.version,
			generation: checkpoint.generation,
			type,
			followUpCount,
			signal: controller.signal,
			controller,
			startedAt: Date.now(),
		};
		this.active = next;
		return {
			reminderKey: next.reminderKey,
			type: next.type,
			followUpCount: next.followUpCount,
			version: next.version,
			generation: next.generation,
			signal: next.signal,
		};
	}

	public finish(handle: ReminderPlaybackHandle): void {
		if (!this.active) {
			return;
		}
		if (this.active.signal !== handle.signal) {
			return;
		}
		this.active = null;
	}

	public cancel(reminderKey: string): { cancelledActivePlayback: boolean; nextVersion: number } {
		const normalizedReminderKey = normalizeReminderKey(reminderKey);
		const current = this.active?.reminderKey === normalizedReminderKey ? this.active : null;
		if (current) {
			this.active = null;
		}

		const nextVersion = (this.versionByKey.get(normalizedReminderKey) ?? 0) + 1;
		this.versionByKey.set(normalizedReminderKey, nextVersion);
		if (current) {
			current.controller.abort();
		}
		return {
			cancelledActivePlayback: current !== null,
			nextVersion,
		};
	}

	public cancelAll(): { cancelledActivePlayback: boolean; nextGeneration: number } {
		const current = this.active;
		this.active = null;
		this.generation += 1;
		this.versionByKey.clear();
		if (current) {
			current.controller.abort();
		}
		return {
			cancelledActivePlayback: current !== null,
			nextGeneration: this.generation,
		};
	}
}
