import { isRecord } from "@oh-my-pi/pi-utils";

/** Lifecycle states stored for todo items. */
export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

/** A persisted unit of work in a todo phase. */
export interface TodoItem {
	content: string;
	status: TodoStatus;
	/** When `status === "blocked"`, an optional note on what the task is waiting for. */
	blocker?: string;
}

/** A named group of persisted todo items. */
export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

/** Whether an unknown value is a persisted todo phase. */
export function isTodoPhase(value: unknown): value is TodoPhase {
	if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.tasks)) return false;
	return value.tasks.every(
		task =>
			isRecord(task) &&
			typeof task.content === "string" &&
			(task.status === "pending" ||
				task.status === "in_progress" ||
				task.status === "completed" ||
				task.status === "abandoned" ||
				task.status === "blocked"),
	);
}
