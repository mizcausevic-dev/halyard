export const previewMode = import.meta.env.MODE === "preview";

export type ApiResult<T> = { status: number; body: T };

export async function api<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  if (previewMode) {
    const { previewApi } = await import("./preview.js");
    return previewApi<T>(path, init);
  }
  const response = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-halyard-client": "1",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  const body = (text ? JSON.parse(text) : {}) as T;
  return { status: response.status, body };
}

export function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: { message?: string } }).error;
    if (error?.message) return error.message;
  }
  return fallback;
}
