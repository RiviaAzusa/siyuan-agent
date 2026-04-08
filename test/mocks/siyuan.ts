export function fetchPost(_url: string, _data: any, callback: (resp: any) => void): void {
	callback({ code: 0, data: {} });
}

export function openTab(): void {
	// no-op for tests
}

export function showMessage(): void {
	// no-op for tests
}
