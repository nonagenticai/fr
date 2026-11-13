// Toast Notification Store
// Simple reactive toast notification system using Svelte 5 runes

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
	id: string;
	message: string;
	type: ToastType;
	duration?: number;
}

class ToastStore {
	private toasts = $state<Toast[]>([]);
	private nextId = 1;

	get items() {
		return this.toasts;
	}

	/**
	 * Show a toast notification
	 */
	show(message: string, type: ToastType = 'info', duration: number = 5000) {
		const id = `toast-${this.nextId++}`;
		const toast: Toast = { id, message, type, duration };

		this.toasts = [...this.toasts, toast];

		// Auto-dismiss after duration
		if (duration > 0) {
			setTimeout(() => {
				this.dismiss(id);
			}, duration);
		}

		return id;
	}

	/**
	 * Dismiss a toast by ID
	 */
	dismiss(id: string) {
		this.toasts = this.toasts.filter(t => t.id !== id);
	}

	/**
	 * Clear all toasts
	 */
	clear() {
		this.toasts = [];
	}

	/**
	 * Convenience methods
	 */
	success(message: string, duration?: number) {
		return this.show(message, 'success', duration);
	}

	error(message: string, duration?: number) {
		return this.show(message, 'error', duration);
	}

	warning(message: string, duration?: number) {
		return this.show(message, 'warning', duration);
	}

	info(message: string, duration?: number) {
		return this.show(message, 'info', duration);
	}
}

export const toast = new ToastStore();
